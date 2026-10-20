import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { OpenAiCompatibleAdapter } from './adapters/openai.adapter';
import { LlmGateway } from './gateway.service';
import { GatewayStore, RouteConfig, UsageRecord } from './gateway.store';
import { Redactor, StreamRestorer } from './redact';
import { AdapterRegistry } from './registry';
import { EMBED_DIM, GatewayError, LlmAdapter, LlmChunk, LlmError, LlmRequest } from './types';

const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const req: LlmRequest = { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], temperature: 0.1, maxTokens: 50, timeoutMs: 1000 };
const collect = async (it: AsyncIterable<LlmChunk>) => {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

describe('OpenAI-compatible adapter', () => {
  it('sends system + messages and the right token parameter per vendor', async () => {
    const f = jest.fn(async () => json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const openai = new OpenAiCompatibleAdapter('openai', f as unknown as typeof fetch);
    expect(await openai.complete({ kind: 'openai', apiKey: 'k' }, req)).toEqual({ text: 'ok', tokensIn: 3, tokensOut: 1 });
    let [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    let body = JSON.parse(init.body as string);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.max_completion_tokens).toBe(50);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');

    const xai = new OpenAiCompatibleAdapter('xai', f as unknown as typeof fetch);
    await xai.complete({ kind: 'xai', apiKey: 'k' }, req);
    [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    body = JSON.parse(init.body as string);
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(body.max_tokens).toBe(50);
  });

  it('streams text deltas and the final usage frame, stopping at [DONE]', async () => {
    const f = async () => sse({ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }, '[DONE]');
    const chunks = await collect(new OpenAiCompatibleAdapter('openai', f as unknown as typeof fetch).stream({ kind: 'openai', apiKey: 'k' }, req));
    expect(chunks.filter((c) => c.text).map((c) => c.text).join('')).toBe('Hello');
    expect(chunks.find((c) => c.usage)?.usage).toEqual({ tokensIn: 9, tokensOut: 2 });
  });

  it('embeds with the requested dimensions and restores input order', async () => {
    const f = jest.fn(async () => json({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { prompt_tokens: 7 } }));
    const r = await new OpenAiCompatibleAdapter('openai', f as unknown as typeof fetch).embed({ kind: 'openai', apiKey: 'k' }, { model: 'text-embedding-3-small', texts: ['a', 'b'], dimensions: 1536, timeoutMs: 1000 });
    expect(r.vectors).toEqual([[1], [2]]);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ dimensions: 1536, input: ['a', 'b'] });
  });

  it('maps errors without leaking bodies', async () => {
    const f = async () => new Response('sk-secret echoed', { status: 401 });
    const err = await new OpenAiCompatibleAdapter('openai', f as unknown as typeof fetch).complete({ kind: 'openai', apiKey: 'k' }, req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('sk-secret');
  });
});

describe('Gemini adapter', () => {
  it('maps roles, system instruction and usage; key goes in a header, not the URL', async () => {
    const f = jest.fn(async () => json({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }));
    const r = await new GeminiAdapter(f as unknown as typeof fetch).complete({ kind: 'google', apiKey: 'AIza-key' }, { ...req, model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
    expect(r).toEqual({ text: 'ab', tokensIn: 4, tokensOut: 2 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(url).not.toContain('AIza-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-key');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model']);
  });

  it('streams via SSE and embeds in a batch with outputDimensionality', async () => {
    const stream = new GeminiAdapter((async () => sse({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }, { candidates: [{ content: { parts: [{ text: '!' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })) as unknown as typeof fetch);
    const chunks = await collect(stream.stream({ kind: 'google', apiKey: 'k' }, req));
    expect(chunks.filter((c) => c.text).map((c) => c.text).join('')).toBe('Hi!');

    const f = jest.fn(async () => json({ embeddings: [{ values: [0.1] }, { values: [0.2] }] }));
    const e = await new GeminiAdapter(f as unknown as typeof fetch).embed({ kind: 'google', apiKey: 'k' }, { model: 'gemini-embedding-001', texts: ['x', 'y'], dimensions: 1536, timeoutMs: 1000 });
    expect(e.vectors).toHaveLength(2);
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.requests[0]).toMatchObject({ model: 'models/gemini-embedding-001', outputDimensionality: 1536 });
  });
});

describe('Anthropic streaming', () => {
  it('yields text and usage from message_start / message_delta', async () => {
    const f = async () => sse({ type: 'message_start', message: { usage: { input_tokens: 11 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hey' } }, { type: 'message_delta', usage: { output_tokens: 3 } });
    const chunks = await collect(new AnthropicAdapter(f as unknown as typeof fetch).stream({ kind: 'anthropic', apiKey: 'k' }, req));
    expect(chunks.find((c) => c.text)?.text).toBe('Hey');
    expect(chunks.filter((c) => c.usage).map((c) => c.usage)).toEqual([{ tokensIn: 11 }, { tokensOut: 3 }]);
  });
});

describe('registry', () => {
  it('offers the four vendors and knows which can embed', () => {
    const r = new AdapterRegistry();
    expect(r.supported().sort()).toEqual(['anthropic', 'google', 'openai', 'xai']);
    expect(r.supportsEmbed('anthropic')).toBe(false);
    expect(r.supportsEmbed('openai')).toBe(true);
    expect(r.supportsEmbed('google')).toBe(true);
  });
});

describe('redaction details', () => {
  it('keeps dates and times intact', () => {
    const t = '[M1] 2026-10-19 14:02 UTC · from sam · due 2026-11-03 · invoice 4821';
    expect(new Redactor().redact(t)).toBe(t);
  });
  it('masks international, grouped and long numbers', () => {
    const r = new Redactor();
    const out = r.redact('Call +60 12-345 6789 or 012-345 6789, acct 123456789012');
    expect(out).not.toMatch(/345 6789|123456789012/);
    expect(out.match(/\[NUMBER_\d\]/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it('restores placeholders split across stream chunks and passes citation markers through', () => {
    const r = new Redactor();
    r.redact('mail bob@corp.com');
    const s = new StreamRestorer(r);
    const out = ['Ask [EM', 'AIL_1] about it [M', '2].'].map((c) => s.push(c)).join('') + s.flush();
    expect(out).toBe('Ask bob@corp.com about it [M2].');
  });
  it('flushes an unterminated fragment at the end', () => {
    const s = new StreamRestorer(new Redactor());
    expect(s.push('see [EMA') + s.flush()).toBe('see [EMA');
  });
});

class Store extends GatewayStore {
  usage: UsageRecord[] = [];
  constructor(private route: RouteConfig | null) { super(); }
  async getRoute() { return this.route; }
  async getActivePrompt() { return { system: 'S', body: 'Q: {{q}}', version: 2 }; }
  async tokensUsedToday() { return 0; }
  async dailyTokenLimit() { return null; }
  async recordUsage(_c: unknown, u: UsageRecord) { this.usage.push(u); }
}
const route = (kind: 'openai' | 'anthropic', fallback = false): RouteConfig => ({
  task: 'chat', primary: { conn: { kind, apiKey: 'k' }, model: 'm1' },
  fallback: fallback ? { conn: { kind: 'xai', apiKey: 'k2' }, model: 'm2' } : undefined,
  temperature: 0, maxTokens: 10, timeoutMs: 1000, retries: 0, priceInPerMtok: null, priceOutPerMtok: null,
});
const reg = (adapters: Partial<LlmAdapter>[]) => {
  const r = new AdapterRegistry();
  for (const a of adapters) r.register({ stream: async function* () { /* none */ }, complete: async () => ({ text: '', tokensIn: 0, tokensOut: 0 }), ...a } as LlmAdapter);
  return r;
};

describe('LlmGateway embeddings', () => {
  const vec = () => new Array(EMBED_DIM).fill(0.5);

  it('embeds in batches, redacts input, records usage', async () => {
    const seen: string[][] = [];
    const store = new Store(route('openai'));
    const gw = new LlmGateway(store, reg([{ kind: 'openai', embed: async (_c, r) => { seen.push(r.texts); return { vectors: r.texts.map(vec), tokensIn: r.texts.length }; } }]));
    const res = await gw.embed({ userId: 'u' }, Array.from({ length: 130 }, (_, i) => `msg ${i} from bob@corp.com`));
    expect(res.vectors).toHaveLength(130);
    expect(seen.map((b) => b.length)).toEqual([64, 64, 2]);
    expect(seen[0][0]).not.toContain('bob@corp.com');
    expect(store.usage).toHaveLength(3);
    expect(store.usage.every((u) => u.task === 'embed' && u.ok)).toBe(true);
  });

  it('rejects wrong-width vectors with an actionable error', async () => {
    const gw = new LlmGateway(new Store(route('openai')), reg([{ kind: 'openai', embed: async (_c, r) => ({ vectors: r.texts.map(() => [1, 2, 3]), tokensIn: 1 }) }]));
    await expect(gw.embed({ userId: 'u' }, ['a'])).rejects.toMatchObject({ code: 'dimension_mismatch' });
  });

  it('refuses providers without embeddings and never falls back across models', async () => {
    const gw = new LlmGateway(new Store(route('anthropic', true)), reg([]));
    await expect(gw.embed({ userId: 'u' }, ['a'])).rejects.toMatchObject({ code: 'embed_unsupported' });
    const failing = new LlmGateway(new Store(route('openai', true)), reg([{ kind: 'openai', embed: async () => { throw new LlmError('down', 503); } }, { kind: 'xai', embed: async (_c, r) => ({ vectors: r.texts.map(vec), tokensIn: 1 }) }]));
    await expect(failing.embed({ userId: 'u' }, ['a'])).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('LlmGateway streaming', () => {
  async function drain(gw: LlmGateway, vars: Record<string, string>) {
    const events = [];
    for await (const e of gw.stream({ userId: 'u' }, 'chat', vars)) events.push(e);
    return events;
  }

  it('restores redacted values across chunks and reports usage', async () => {
    const store = new Store(route('anthropic'));
    let prompt = '';
    const gw = new LlmGateway(store, reg([{ kind: 'anthropic', stream: async function* (_c, r) { prompt = r.messages[0].content; yield { text: 'Write to [EM' }; yield { text: 'AIL_1] [M1]' }; yield { usage: { tokensIn: 20, tokensOut: 6 } }; } }]));
    const events = await drain(gw, { q: 'what did bob@corp.com say' });
    expect(prompt).not.toContain('bob@corp.com');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Write to bob@corp.com [M1]');
    expect(store.usage).toMatchObject([{ tokensIn: 20, tokensOut: 6, ok: true }]);
  });

  it('falls back only if the first provider fails before producing text', async () => {
    const early = new LlmGateway(new Store(route('openai', true)), reg([{ kind: 'openai', stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new LlmError('down', 503); } }) }) }, { kind: 'xai', stream: async function* () { yield { text: 'fallback answer' }; } }]));
    const events = await drain(early, { q: 'x' });
    expect(events.map((e) => e.type)).toEqual(['text', 'end']);
    expect(events[1]).toMatchObject({ meta: { usedFallback: true } });

    const late = new LlmGateway(new Store(route('openai', true)), reg([{ kind: 'openai', stream: async function* () { yield { text: 'partial' }; throw new LlmError('cut', 503); } }, { kind: 'xai', stream: async function* () { yield { text: 'should not run' }; } }]));
    await expect(drain(late, { q: 'x' })).rejects.toBeInstanceOf(LlmError);
  });
});
