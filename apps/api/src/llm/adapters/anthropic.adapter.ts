import { sseData } from './sse';
import { LlmAdapter, LlmChunk, LlmError, LlmRequest, LlmResponse, ProviderConn } from '../types';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

type FetchFn = typeof fetch;

export class AnthropicAdapter implements LlmAdapter {
  readonly kind = 'anthropic' as const;

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  private async call(conn: ProviderConn, req: LlmRequest, stream: boolean): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    try {
      const res = await this.fetchFn(`${(conn.baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': conn.apiKey, 'anthropic-version': API_VERSION },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          system: req.system,
          messages: req.messages,
          stream,
        }),
      });
      if (!res.ok) {
        // Never echo the response body into errors that may be logged: it can contain request fragments.
        throw new LlmError(`Anthropic request failed with status ${res.status}`, res.status);
      }
      return res;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(ctl.signal.aborted ? 'Anthropic request timed out' : 'Anthropic request failed', ctl.signal.aborted ? 408 : undefined);
    } finally {
      // For streams the timeout covers connection and headers only; the body may run longer.
      clearTimeout(timer);
    }
  }

  async complete(conn: ProviderConn, req: LlmRequest): Promise<LlmResponse> {
    const res = await this.call(conn, req, false);
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return {
      text: (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      tokensIn: j.usage?.input_tokens ?? 0,
      tokensOut: j.usage?.output_tokens ?? 0,
    };
  }

  async *stream(conn: ProviderConn, req: LlmRequest): AsyncIterable<LlmChunk> {
    const res = await this.call(conn, req, true);
    for await (const data of sseData(res.body)) {
      let j: { type?: string; delta?: { type?: string; text?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number } };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) yield { text: j.delta.text };
      else if (j.type === 'message_start') yield { usage: { tokensIn: j.message?.usage?.input_tokens } };
      else if (j.type === 'message_delta') yield { usage: { tokensOut: j.usage?.output_tokens } };
      else if (j.type === 'error') throw new LlmError('Anthropic stream error', 500);
    }
  }
}
