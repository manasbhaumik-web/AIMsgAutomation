import { sseData } from './sse';
import { EmbedRequest, EmbedResponse, LlmAdapter, LlmChunk, LlmError, LlmRequest, LlmResponse, ProviderConn, ProviderKind } from '../types';

type FetchFn = typeof fetch;

const BASES: Record<string, string> = { openai: 'https://api.openai.com/v1', xai: 'https://api.x.ai/v1' };

/**
 * Adapter for OpenAI and for xAI (Grok), which exposes the same chat-completions and embeddings wire format.
 * `kind` selects the default base URL and the token-limit parameter name.
 */
export class OpenAiCompatibleAdapter implements LlmAdapter {
  constructor(readonly kind: Extract<ProviderKind, 'openai' | 'xai'>, private readonly fetchFn: FetchFn = fetch) {}

  private async post(conn: ProviderConn, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(`${(conn.baseUrl || BASES[this.kind]).replace(/\/$/, '')}${path}`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new LlmError(`${this.kind} request failed with status ${res.status}`, res.status);
      return res;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(ctl.signal.aborted ? `${this.kind} request timed out` : `${this.kind} request failed`, ctl.signal.aborted ? 408 : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private chatBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
    return {
      model: req.model,
      messages,
      temperature: req.temperature,
      // OpenAI's current models take max_completion_tokens; xAI still documents max_tokens.
      [this.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  async complete(conn: ProviderConn, req: LlmRequest): Promise<LlmResponse> {
    const res = await this.post(conn, '/chat/completions', this.chatBody(req, false), req.timeoutMs);
    const j = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: j.choices?.[0]?.message?.content ?? '', tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
  }

  async *stream(conn: ProviderConn, req: LlmRequest): AsyncIterable<LlmChunk> {
    const res = await this.post(conn, '/chat/completions', this.chatBody(req, true), req.timeoutMs);
    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } | null };
        const text = j.choices?.[0]?.delta?.content;
        if (text) yield { text };
        if (j.usage) yield { usage: { tokensIn: j.usage.prompt_tokens, tokensOut: j.usage.completion_tokens } };
      } catch {
        /* ignore keep-alives and partial frames */
      }
    }
  }

  async embed(conn: ProviderConn, req: EmbedRequest): Promise<EmbedResponse> {
    // `dimensions` is honored by text-embedding-3-* (the recommended models) and shortens the vector server-side.
    const res = await this.post(conn, '/embeddings', { model: req.model, input: req.texts, dimensions: req.dimensions }, req.timeoutMs);
    const j = (await res.json()) as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
    const vectors = [...(j.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== req.texts.length) throw new LlmError('Embedding count mismatch', 502);
    return { vectors, tokensIn: j.usage?.prompt_tokens ?? 0 };
  }
}
