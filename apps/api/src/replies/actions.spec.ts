import { generateKeyPair, exportPKCS8, decodeProtectedHeader } from 'jose';
import { cleanDraft } from '../ai/draft.service';
import { findFreeSlots, zonedToUtc } from '../calendar/calendar-actions.service';
import { GCAL_WRITE_SCOPE, GoogleCalendarConnector } from '../connectors/gcal.connector';
import { GMAIL_SEND_SCOPE, GmailConnector } from '../connectors/gmail.connector';
import { msOAuth } from '../connectors/graph';
import { MicrosoftCalendarConnector } from '../connectors/mscal.connector';
import { OAuthClient } from '../connectors/oauth';
import { OutlookConnector } from '../connectors/outlook.connector';
import { buildMime, hasScope, headerSafe, replySubject } from '../connectors/send';
import { SlackConnector } from '../connectors/slack.connector';
import { TeamsConnector } from '../connectors/teams.connector';
import { ConnectorAccount, FetchFn, ProviderError } from '../connectors/types';
import { WhatsAppConnector } from '../connectors/whatsapp.connector';
import { FcmPush } from '../notifications/fcm';
import { inQuietHours } from '../notifications/notifications.service';

type Call = { method: string; url: string; body: unknown };
/** Records every request; the first matching route answers. */
function recorder(routes: [RegExp, (c: Call) => unknown][]): FetchFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const call = { method: init?.method ?? 'GET', url: String(input), body };
    calls.push(call);
    for (const [re, h] of routes) {
      if (re.test(call.url)) {
        const out = h(call);
        return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('no fixture', { status: 599 });
  }) as FetchFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}
const acct = (channel: ConnectorAccount['channel'], externalId = 'me@x.com', settings: Record<string, unknown> = {}): ConnectorAccount => ({
  id: 'a1', channel, externalId, tokens: { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }, backfillDays: 14, settings,
});
const oauth = new OAuthClient({ authUrl: 'https://idp.test/auth', tokenUrl: 'https://idp.test/token', clientId: 'c', clientSecret: 's' });
const scopeOf = (url: string) => new URL(url).searchParams.get('scope') ?? '';
const q = { state: 's', challenge: 'c', redirectUri: 'https://app/cb' };

describe('send permissions are opt-in', () => {
  it('requests send scopes only when asked', () => {
    const gmail = new GmailConnector(oauth);
    expect(scopeOf(gmail.getAuthUrl(q))).not.toContain('gmail.send');
    expect(scopeOf(gmail.getAuthUrl({ ...q, write: true }))).toContain(GMAIL_SEND_SCOPE);
    const cal = new GoogleCalendarConnector(oauth);
    expect(scopeOf(cal.getAuthUrl(q))).not.toContain('calendar.events');
    expect(scopeOf(cal.getAuthUrl({ ...q, write: true }))).toContain(GCAL_WRITE_SCOPE);
    const ms = msOAuth('c', 's');
    expect(scopeOf(new OutlookConnector(ms).getAuthUrl(q))).not.toContain('Mail.Send');
    expect(scopeOf(new OutlookConnector(ms).getAuthUrl({ ...q, write: true }))).toContain('Mail.Send');
    expect(scopeOf(new MicrosoftCalendarConnector(ms).getAuthUrl({ ...q, write: true }))).toContain('Calendars.ReadWrite');
    expect(scopeOf(new TeamsConnector(ms).getAuthUrl(q))).not.toContain('ChatMessage.Send');
    expect(scopeOf(new TeamsConnector(ms).getAuthUrl({ ...q, write: true }))).toContain('ChatMessage.Send');
    const slack = new SlackConnector({ clientId: 'c', clientSecret: 's' });
    expect(new URL(slack.getAuthUrl(q)).searchParams.get('user_scope')).not.toContain('chat:write');
    expect(new URL(slack.getAuthUrl({ ...q, write: true })).searchParams.get('user_scope')).toContain('chat:write');
  });

  it('matches granted scopes as bare names or URL tails', () => {
    expect(hasScope(['https://graph.microsoft.com/Mail.Send', 'openid'], 'Mail.Send')).toBe(true);
    expect(hasScope(['https://www.googleapis.com/auth/gmail.send'], GMAIL_SEND_SCOPE)).toBe(true);
    expect(hasScope(['chat:write'], 'chat:write')).toBe(true);
    expect(hasScope(['Mail.Read'], 'Mail.Send')).toBe(false);
    expect(hasScope([], undefined)).toBe(false);
  });
});

