import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, InboxClient, MemoryTokenStore, type Draft } from './index.js';

type Call = { method: string; path: string; auth?: string; body?: unknown };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function server(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: (init?.headers as Record<string, string>)?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { f, calls };
}
const client = async (handler: Parameters<typeof server>[0], onSignedOut?: () => void) => {
  const s = server(handler);
  const tokens = new MemoryTokenStore();
  await tokens.set({ accessToken: 'old', refreshToken: 'r1' });
  return { c: new InboxClient({ baseUrl: 'https://api.test/api/v1', tokens, fetch: s.f, onSignedOut }), tokens, calls: s.calls };
};

test('refreshes once on 401 and retries with the new token', async () => {
  const { c, calls, tokens } = await client((x) => {
    if (x.path === '/api/v1/auth/refresh') return json({ accessToken: 'new', refreshToken: 'r2', expiresIn: 900, user: {} });
    return x.auth === 'Bearer new' ? json({ id: 'u1' }) : json({ message: 'expired' }, 401);
  });
  assert.deepEqual(await c.me(), { id: 'u1' });
  assert.equal(calls.filter((x) => x.path.endsWith('/auth/refresh')).length, 1);
  assert.deepEqual(await tokens.get(), { accessToken: 'new', refreshToken: 'r2' });
});

test('concurrent 401s share a single refresh (refresh tokens are single use)', async () => {
  const { c, calls } = await client(async (x) => {
    if (x.path.endsWith('/auth/refresh')) { await new Promise((r) => setTimeout(r, 20)); return json({ accessToken: 'new', refreshToken: 'r2', user: {} }); }
    return x.auth === 'Bearer new' ? json([]) : json({}, 401);
  });
  await Promise.all([c.accounts(), c.accounts(), c.accounts()]);
  assert.equal(calls.filter((x) => x.path.endsWith('/auth/refresh')).length, 1);
});

test('a rejected refresh clears the tokens and signs the app out', async () => {
  let out = 0;
  const { c, tokens } = await client((x) => (x.path.endsWith('/auth/refresh') ? json({ message: 'revoked' }, 401) : json({}, 401)), () => { out++; });
  await assert.rejects(c.me(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(await tokens.get(), null);
  assert.equal(out, 1);
});

test('errors carry the stable code the UI should react to', async () => {
  const { c } = await client(() => json({ statusCode: 403, code: 'ai_consent_required', message: 'Turn on AI features' }, 403));
  await assert.rejects(c.aiDraft('t1'), (e: unknown) => e instanceof ApiError && e.code === 'ai_consent_required' && e.status === 403);
});

test('sending needs the reviewed draft: it confirms that exact text by hash', async () => {
  const draft = { id: 'd1', bodyHash: 'a'.repeat(64), body: 'Hi', status: 'draft' } as unknown as Draft;
  const { c, calls } = await client(() => json({ draft: { ...draft, status: 'sent' } }));
  const sent = await c.sendDraft(draft, { acceptNewMessages: true });
  assert.equal(sent.status, 'sent');
  assert.deepEqual(calls[0].body, { confirm: true, bodyHash: 'a'.repeat(64), acceptNewMessages: true });
  assert.equal(calls[0].path, '/api/v1/drafts/d1/send');
});

test('answering an invitation always sends the confirmation flag', async () => {
  const { c, calls } = await client(() => new Response(null, { status: 204 }));
  await c.respondToEvent('e1', 'decline', 'clash');
  assert.deepEqual(calls[0].body, { confirm: true, response: 'decline', comment: 'clash' });
});

test('parses the assistant stream even when frames are split across chunks', async () => {
  const enc = new TextEncoder();
  const frames = ['event: token\ndata: {"text":"Hel', 'lo"}\n\nevent: token\ndata: {"text":" there"}\n\nevent: citations\ndata: {"citations":[]}\n\n', 'event: done\ndata: {"turnId":7}\n\n'];
  const { c } = await client(() => new Response(new ReadableStream({ start(ctl) { frames.forEach((f) => ctl.enqueue(enc.encode(f))); ctl.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const out: string[] = [];
  for await (const ev of c.chat('c1', 'hi')) out.push(ev.type === 'token' ? ev.text : ev.type);
  assert.deepEqual(out, ['Hello', ' there', 'citations', 'done']);
});

test('thread queries only send the filters that were given', async () => {
  const { c, calls } = await client(() => json({ threads: [], nextBefore: null }));
  await c.threads({ channel: 'slack', unreadOnly: true });
  assert.equal(calls[0].path, '/api/v1/inbox/threads?channel=slack&unreadOnly=true');
});

test('login stores the tokens and does not send a stale bearer header', async () => {
  const { c, calls, tokens } = await client(() => json({ accessToken: 'a2', refreshToken: 'r9', expiresIn: 900, user: { id: 'u' } }));
  await c.login('a@b.co', 'a-long-password-1');
  assert.equal(calls[0].auth, undefined);
  assert.deepEqual(await tokens.get(), { accessToken: 'a2', refreshToken: 'r9' });
});
