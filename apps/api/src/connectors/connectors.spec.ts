import { Env } from '../config/env';
import { SubscriptionService } from '../ingestion/subscription.service';
import { GoogleCalendarConnector, parseGoogleEvent } from './gcal.connector';
import { GmailConnector, GmailMessage, parseGmailMessage } from './gmail.connector';
import { GraphBase } from './graph';
import { OAuthClient } from './oauth';
import { MicrosoftCalendarConnector, parseGraphEvent } from './mscal.connector';
import { OutlookConnector, parseGraphMessage } from './outlook.connector';
import { htmlToText, parseAddressList, sanitizeMailHtml } from './text';
import { ConnectorAccount, FetchFn, ProviderAuthError, SyncResetError } from './types';

type Handler = (url: URL, init?: RequestInit) => unknown;

/** Recorded-fixture HTTP: first matching pattern answers. A Response is returned as is; anything else becomes JSON 200. */
function fakeFetch(routes: [RegExp, Handler][]): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    for (const [re, h] of routes) {
      if (re.test(url.toString())) {
        const out = h(url, init);
        return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('no fixture', { status: 599 });
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}
const status = (n: number) => new Response('{}', { status: n });
const b64 = (s: string) => Buffer.from(s).toString('base64url');

const oauth = new OAuthClient({ authUrl: 'https://idp.test/auth', tokenUrl: 'https://idp.test/token', clientId: 'cid', clientSecret: 'sec' });
const acct = (channel: ConnectorAccount['channel']): ConnectorAccount => ({ id: 'a1', channel, externalId: 'me@x.com', tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 }, backfillDays: 14 });