describe('MIME and header safety', () => {
  it('strips line breaks from header values so a subject cannot inject headers', () => {
    expect(headerSafe('Hi\r\nBcc: evil@x.com')).toBe('Hi Bcc: evil@x.com');
    const mime = buildMime({ to: ['a@x.com\r\nBcc: evil@x.com'], subject: replySubject('Quote\r\nBcc: evil@x.com'), inReplyTo: '<1@x>', text: 'Body' });
    const head = mime.split('\r\n\r\n')[0].split('\r\n');
    expect(head.filter((l) => /^bcc:/i.test(l))).toEqual([]);
    expect(mime).toContain('In-Reply-To: <1@x>');
  });
  it('encodes non-ASCII subjects and bodies, and does not double the Re: prefix', () => {
    expect(replySubject('Re: hello')).toBe('Re: hello');
    const mime = buildMime({ to: ['a@x.com'], subject: 'Réunion', text: 'Café ☕' });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Café ☕');
  });
});

describe('Gmail sendReply', () => {
  it('threads the reply with the original Message-ID and sends only to the confirmed address', async () => {
    const f = recorder([
      [/messages\/orig1\?/, () => ({ payload: { headers: [{ name: 'Message-ID', value: '<orig@mail>' }, { name: 'References', value: '<root@mail>' }] } })],
      [/messages\/send/, () => ({ id: 'sent1', threadId: 'th1' })],
    ]);
    const r = await new GmailConnector(oauth, {}, f).sendReply(acct('gmail'), { threadExternalId: 'th1', replyToExternalId: 'orig1', to: [{ email: 'bob@y.com', name: 'Bob' }], subject: 'Invoice', text: 'Thanks, paid.' });
    const sent = f.calls.find((c) => c.url.endsWith('/messages/send'))!;
    const raw = Buffer.from((sent.body as { raw: string }).raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: bob@y.com');
    expect(raw).toContain('In-Reply-To: <orig@mail>');
    expect(raw).toContain('References: <root@mail> <orig@mail>');
    expect(raw).toContain('Subject: Re: Invoice');
    expect((sent.body as { threadId: string }).threadId).toBe('th1');
    expect(r).toMatchObject({ externalId: 'sent1', message: { direction: 'outbound', bodyText: 'Thanks, paid.', threadExternalId: 'th1' } });
  });
  it('refuses without a valid recipient and sends nothing', async () => {
    const f = recorder([]);
    await expect(new GmailConnector(oauth, {}, f).sendReply(acct('gmail'), { threadExternalId: 't', replyToExternalId: 'm', to: [{ handle: '+65' }], subject: 's', text: 'x' })).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('Outlook sendReply', () => {
  const req = { threadExternalId: 'c1', replyToExternalId: 'm1', to: [{ email: 'bob@y.com' }], subject: 's', text: 'ok' };
  it('sends the Graph reply draft after checking it is addressed to the confirmed person', async () => {
    const f = recorder([
      [/createReply/, () => ({ id: 'd1', toRecipients: [{ emailAddress: { address: 'Bob@Y.com' } }] })],
      [/messages\/d1\/send/, () => new Response(null, { status: 202 })],
      [/messages\/d1$/, () => ({})],
    ]);
    await new OutlookConnector(oauth, f).sendReply(acct('outlook'), req);
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname.split('/v1.0')[1]}`)).toEqual(['POST /me/messages/m1/createReply', 'PATCH /me/messages/d1', 'POST /me/messages/d1/send']);
    expect(f.calls[1].body).toEqual({ body: { contentType: 'text', content: 'ok' } });
  });
  it('deletes the draft and sends nothing when a Reply-To would redirect the reply', async () => {
    const f = recorder([[/createReply/, () => ({ id: 'd2', toRecipients: [{ emailAddress: { address: 'attacker@evil.com' } }] })], [/messages\/d2$/, () => new Response(null, { status: 204 })]]);
    await expect(new OutlookConnector(oauth, f).sendReply(acct('outlook'), req)).rejects.toThrow(/different address/);
    expect(f.calls.some((c) => c.url.endsWith('/send'))).toBe(false);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/messages/d2'))).toBe(true);
  });
});

describe('chat sends', () => {
  it('Slack posts into the thread as plain text, defusing markup', async () => {
    const f = recorder([[/chat\.postMessage/, () => ({ ok: true, ts: '1760000000.000900' })]]);
    const r = await new SlackConnector({ clientId: 'c', clientSecret: 's' }, f).sendReply(acct('slack', 'T1:U1'), {
      threadExternalId: 'C1:1760000000.000100', replyToExternalId: 'C1:1760000000.000100', to: [{ handle: 'U2' }], subject: '#ops', text: 'ping <!channel> <@U9> a & b',
    });
    expect(f.calls[0].body).toMatchObject({ channel: 'C1', thread_ts: '1760000000.000100', text: 'ping &lt;!channel&gt; &lt;@U9&gt; a &amp; b', link_names: 'false', unfurl_links: 'false' });
    expect(r.externalId).toBe('C1:1760000000.000900');
    const dm = recorder([[/chat\.postMessage/, () => ({ ok: true, ts: '1.1' })]]);
    await new SlackConnector({ clientId: 'c', clientSecret: 's' }, dm).sendReply(acct('slack', 'T1:U1'), { threadExternalId: 'D1', replyToExternalId: 'D1:1', to: [], subject: null, text: 'hi' });
    expect(dm.calls[0].body).not.toHaveProperty('thread_ts');
  });
  it('Teams posts to the chat and WhatsApp to the customer from the business number', async () => {
    const t = recorder([[/\/me\/chats\/.*\/messages/, () => ({ id: 'mm1', createdDateTime: '2026-10-20T10:00:00Z' })]]);
    const tr = await new TeamsConnector(msOAuth('c', 's'), t).sendReply(acct('teams'), { threadExternalId: '19:abc@thread.v2', replyToExternalId: '19:abc@thread.v2:1', to: [], subject: 'Ana', text: 'on it' });
    expect(t.calls[0].body).toEqual({ body: { contentType: 'text', content: 'on it' } });
    expect(tr.externalId).toBe('19:abc@thread.v2:mm1');
    const w = recorder([[/\/PN1\/messages/, () => ({ messages: [{ id: 'wamid.OUT' }] })]]);
    const wr = await new WhatsAppConnector({ appId: 'a', appSecret: 's', configId: 'c', version: 'v21.0' }, w).sendReply(acct('whatsapp', 'PN1'), { threadExternalId: '6591234567', replyToExternalId: 'wamid.IN', to: [{ handle: '+6591234567' }], subject: 'Lee', text: 'Open till 6' });
    expect(w.calls[0].body).toMatchObject({ messaging_product: 'whatsapp', to: '6591234567', type: 'text', text: { body: 'Open till 6' } });
    expect(wr.message).toMatchObject({ externalId: 'wamid.OUT', direction: 'outbound' });
  });
});

describe('calendar responses', () => {
  it('Google changes only the signed-in attendee and leaves the others as they were', async () => {
    const f = recorder([
      [/events\/ev1\?sendUpdates/, () => ({})],
      [/events\/ev1$/, () => ({ attendees: [{ email: 'boss@x.com', responseStatus: 'accepted' }, { email: 'me@x.com', self: true, responseStatus: 'needsAction' }] })],
    ]);
    await new GoogleCalendarConnector(oauth, f).respondToEvent(acct('google_calendar'), { eventExternalId: 'ev1', response: 'decline', comment: 'Clash' });
    const patch = f.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('sendUpdates=all');
    expect((patch.body as { attendees: unknown[] }).attendees).toEqual([{ email: 'boss@x.com', responseStatus: 'accepted' }, { email: 'me@x.com', self: true, responseStatus: 'declined', comment: 'Clash' }]);
  });
  it('Google refuses when the user is not an invited attendee', async () => {
    const f = recorder([[/events\/ev2$/, () => ({ attendees: [{ email: 'x@y.com' }] })]]);
    await expect(new GoogleCalendarConnector(oauth, f).respondToEvent(acct('google_calendar'), { eventExternalId: 'ev2', response: 'accept' })).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
  it('Microsoft uses the accept / decline / tentativelyAccept actions', async () => {
    const f = recorder([[/events\//, () => new Response(null, { status: 202 })]]);
    const c = new MicrosoftCalendarConnector(msOAuth('c', 's'), f);
    for (const r of ['accept', 'decline', 'tentative'] as const) await c.respondToEvent(acct('microsoft_calendar'), { eventExternalId: 'e1', response: r });
    expect(f.calls.map((x) => x.url.split('/').pop())).toEqual(['accept', 'decline', 'tentativelyAccept']);
    expect(f.calls[0].body).toEqual({ comment: '', sendResponse: true });
  });
});

describe('finding meeting times', () => {
  const base = { durationMin: 30, timezone: 'UTC', dayStartHour: 9, dayEndHour: 17, includeWeekends: false, bufferMin: 0, limit: 10, maxPerDay: 2, days: 6 };
  const monday = new Date('2099-06-01T00:00:00Z'); // far future so "now" never trims the window; this is a Monday
  it('stays inside working hours, skips weekends, and respects the per-day cap', () => {
    const slots = findFreeSlots([], { ...base, from: monday });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect([0, 6]).not.toContain(s.start.getUTCDay());
      expect(s.start.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(s.end.getUTCHours() * 60 + s.end.getUTCMinutes()).toBeLessThanOrEqual(17 * 60);
    }
    const perDay = new Map<string, number>();
    for (const s of slots) perDay.set(s.start.toISOString().slice(0, 10), (perDay.get(s.start.toISOString().slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
  });
  it('never overlaps a busy block, including its buffer', () => {
    const busy = [{ start: new Date('2099-06-01T09:00:00Z'), end: new Date('2099-06-01T12:00:00Z') }];
    const slots = findFreeSlots(busy, { ...base, bufferMin: 30, from: monday, days: 0 });
    expect(slots[0].start.toISOString()).toBe('2099-06-01T12:30:00.000Z');
    for (const s of slots) expect(s.start < new Date('2099-06-01T12:30:00Z')).toBe(false);
  });
  it('uses the local time zone, including daylight saving', () => {
    expect(zonedToUtc(2099, 1, 5, 9, 0, 'Asia/Singapore').toISOString()).toBe('2099-01-05T01:00:00.000Z');
    expect(zonedToUtc(2099, 7, 6, 9, 0, 'America/New_York').toISOString()).toBe('2099-07-06T13:00:00.000Z');
    expect(zonedToUtc(2099, 1, 5, 9, 0, 'America/New_York').toISOString()).toBe('2099-01-05T14:00:00.000Z');
    const slots = findFreeSlots([], { ...base, timezone: 'Asia/Singapore', from: monday, days: 0 });
    expect(slots[0].start.toISOString()).toBe('2099-06-01T01:00:00.000Z');
  });
  it('returns nothing when the day is full', () => {
    const busy = [{ start: new Date('2099-06-01T00:00:00Z'), end: new Date('2099-06-02T00:00:00Z') }];
    expect(findFreeSlots(busy, { ...base, from: monday, days: 0 })).toEqual([]);
  });
});

describe('draft cleanup', () => {
  it('removes wrappers the model likes to add, and nothing else', () => {
    expect(cleanDraft('```\nSure, Friday works.\n```')).toBe('Sure, Friday works.');
    expect(cleanDraft('Here is a draft reply:\n\nSure, Friday works.')).toBe('Sure, Friday works.');
    expect(cleanDraft('"Sure, Friday works."')).toBe('Sure, Friday works.');
    expect(cleanDraft('He said "yes" and "no"')).toBe('He said "yes" and "no"');
    expect(cleanDraft('x'.repeat(5000))).toHaveLength(4000);
  });
});

describe('notifications', () => {
  it('quiet hours work across midnight', () => {
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(7, 22, 7)).toBe(false);
    expect(inQuietHours(12, 22, 7)).toBe(false);
    expect(inQuietHours(10, 9, 17)).toBe(true);
    expect(inQuietHours(10, null, null)).toBe(false);
    expect(inQuietHours(10, 5, 5)).toBe(false);
  });

  it('FCM signs a service-account assertion, sends a data-light message and reports dead tokens', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    let assertion = '';
    const f = recorder([
      [/oauth2\.googleapis\.com\/token/, (c) => { assertion = (c.body as Record<string, string>).assertion; return { access_token: 'ya29', expires_in: 3600 }; }],
      [/messages:send/, (c) => ((c.body as { message: { token: string } }).message.token === 'dead' ? new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 }) : { name: 'ok' })],
    ]);
    const fcm = FcmPush.fromEnv('proj', JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem }), f)!;
    expect(await fcm.send('good', { title: 'Slack', body: 'A message needs your reply', data: { threadId: 't1' } })).toBe('sent');
    expect(await fcm.send('dead', { title: 'x', body: 'y', data: {} })).toBe('invalid_token');
    expect(decodeProtectedHeader(assertion).alg).toBe('RS256');
    expect(f.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1); // token cached
    expect(f.calls.find((c) => c.url.includes('messages:send'))!.url).toContain('/projects/proj/');
    expect(FcmPush.fromEnv(undefined, undefined)).toBeNull();
    expect(FcmPush.fromEnv('p', 'not json')).toBeNull();
  });
});
