import { DEMO_WRITE_SCOPE, DemoCalendarConnector, DemoMailConnector } from './demo.connector';
import { GoogleCalendarConnector } from './gcal.connector';
import { MicrosoftCalendarConnector } from './mscal.connector';
import { OAuthClient } from './oauth';
import { ConnectorAccount, FetchFn, ProviderAuthError, ProviderError } from './types';

interface Call {
  method: string;
  url: string;
  body: Record<string, any> | null;
  auth: string | null;
}

/** Records every request and answers with the next queued response. */
function recorder(...replies: (Response | Record<string, unknown>)[]): FetchFn & { calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const next = queue.shift() ?? {};
    return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}
const empty = (status: number) => new Response(status === 204 ? null : '{}', { status });

const oauth = new OAuthClient({ authUrl: 'https://idp.test/auth', tokenUrl: 'https://idp.test/token', clientId: 'cid', clientSecret: 'sec' });
const acct = (channel: ConnectorAccount['channel']): ConnectorAccount => ({ id: 'a1', channel, externalId: 'me@x.com', tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 }, backfillDays: 14 });
const start = new Date('2026-11-02T10:00:00Z');
const end = new Date('2026-11-02T10:30:00Z');

describe('Google Calendar writes', () => {
  it('creates an event with attendees, notifying them, and returns the new id', async () => {
    const f = recorder({ id: 'g1', summary: 'Planning', status: 'confirmed', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } });
    const r = await new GoogleCalendarConnector(oauth, f).createEvent(acct('google_calendar'), { title: 'Planning', start, end, timezone: 'Europe/London', location: 'Room 1', attendees: ['a@b.com'] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: 'POST', auth: 'Bearer tok' });
    expect(f.calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
    expect(f.calls[0].body).toEqual({
      summary: 'Planning', location: 'Room 1',
      start: { dateTime: start.toISOString(), timeZone: 'Europe/London' }, end: { dateTime: end.toISOString(), timeZone: 'Europe/London' },
      attendees: [{ email: 'a@b.com' }],
    });
    expect(r.externalId).toBe('g1');
    expect(r.event?.title).toBe('Planning');
  });

  it('writes all-day events with dates, not times', async () => {
    const f = recorder({ id: 'g2', summary: 'Holiday', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } });
    await new GoogleCalendarConnector(oauth, f).createEvent(acct('google_calendar'), { title: 'Holiday', start: new Date('2026-11-02T00:00:00Z'), end: new Date('2026-11-03T00:00:00Z'), allDay: true });
    expect(f.calls[0].body).toMatchObject({ start: { date: '2026-11-02' }, end: { date: '2026-11-03' } });
  });

  it('a change sends only the fields that changed', async () => {
    const f = recorder({ id: 'g1', summary: 'Renamed', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } });
    await new GoogleCalendarConnector(oauth, f).updateEvent(acct('google_calendar'), 'g1', { title: 'Renamed' });
    expect(f.calls[0].method).toBe('PATCH');
    expect(f.calls[0].url).toContain('/events/g1?sendUpdates=all');
    expect(f.calls[0].body).toEqual({ summary: 'Renamed' });
  });

  it('cancels by deleting, and encodes the id in the URL', async () => {
    const f = recorder(empty(204));
    await new GoogleCalendarConnector(oauth, f).cancelEvent(acct('google_calendar'), 'a/b c');
    expect(f.calls[0]).toMatchObject({ method: 'DELETE' });
    expect(f.calls[0].url).toContain('/events/a%2Fb%20c?');
  });

  it('a rejected token asks the user to reconnect; other failures carry the status only', async () => {
    await expect(new GoogleCalendarConnector(oauth, recorder(empty(401))).createEvent(acct('google_calendar'), { title: 't', start, end })).rejects.toBeInstanceOf(ProviderAuthError);
    const err = await new GoogleCalendarConnector(oauth, recorder(empty(403))).cancelEvent(acct('google_calendar'), 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain('tok');
  });
});

describe('Microsoft Calendar writes', () => {
  const ms = (f: FetchFn) => new MicrosoftCalendarConnector(oauth, f);

  it('creates an event with UTC times and required attendees', async () => {
    const f = recorder({ id: 'm1', subject: 'Planning', start: { dateTime: '2026-11-02T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-02T10:30:00', timeZone: 'UTC' } });
    const r = await ms(f).createEvent(acct('microsoft_calendar'), { title: 'Planning', start, end, location: 'Room 1', description: 'Agenda', attendees: ['a@b.com'] });
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://graph.microsoft.com/v1.0/me/events', auth: 'Bearer tok' });
    expect(f.calls[0].body).toEqual({
      subject: 'Planning', location: { displayName: 'Room 1' }, body: { contentType: 'text', content: 'Agenda' },
      start: { dateTime: '2026-11-02T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-02T10:30:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'a@b.com' }, type: 'required' }],
    });
    expect(r.externalId).toBe('m1');
    expect(r.event?.start.toISOString()).toBe(start.toISOString());
  });

  it('a change sends only what changed', async () => {
    const f = recorder({ id: 'm1', subject: 'Moved', start: { dateTime: '2026-11-03T10:00:00' }, end: { dateTime: '2026-11-03T10:30:00' } });
    await ms(f).updateEvent(acct('microsoft_calendar'), 'm1', { start: new Date('2026-11-03T10:00:00Z'), end: new Date('2026-11-03T10:30:00Z') });
    expect(f.calls[0].method).toBe('PATCH');
    expect(Object.keys(f.calls[0].body!).sort()).toEqual(['end', 'start']);
  });

  it('cancelling uses cancel (which tells attendees) and falls back to delete for events the user only attends', async () => {
    const ok = recorder(empty(202));
    await ms(ok).cancelEvent(acct('microsoft_calendar'), 'm1');
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/events/m1/cancel');

    const fallback = recorder(empty(400), empty(204));
    await ms(fallback).cancelEvent(acct('microsoft_calendar'), 'm1');
    expect(fallback.calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('a server error while cancelling is not hidden by the fallback', async () => {
    await expect(ms(recorder(empty(500))).cancelEvent(acct('microsoft_calendar'), 'm1')).rejects.toMatchObject({ status: 500 });
  });
});

describe('demo connectors (development only)', () => {
  it('"send" hands back the outbound message so it can be stored and shown', async () => {
    const r = await new DemoMailConnector().sendReply(acct('gmail'), { threadExternalId: 't1', replyToExternalId: 'm1', to: [{ email: 'x@y.com' }], subject: 'Hi', text: 'Hello' });
    expect(r.message).toMatchObject({ threadExternalId: 't1', direction: 'outbound', bodyText: 'Hello', isRead: true });
    expect(r.externalId).toMatch(/^demo-sent-/);
  });

  it('calendar writes return the event as the app should store it', async () => {
    const c = new DemoCalendarConnector();
    const made = await c.createEvent(acct('google_calendar'), { title: 'Demo', start, end, attendees: ['a@b.com'] });
    expect(made.event).toMatchObject({ title: 'Demo', status: 'confirmed' });
    expect(made.event?.attendees[0].email).toBe('a@b.com');
    expect((await c.updateEvent(acct('google_calendar'), made.externalId, { title: 'New' })).event?.title).toBe('New');
  });

  it('its write scope is its own and never a real provider scope', () => {
    expect(DEMO_WRITE_SCOPE).toBe('demo.write');
    expect(new DemoMailConnector().writeScope).toBe(DEMO_WRITE_SCOPE);
  });
});
