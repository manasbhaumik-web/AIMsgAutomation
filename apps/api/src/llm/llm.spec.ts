import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { LlmGateway } from './gateway.service';
import { GatewayStore, RouteConfig, UsageRecord } from './gateway.store';
import { Redactor, renderTemplate } from './redact';
import { AdapterRegistry } from './registry';
import { withRetry } from './retry';
import { GatewayError, LlmAdapter, LlmError, LlmRequest } from './types';

describe('Redactor', () => {
  it('masks emails and phone numbers, and restores them', () => {
    const r = new Redactor();
    const out = r.redact('Mail ann@example.com or call +60 12-345 6789. Same: ann@example.com');
    expect(out).not.toContain('ann@example.com');
    expect(out).not.toContain('345 6789');
    expect(out.match(/\[EMAIL_1\]/g)).toHaveLength(2);
    expect(r.restore(`Reply to ${out.match(/\[EMAIL_1\]/)![0]}`)).toBe('Reply to ann@example.com');
  });

  it('leaves short numbers alone', () => {
    expect(new Redactor().redact('Invoice 2024, 3 items, due 12-05')).toBe('Invoice 2024, 3 items, due 12-05');
  });
});

describe('renderTemplate', () => {
  it('fills variables and throws on missing ones', () => {
    expect(renderTemplate('Hi {{ name }}', { name: 'Sam' })).toBe('Hi Sam');
    expect(() => renderTemplate('Hi {{who}}', {})).toThrow(/who/);
  });
});

describe('withRetry', () => {
  const sleep = async () => undefined;
  it('retries retryable errors up to the limit', async () => {
    let n = 0;
    const out = await withRetry(async () => { if (++n < 3) throw new LlmError('x', 503); return 'ok'; }, { retries: 2, isRetryable: () => true, sleep });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });
  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new LlmError('bad key', 401); }, { retries: 3, isRetryable: (e) => (e as LlmError).retryable, sleep })).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe('AnthropicAdapter', () => {
  const conn = { kind: 'anthropic' as const, apiKey: 'sk-test' };
  const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, timeoutMs: 1000 };

  it('sends the key header and parses text and usage', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 }));
    const out = await new AnthropicAdapter(fetchFn as unknown as typeof fetch).complete(conn, req);
    expect(out).toEqual({ text: 'Hello', tokensIn: 5, tokensOut: 2 });
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
  });

  it('maps HTTP errors without leaking the body', async () => {
    const fetchFn = jest.fn(async () => new Response('secret echo sk-test', { status: 429 }));
    const err = await new AnthropicAdapter(fetchFn as unknown as typeof fetch).complete(conn, req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('sk-test');
  });

  it('treats 401 as not retryable', () => {
    expect(new LlmError('x', 401).retryable).toBe(false);
  });
});

class MemStore extends GatewayStore {
  usage: UsageRecord[] = [];
  used = 0;
  limit: number | null = null;
  route: RouteConfig | null;
  constructor(route: RouteConfig | null) { super(); this.route = route; }
  async getRoute() { return this.route; }
  async getActivePrompt() { return { system: null, body: 'Summarize: {{text}}', version: 3 }; }
  async tokensUsedToday() { return this.used; }
  async dailyTokenLimit() { return this.limit; }
  async recordUsage(_c: unknown, u: UsageRecord) { this.usage.push(u); }
}

function setup(adapters: Record<string, LlmAdapter['complete']>, withFallback = false, retries = 0) {
  const route: RouteConfig = {
    task: 'summarize',
    primary: { conn: { kind: 'anthropic', apiKey: 'k1' }, model: 'big' },
    fallback: withFallback ? { conn: { kind: 'openai', apiKey: 'k2' }, model: 'alt' } : undefined,
    temperature: 0.2, maxTokens: 100, timeoutMs: 1000, retries, priceInPerMtok: 3, priceOutPerMtok: 15,
  };
  const store = new MemStore(route);
  const reg = new AdapterRegistry();
  for (const [kind, complete] of Object.entries(adapters)) reg.register({ kind: kind as 'anthropic', complete, stream: async function* () { /* unused */ } });
  return { store, gw: new LlmGateway(store, reg) };
}

describe('LlmGateway', () => {
  const ctx = { userId: 'u1', tenantId: 't1' };

  it('redacts before sending, restores after, and records cost', async () => {
    let seen = '';
    const { gw, store } = setup({ anthropic: async (_c, r) => { seen = r.messages[0].content; return { text: 'Contact [EMAIL_1]', tokensIn: 1000, tokensOut: 1000 }; } });
    const out = await gw.run(ctx, 'summarize', { text: 'write to bob@corp.com' });
    expect(seen).not.toContain('bob@corp.com');
    expect(out.text).toBe('Contact bob@corp.com');
    expect(out.promptVersion).toBe(3);
    expect(store.usage[0].cost).toBeCloseTo(0.018);
    expect(store.usage[0].ok).toBe(true);
  });

  it('refuses when AI is off for the source, before any lookup or call', async () => {
    const complete = jest.fn();
    const { gw } = setup({ anthropic: complete });
    await expect(gw.run(ctx, 'summarize', { text: 'x' }, { aiEnabled: false })).rejects.toMatchObject({ code: 'ai_disabled' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('enforces the daily token quota', async () => {
    const complete = jest.fn();
    const { gw, store } = setup({ anthropic: complete });
    store.used = 500; store.limit = 500;
    await expect(gw.run(ctx, 'summarize', { text: 'x' })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to the second route when the primary keeps failing, logging both', async () => {
    const { gw, store } = setup(
      { anthropic: async () => { throw new LlmError('down', 503); }, openai: async () => ({ text: 'from fallback', tokensIn: 1, tokensOut: 1 }) },
      true, 1,
    );
    const out = await gw.run(ctx, 'summarize', { text: 'x' });
    expect(out.usedFallback).toBe(true);
    expect(out.text).toBe('from fallback');
    expect(store.usage.map((u) => u.ok)).toEqual([false, true]);
  }, 10_000);

  it('fails with upstream_failed when every route fails', async () => {
    const { gw } = setup({ anthropic: async () => { throw new LlmError('bad key', 401); } });
    await expect(gw.run(ctx, 'summarize', { text: 'x' })).rejects.toBeInstanceOf(GatewayError);
  });

  it('reports a missing route clearly', async () => {
    const { gw, store } = setup({});
    store.route = null;
    await expect(gw.run(ctx, 'summarize', { text: 'x' })).rejects.toMatchObject({ code: 'route_not_configured' });
  });
});
