import { sseData } from './sse';
import { EmbedRequest, EmbedResponse, LlmAdapter, LlmChunk, LlmError, LlmRequest, LlmResponse, ProviderConn } from '../types';

type FetchFn = typeof fetch;
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GenResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const textOf = (j: GenResponse) => (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');

/** Google Gemini via the Generative Language API (API-key auth). */
export class GeminiAdapter implements LlmAdapter {
  readonly kind = 'google' as const;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  private async post(conn: ProviderConn, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(`${(conn.baseUrl || DEFAULT_BASE).replace(/\/$/, '')}${path}`, {
        method: 'POST',
        signal: ctl.signal,
        // Key in a header, never in the URL, so it cannot end up in access logs.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': conn.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new LlmError(`gemini request failed with status ${res.status}`, res.status);
      return res;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(ctl.signal.aborted ? 'gemini request timed out' : 'gemini request failed', ctl.signal.aborted ? 408 : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private body(req: LlmRequest) {
    return {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens },
    };
  }

  async complete(conn: ProviderConn, req: LlmRequest): Promise<LlmResponse> {
    const res = await this.post(conn, `/models/${encodeURIComponent(req.model)}:generateContent`, this.body(req), req.timeoutMs);
    const j = (await res.json()) as GenResponse;
    return { text: textOf(j), tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: j.usageMetadata?.candidatesTokenCount ?? 0 };
  }

  async *stream(conn: ProviderConn, req: LlmRequest): AsyncIterable<LlmChunk> {
    const res = await this.post(conn, `/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, this.body(req), req.timeoutMs);
    for await (const data of sseData(res.body)) {
      try {
        const j = JSON.parse(data) as GenResponse;
        const text = textOf(j);
        if (text) yield { text };
        if (j.usageMetadata) yield { usage: { tokensIn: j.usageMetadata.promptTokenCount, tokensOut: j.usageMetadata.candidatesTokenCount } };
      } catch {
        /* ignore partial frames */
      }
    }
  }

  async embed(conn: ProviderConn, req: EmbedRequest): Promise<EmbedResponse> {
    const model = `models/${req.model.replace(/^models\//, '')}`;
    const res = await this.post(
      conn,
      `/${model}:batchEmbedContents`,
      { requests: req.texts.map((t) => ({ model, content: { parts: [{ text: t }] }, outputDimensionality: req.dimensions })) },
      req.timeoutMs,
    );
    const j = (await res.json()) as { embeddings?: { values: number[] }[] };
    const vectors = (j.embeddings ?? []).map((e) => e.values);
    if (vectors.length !== req.texts.length) throw new LlmError('Embedding count mismatch', 502);
    // The API does not report embedding token usage; a rough character-based estimate keeps the ledger meaningful.
    return { vectors, tokensIn: Math.ceil(req.texts.reduce((n, t) => n + t.length, 0) / 4) };
  }
}