describe('text helpers', () => {
  it('parses address lists with quoted commas and bare addresses', () => {
    expect(parseAddressList('"Doe, Jane" <Jane@X.com>, bob@y.com, Ann <ann@z.org>')).toEqual([
      { email: 'jane@x.com', name: 'Doe, Jane' },
      { email: 'bob@y.com' },
      { email: 'ann@z.org', name: 'Ann' },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('sanitizes dangerous HTML, drops remote images, keeps inline images, hardens links', () => {
    const out = sanitizeMailHtml(
      '<p onclick="x()">Hi</p><script>alert(1)</script><img src="https://t.example/pixel.gif"><img src="data:image/png;base64,AAAA">' +
        '<a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><style>p{x:y}</style>',
    );
    expect(out).not.toMatch(/script|onclick|pixel|javascript:|style/i);
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toMatch(/<a href="https:\/\/ok\.example"[^>]*rel="noopener noreferrer nofollow"/);
  });

  it('converts HTML to readable text', () => {
    expect(htmlToText('<p>Tom &amp; Jerry</p><p>Line two<br>three</p><style>a{}</style>')).toBe('Tom & Jerry\nLine two\nthree');
  });
});

describe('OAuthClient', () => {
  it('builds a PKCE authorization URL', () => {
    const u = new URL(oauth.authUrl({ scopes: ['a', 'b'], state: 's', challenge: 'c', redirectUri: 'https://app/cb' }));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('a b');
    expect(u.searchParams.get('client_id')).toBe('cid');
  });

  it('keeps the old refresh token when the provider omits one (Google)', async () => {
    const c = new OAuthClient({ authUrl: 'x:', tokenUrl: 'https://idp.test/token', clientId: 'c', clientSecret: 's' }, fakeFetch([[/token/, () => ({ access_token: 'new', expires_in: 100 })]]));
    const t = await c.refresh({ accessToken: 'old', refreshToken: 'keep', expiresAt: 0 });
    expect(t.accessToken).toBe('new');
    expect(t.refreshToken).toBe('keep');
  });

  it('treats a revoked grant as an auth error', async () => {
    const c = new OAuthClient({ authUrl: 'x:', tokenUrl: 'https://idp.test/token', clientId: 'c', clientSecret: 's' }, fakeFetch([[/token/, () => status(400)]]));
    await expect(c.refresh({ accessToken: 'o', refreshToken: 'r', expiresAt: 0 })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('Gmail', () => {
  const full: GmailMessage = {
    id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: '1760000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Sam <sam@acme.com>' }, { name: 'To', value: 'me@x.com, "Lee, K" <k@y.com>' },
        { name: 'Cc', value: 'boss@acme.com' }, { name: 'Subject', value: 'Invoice 42' },
      ],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64('Please pay.') } },
          { mimeType: 'text/html', body: { data: b64('<p>Please <b>pay</b>.</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'inv.pdf', body: { attachmentId: 'att1', size: 1234 } },
      ],
    },
  };

  it('maps a multipart message to the unified model', () => {
    const m = parseGmailMessage(full);
    expect(m).toMatchObject({
      externalId: 'm1', threadExternalId: 't1', subject: 'Invoice 42', bodyText: 'Please pay.', direction: 'inbound', isRead: false,
      sender: { email: 'sam@acme.com', name: 'Sam' },
      attachments: [{ name: 'inv.pdf', mime: 'application/pdf', size: 1234, externalRef: 'att1' }],
    });
    expect(m.recipients.to).toHaveLength(2);
    expect(m.recipients.cc).toEqual([{ email: 'boss@acme.com' }]);
    expect(m.bodyHtml).toContain('<b>pay</b>');
    expect(m.timestamp.getTime()).toBe(1760000000000);
  });

  it('marks sent mail outbound and derives text from HTML-only bodies', () => {
    const m = parseGmailMessage({ id: 'm2', threadId: 't2', labelIds: ['SENT'], payload: { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') }, headers: [] } });
    expect(m.direction).toBe('outbound');
    expect(m.isRead).toBe(true);
    expect(m.bodyText).toBe('Hello');
  });

  it('initial sync pages the listing, reads history id first, and skips spam', async () => {
    const f = fakeFetch([
      [/\/profile/, () => ({ historyId: '900' })],
      [/\/messages\?/, (u) => (u.searchParams.get('pageToken') ? { messages: [{ id: 'm3' }] } : { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p2' })],
      [/\/messages\/m1/, () => full],
      [/\/messages\/m2/, () => ({ ...full, id: 'm2', labelIds: ['SPAM'] })],
      [/\/messages\/m3/, () => ({ ...full, id: 'm3', labelIds: ['INBOX'] })],
    ]);
    const r = await new GmailConnector(oauth, {}, f).initialSync(acct('gmail'), new Date('2026-10-01T00:00:00Z'));
    expect(r.cursor).toBe('900');
    expect(r.messages.map((m) => m.externalId).sort()).toEqual(['m1', 'm3']);
    expect(f.calls[0]).toContain('/profile');
    expect(f.calls.find((c) => c.includes('q=after'))).toContain(`after%3A${Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000)}`);
  });

  it('incremental sync fetches changed messages, handles deletes and 404s, and advances the cursor', async () => {
    const f = fakeFetch([
      [/\/history/, () => ({ historyId: '950', history: [{ messagesAdded: [{ message: { id: 'm1' } }], labelsAdded: [{ message: { id: 'm1' } }], messagesDeleted: [{ message: { id: 'gone' } }] }, { labelsRemoved: [{ message: { id: 'vanished' } }] }] })],
      [/\/messages\/m1/, () => full],
      [/\/messages\/vanished/, () => status(404)],
    ]);
    const r = await new GmailConnector(oauth, {}, f).incrementalSync(acct('gmail'), '900');
    expect(r.cursor).toBe('950');
    expect(r.messages.map((m) => m.externalId)).toEqual(['m1']);
    expect(r.deletedExternalIds.sort()).toEqual(['gone', 'vanished']);
  });

  it('asks for a fresh sync when history has expired', async () => {
    const f = fakeFetch([[/\/history/, () => status(404)]]);
    await expect(new GmailConnector(oauth, {}, f).incrementalSync(acct('gmail'), '1')).rejects.toBeInstanceOf(SyncResetError);
  });

  it('maps a rejected token to ProviderAuthError', async () => {
    const f = fakeFetch([[/\/profile/, () => status(401)]]);
    await expect(new GmailConnector(oauth, {}, f).initialSync(acct('gmail'), new Date())).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('refuses Pub/Sub pushes when verification is not configured or the token is missing', async () => {
    await expect(new GmailConnector(oauth).handleWebhook({ headers: {}, query: {}, body: {} })).rejects.toBeInstanceOf(ProviderAuthError);
    const c = new GmailConnector(oauth, { pubsubAudience: 'aud', pubsubServiceAccount: 'sa@x' });
    await expect(c.handleWebhook({ headers: {}, query: {}, body: {} })).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(c.handleWebhook({ headers: { authorization: 'Bearer forged' }, query: {}, body: {} })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('Google Calendar', () => {
  it('maps timed, all-day and cancelled events', () => {
    const timed = parseGoogleEvent({ id: 'e1', summary: 'Standup', start: { dateTime: '2026-10-21T09:00:00+08:00', timeZone: 'Asia/Kuala_Lumpur' }, end: { dateTime: '2026-10-21T09:15:00+08:00' }, hangoutLink: 'https://meet.google.com/x', attendees: [{ email: 'A@x.com', responseStatus: 'accepted' }], organizer: { email: 'o@x.com' } })!;
    expect(timed).toMatchObject({ title: 'Standup', allDay: false, timezone: 'Asia/Kuala_Lumpur', meetingLink: 'https://meet.google.com/x', status: 'confirmed' });
    expect(timed.start.toISOString()).toBe('2026-10-21T01:00:00.000Z');
    expect(timed.attendees[0]).toMatchObject({ email: 'a@x.com', response: 'accepted' });
    expect(parseGoogleEvent({ id: 'e2', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } })!.allDay).toBe(true);
    expect(parseGoogleEvent({ id: 'e3', status: 'cancelled' })).toBeNull();
  });

  it('collects pages, reports cancellations as deletions, and returns the sync token', async () => {
    const page2 = { items: [{ id: 'dead', status: 'cancelled' }], nextSyncToken: 'S2' };
    const page1 = { items: [{ id: 'e1', summary: 'A', start: { dateTime: '2026-10-21T01:00:00Z' }, end: { dateTime: '2026-10-21T02:00:00Z' } }], nextPageToken: 'p2' };
    const f = fakeFetch([[/\/events\?/, (u) => (u.searchParams.get('pageToken') ? page2 : page1)]]);
    const r = await new GoogleCalendarConnector(oauth, f).initialSync(acct('google_calendar'), new Date());
    expect(r.events.map((e) => e.externalId)).toEqual(['e1']);
    expect(r.deletedExternalIds).toEqual(['dead']);
    expect(r.cursor).toBe('S2');
  });

  it('resets on an expired sync token (410)', async () => {
    const f = fakeFetch([[/\/events\?/, () => status(410)]]);
    await expect(new GoogleCalendarConnector(oauth, f).incrementalSync(acct('google_calendar'), 'old')).rejects.toBeInstanceOf(SyncResetError);
  });

  it('extracts channel id and token from push headers', async () => {
    const r = await new GoogleCalendarConnector(oauth).handleWebhook({ headers: { 'x-goog-channel-id': 'ch1', 'x-goog-channel-token': 'tk' }, query: {}, body: null });
    expect(r.lookups).toEqual([{ subscriptionId: 'ch1', clientState: 'tk' }]);
    await expect(new GoogleCalendarConnector(oauth).handleWebhook({ headers: {}, query: {}, body: null })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('Outlook', () => {
  const msg = { id: 'o1', conversationId: 'c1', subject: 'Hello', from: { emailAddress: { name: 'Pat', address: 'Pat@Corp.com' } }, toRecipients: [{ emailAddress: { address: 'me@x.com' } }], receivedDateTime: '2026-10-20T01:00:00Z', sentDateTime: '2026-10-20T00:59:00Z', isRead: false, body: { contentType: 'html', content: '<p>Hi <b>there</b></p>' }, internetMessageId: '<abc@corp>' };

  it('maps inbox and sent items', () => {
    const inbound = parseGraphMessage(msg, false);
    expect(inbound).toMatchObject({ threadExternalId: 'c1', sender: { email: 'pat@corp.com', name: 'Pat' }, direction: 'inbound', isRead: false, bodyText: 'Hi there', rawRef: '<abc@corp>' });
    expect(inbound.timestamp.toISOString()).toBe('2026-10-20T01:00:00.000Z');
    const sent = parseGraphMessage(msg, true);
    expect(sent).toMatchObject({ direction: 'outbound', isRead: true });
    expect(sent.timestamp.toISOString()).toBe('2026-10-20T00:59:00.000Z');
  });

  it('syncs both folders across pages, honors @removed, and stores a two-part cursor', async () => {
    const f = fakeFetch([
      [/mailFolders\/inbox\/messages\/delta/, () => ({ value: [msg], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-inbox' })],
      [/next-inbox/, () => ({ value: [{ id: 'removed1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-inbox' })],
      [/mailFolders\/sentitems\/messages\/delta/, () => ({ value: [{ ...msg, id: 'o2' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-sent' })],
    ]);
    const r = await new OutlookConnector(oauth, f).initialSync(acct('outlook'), new Date('2026-10-01T00:00:00Z'));
    expect(r.messages.map((m) => [m.externalId, m.direction])).toEqual([['o1', 'inbound'], ['o2', 'outbound']]);
    expect(r.deletedExternalIds).toEqual(['removed1']);
    expect(JSON.parse(r.cursor)).toEqual({ inbox: 'https://graph.microsoft.com/v1.0/delta-inbox', sent: 'https://graph.microsoft.com/v1.0/delta-sent' });
    expect(f.calls[0]).toContain('receivedDateTime');
  });

  it('resets when the delta token expired', async () => {
    const f = fakeFetch([[/delta/, () => status(410)]]);
    await expect(new OutlookConnector(oauth, f).incrementalSync(acct('outlook'), JSON.stringify({ inbox: 'https://graph.microsoft.com/v1.0/delta-inbox', sent: 'https://graph.microsoft.com/v1.0/delta-sent' }))).rejects.toBeInstanceOf(SyncResetError);
  });
});

describe('Microsoft Calendar', () => {
  it('maps UTC event times and skips cancelled', () => {
    const e = parseGraphEvent({ id: 'x', subject: 'Review', start: { dateTime: '2026-10-21T02:00:00.0000000' }, end: { dateTime: '2026-10-21T03:00:00.0000000' }, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' }, attendees: [{ emailAddress: { address: 'A@b.com' }, status: { response: 'accepted' } }] })!;
    expect(e.start.toISOString()).toBe('2026-10-21T02:00:00.000Z');
    expect(e).toMatchObject({ meetingLink: 'https://teams.microsoft.com/l/x', title: 'Review' });
    expect(parseGraphEvent({ id: 'y', isCancelled: true, start: { dateTime: '2026-10-21T02:00:00' }, end: { dateTime: '2026-10-21T03:00:00' } })).toBeNull();
  });

  it('syncs the calendar view and reports removals', async () => {
    const f = fakeFetch([[/calendarView\/delta/, () => ({ value: [{ id: 'x', subject: 'A', start: { dateTime: '2026-10-21T02:00:00' }, end: { dateTime: '2026-10-21T03:00:00' } }, { id: 'gone', '@removed': {} }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/d' })]]);
    const r = await new MicrosoftCalendarConnector(oauth, f).initialSync(acct('microsoft_calendar'), new Date());
    expect(r.events).toHaveLength(1);
    expect(r.deletedExternalIds).toEqual(['gone']);
    expect(r.cursor).toBe('https://graph.microsoft.com/v1.0/d');
  });
});

describe('Graph webhooks', () => {
  const base = new GraphBase(oauth, fakeFetch([]), 'me/events', []);
  it('echoes the validation token', async () => {
    expect(await base.handleWebhook({ headers: {}, query: { validationToken: 'abc' }, body: null })).toEqual({ response: 'abc', lookups: [] });
  });
  it('extracts subscription ids and client state', async () => {
    const r = await base.handleWebhook({ headers: {}, query: {}, body: { value: [{ subscriptionId: 's1', clientState: 'cs' }, { clientState: 'orphan' }] } });
    expect(r.lookups).toEqual([{ subscriptionId: 's1', clientState: 'cs' }]);
  });
  it('rejects malformed bodies', async () => {
    await expect(base.handleWebhook({ headers: {}, query: {}, body: { nope: 1 } })).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('SubscriptionService client state', () => {
  const svc = new SubscriptionService({ JWT_SECRET: 's'.repeat(40) } as Env, null as never, null as never, null as never, null as never);
  it('is stable per account and verifies only the matching value', () => {
    const s = svc.clientState('acct-1');
    expect(svc.clientState('acct-1')).toBe(s);
    expect(svc.verifyClientState('acct-1', s)).toBe(true);
    expect(svc.verifyClientState('acct-2', s)).toBe(false);
    expect(svc.verifyClientState('acct-1', 'short')).toBe(false);
  });
});
