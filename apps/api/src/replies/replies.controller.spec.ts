import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DraftService } from '../ai/draft.service';
import { CalendarActionsController } from '../calendar/calendar-actions.controller';
import { CalendarActionsService } from '../calendar/calendar-actions.service';
import { RepliesController } from './replies.controller';
import { RepliesService } from './replies.service';

const ID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

/** Real HTTP: the request shape itself is part of the "no send without confirmation" guarantee. */
describe('confirmation gate over HTTP', () => {
  let app: INestApplication;
  let url: string;
  const calls: string[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [RepliesController, CalendarActionsController],
      providers: [
        { provide: RepliesService, useValue: { send: async () => { calls.push('send'); return { id: ID }; }, save: async () => ({ id: ID }), get: async () => ({ id: ID }) } },
        { provide: DraftService, useValue: { draftReply: async () => { calls.push('draft'); } } },
        { provide: CalendarActionsService, useValue: { respond: async () => { calls.push('respond'); }, suggestTimes: async () => [] } },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1', tenantId: 't1', role: 'user', tenantRole: 'user', sessionId: 's' }; next(); });
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());
  beforeEach(() => { calls.length = 0; });

  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses to send without confirm:true, with confirm:false, or with a malformed hash', async () => {
    for (const body of [{}, { bodyHash: HASH }, { confirm: false, bodyHash: HASH }, { confirm: 'true', bodyHash: HASH }, { confirm: true }, { confirm: true, bodyHash: 'abc' }]) {
      expect((await post(`/drafts/${ID}/send`, body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('sends only when both the confirmation and a well-formed hash are present', async () => {
    expect((await post(`/drafts/${ID}/send`, { confirm: true, bodyHash: HASH })).status).toBe(200);
    expect(calls).toEqual(['send']);
  });

  it('asking the assistant for a draft never reaches the send path', async () => {
    expect((await post(`/threads/${ID}/draft/ai`, { instructions: 'be brief' })).status).toBeGreaterThanOrEqual(200);
    expect(calls).not.toContain('send');
    expect(calls[0]).toBe('draft');
  });

  it('refuses calendar responses without confirm:true or with an unknown answer', async () => {
    for (const body of [{ response: 'accept' }, { confirm: false, response: 'accept' }, { confirm: true, response: 'yes please' }]) {
      expect((await post(`/events/${ID}/respond`, body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await post(`/events/${ID}/respond`, { confirm: true, response: 'decline' })).status).toBe(204);
    expect(calls).toEqual(['respond']);
  });

  it('validates the time-suggestion request', async () => {
    expect((await post('/calendar/suggest-times', { durationMin: 5 })).status).toBe(400);
    expect((await post('/calendar/suggest-times', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await post('/calendar/suggest-times', { dayStartHour: 17, dayEndHour: 9 })).status).toBe(400);
    expect((await post('/calendar/suggest-times', {})).status).toBe(200);
  });
});
