import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AiConsentRequired } from './consent.service';
import { ChatController } from './chat.controller';
import { ChatEvent, ChatService } from './chat.service';
import { DigestService } from './digest.service';

const CONV = '11111111-1111-4111-8111-111111111111';

describe('ChatController streaming (real HTTP)', () => {
  let app: INestApplication;
  let url: string;
  let ask: (ctx: unknown, id: string, q: string, tz: string) => AsyncGenerator<ChatEvent>;
  let closed = false;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: { ask: (...a: Parameters<typeof ask>) => ask(...a) } },
        { provide: DigestService, useValue: { schedule: async () => ({ timezone: 'Asia/Kuala_Lumpur' }) } },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'u1', tenantId: 't1', role: 'user', tenantRole: 'user', sessionId: 's' };
      next();
    });
    await app.listen(0);
    url = `${await app.getUrl()}`.replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(`${url}/chat/conversations/${CONV}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

  it('streams token, citations and done as SSE frames and passes the user timezone', async () => {
    let tzSeen = '';
    ask = async function* (_c, _id, q, tz) {
      tzSeen = tz;
      yield { type: 'token', text: `Echo: ${q}` };
      yield { type: 'citations', citations: [] };
      yield { type: 'done', turnId: 7 };
    };
    const res = await post({ content: 'hello' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const text = await res.text();
    const frames = text.trim().split('\n\n').map((f) => ({ event: f.match(/^event: (.*)$/m)![1], data: JSON.parse(f.match(/^data: (.*)$/m)![1]) }));
    expect(frames.map((f) => f.event)).toEqual(['token', 'citations', 'done']);
    expect(frames[0].data.text).toBe('Echo: hello');
    expect(frames[2].data.turnId).toBe(7);
    expect(tzSeen).toBe('Asia/Kuala_Lumpur');
  });

  it('reports a missing AI consent as a normal 403 with a stable code, not as a 200 stream', async () => {
    // A generator whose very first next() rejects, like ChatService.ask does when consent is missing.
    ask = () => ({ next: async () => { throw new AiConsentRequired(); }, return: async () => ({ done: true, value: undefined }), [Symbol.asyncIterator]() { return this; } }) as unknown as AsyncGenerator<ChatEvent>;
    const res = await post({ content: 'hello' });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).code).toBe('ai_consent_required');
  });

  it('delivers provider problems that happen as the first event as an SSE error event', async () => {
    ask = async function* () {
      yield { type: 'error', code: 'quota_exceeded', message: 'You have reached the daily AI usage limit. Try again tomorrow.' };
    };
    const res = await post({ content: 'hello' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: error');
  });

  it('turns a mid-stream crash into an error event instead of a hung or broken response', async () => {
    ask = async function* () {
      yield { type: 'token', text: 'partial' };
      throw new Error('boom');
    };
    const text = await (await post({ content: 'hello' })).text();
    expect(text).toContain('event: token');
    expect(text).toContain('event: error');
    expect(text).not.toContain('boom'); // internal messages never reach the client
  });

  it('rejects empty and oversized questions before doing any work', async () => {
    let called = false;
    ask = async function* () {
      called = true;
      yield { type: 'done', turnId: 1 };
    };
    expect((await post({ content: '   ' })).status).toBe(400);
    expect((await post({ content: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(called).toBe(false);
  });

  it('stops generating when the client disconnects', async () => {
    closed = false;
    ask = async function* () {
      try {
        yield { type: 'token', text: 'a' };
        for (let i = 0; i < 200; i++) {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: 'token', text: 'b' };
        }
      } finally {
        closed = true;
      }
    };
    const ctl = new AbortController();
    const res = await post({ content: 'hello' }, ctl.signal);
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });
});
