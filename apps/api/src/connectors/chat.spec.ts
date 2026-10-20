import { createHmac } from 'crypto';
import { LinkedInConnector } from './linkedin.connector';
import { OAuthClient } from './oauth';
import { SlackConnector, slackText, slackToMessage } from './slack.connector';
import { TeamsConnector, teamsToMessage } from './teams.connector';
import { ConnectorAccount, FetchFn, ProviderAuthError } from './types';
import { WhatsAppConnector, waToMessage } from './whatsapp.connector';

type Handler = (url: URL, params: URLSearchParams) => unknown;
/** Recorded-fixture HTTP: first matching pattern answers; request body params are passed to the handler. */
function fakeFetch(routes: [RegExp, Handler][]): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    for (const [re, h] of routes) {
      if (re.test(url.toString())) {
        const out = h(url, params);
        return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('no fixture', { status: 599 });
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const tokens = { accessToken: 'tok', refreshToken: null, expiresAt: Date.now() + 3_600_000 };
const acct = (channel: ConnectorAccount['channel'], externalId: string, settings?: Record<string, unknown>): ConnectorAccount => ({ id: 'a1', channel, externalId, tokens, backfillDays: 14, settings });
const nowTs = () => (Date.now() / 1000 - 60).toFixed(6);

describe('Slack', () => {
  const secret = 'signing-secret';
  const slack = (f: FetchFn = fakeFetch([])) => new SlackConnector({ clientId: 'c', clientSecret: 's', signingSecret: secret }, f);

  it('formats Slack markup as plain text', () => {
    const names = new Map([['U2', 'Ana']]);
    expect(slackText('Hi <@U2>, see <#C1|general> and <https://x.test/a|the doc> &amp; <!here>', names)).toBe('Hi @Ana, see #general and the doc (https://x.test/a) & @here');
  });

  it('maps channel and DM messages: channels thread by Slack thread, DMs by conversation', () => {
    const names = new Map([['U1', 'Me'], ['U2', 'Ana']]);
    const ch = slackToMessage({ ts: '1760000000.000100', user: 'U2', text: 'Budget approved' }, { id: 'C1', name: 'finance' }, 'U1', names, '0');
    expect(ch).toMatchObject({ externalId: 'C1:1760000000.000100', threadExternalId: 'C1:1760000000.000100', subject: '#finance · Budget approved', direction: 'inbound', isRead: false, sender: { name: 'Ana', handle: 'U2' } });
    const reply = slackToMessage({ ts: '1760000100.000200', thread_ts: '1760000000.000100', user: 'U1', text: 'thanks' }, { id: 'C1', name: 'finance' }, 'U1', names, '0', 'Budget approved');
    expect(reply.threadExternalId).toBe(ch.threadExternalId);
    expect(reply).toMatchObject({ direction: 'outbound', isRead: true });
    const dm = slackToMessage({ ts: '1760000200.000300', user: 'U2', text: 'hello' }, { id: 'D1', is_im: true, user: 'U2' }, 'U1', names, '1760000300.0');
    expect(dm).toMatchObject({ threadExternalId: 'D1', subject: 'Direct message with Ana', isRead: true });
  });

  it('builds the consent URL with user scopes only and exchanges the code for a user token', async () => {
    const f = fakeFetch([[/oauth\.v2\.access/, () => ({ ok: true, authed_user: { id: 'U1', access_token: 'xoxp-1', scope: 'im:history,users:read' }, team: { id: 'T1', name: 'Acme' } })]]);
    const c = slack(f);
    const url = new URL(c.getAuthUrl({ state: 'st', challenge: 'ch', redirectUri: 'https://app/cb' }));
    expect(url.searchParams.get('user_scope')).toContain('im:history');
    expect(url.searchParams.get('scope')).toBeNull();
    const r = await c.handleAuthCallback({ code: 'c', verifier: 'v', redirectUri: 'https://app/cb' });
    expect(r).toMatchObject({ externalId: 'T1:U1', displayName: 'Acme', scopes: ['im:history', 'users:read'], tokens: { accessToken: 'xoxp-1', refreshToken: null } });
    expect(c.longLivedTokens).toBe(true);
  });

  it('syncs channel history, DMs and thread replies, resolving names and read state', async () => {
    const ts1 = nowTs();
    const parent = (Number(ts1) - 100).toFixed(6);
    const reply = (Number(ts1) + 5).toFixed(6);
    const f = fakeFetch([
      [/users\.conversations/, () => ({ ok: true, channels: [{ id: 'C1', name: 'ops' }, { id: 'D1', is_im: true, user: 'U2' }] })],
      [/conversations\.history/, (_u, p) =>
        p.get('channel') === 'C1'
          ? { ok: true, messages: [{ ts: parent, user: 'U2', text: 'Deploy at 5? <@U1>', reply_count: 1, thread_ts: parent }, { ts: ts1, subtype: 'channel_join', user: 'U3', text: 'joined' }] }
          : { ok: true, messages: [{ ts: ts1, user: 'U2', text: 'ping' }] }],
      [/conversations\.info/, () => ({ ok: true, channel: { last_read: '0' } })],
      [/conversations\.replies/, () => ({ ok: true, messages: [{ ts: parent, user: 'U2', text: 'Deploy at 5? <@U1>', thread_ts: parent }, { ts: reply, user: 'U1', text: 'yes', thread_ts: parent }] })],
      [/users\.info/, (_u, p) => ({ ok: true, user: { real_name: p.get('user') === 'U2' ? 'Ana' : 'Me' } })],
    ]);
    const r = await slack(f).initialSync(acct('slack', 'T1:U1'), new Date(Date.now() - 86_400_000));
    const ids = r.messages.map((m) => m.externalId).sort();
    expect(ids).toEqual([`C1:${parent}`, `C1:${reply}`, `D1:${ts1}`].sort()); // join noise dropped, reply fetched
    expect(r.messages.find((m) => m.externalId === `C1:${parent}`)!.bodyText).toBe('Deploy at 5? @Me');
    expect(r.messages.find((m) => m.externalId === `C1:${reply}`)!).toMatchObject({ direction: 'outbound', threadExternalId: `C1:${parent}` });
    const cursor = JSON.parse(r.cursor);
    expect(cursor.c.D1).toBe(ts1);
    expect(cursor.t[`C1:${parent}`]).toBe(reply);
  });

  it('uses the stored per-conversation cursor as "oldest" on the next sync', async () => {
    const seen: string[] = [];
    const f = fakeFetch([
      [/users\.conversations/, () => ({ ok: true, channels: [{ id: 'C1', name: 'ops' }] })],
      [/conversations\.history/, (_u, p) => { seen.push(p.get('oldest')!); return { ok: true, messages: [] }; }],
    ]);
    await slack(f).incrementalSync(acct('slack', 'T1:U1'), JSON.stringify({ c: { C1: '1760000000.000100' }, t: {} }));
    expect(seen).toEqual(['1760000000.000100']);
  });

  it('maps revoked tokens to ProviderAuthError and skips conversations we lost access to', async () => {
    const bad = fakeFetch([[/users\.conversations/, () => ({ ok: false, error: 'token_revoked' })]]);
    await expect(slack(bad).incrementalSync(acct('slack', 'T1:U1'), '{"c":{},"t":{}}')).rejects.toBeInstanceOf(ProviderAuthError);
    const gone = fakeFetch([
      [/users\.conversations/, () => ({ ok: true, channels: [{ id: 'C1', name: 'old' }] })],
      [/conversations\.history/, () => ({ ok: false, error: 'not_in_channel' })],
    ]);
    const r = await slack(gone).incrementalSync(acct('slack', 'T1:U1'), '{"c":{},"t":{}}');
    expect(r.messages).toEqual([]);
  });

  describe('Events API signature', () => {
    const sign = (body: string, ts: string, key = secret) => `v0=${createHmac('sha256', key).update(`v0:${ts}:${body}`).digest('hex')}`;
    const req = (body: object, over: { ts?: string; sig?: string; raw?: boolean } = {}) => {
      const raw = JSON.stringify(body);
      const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
      return { headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': over.sig ?? sign(raw, ts) }, query: {}, body, rawBody: over.raw === false ? undefined : Buffer.from(raw) };
    };

    it('answers the URL verification challenge and routes message events to the workspace', async () => {
      expect(await slack().handleWebhook(req({ type: 'url_verification', challenge: 'abc' }))).toEqual({ response: 'abc', lookups: [] });
      expect(await slack().handleWebhook(req({ type: 'event_callback', team_id: 'T1', event: { type: 'message' } }))).toEqual({ lookups: [{ externalIdPrefix: 'T1:' }] });
      expect(await slack().handleWebhook(req({ type: 'event_callback', team_id: 'T1', authorizations: [{ user_id: 'U9' }], event: { type: 'message.im' } }))).toEqual({ lookups: [{ externalId: 'T1:U9' }] });
      expect(await slack().handleWebhook(req({ type: 'event_callback', team_id: 'T1', event: { type: 'reaction_added' } }))).toEqual({ lookups: [] });
    });

    it('rejects bad signatures, stale timestamps, missing raw body and a missing secret', async () => {
      const body = { type: 'event_callback', team_id: 'T1', event: { type: 'message' } };
      await expect(slack().handleWebhook(req(body, { sig: 'v0=deadbeef' }))).rejects.toBeInstanceOf(ProviderAuthError);
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      await expect(slack().handleWebhook(req(body, { ts: old }))).rejects.toBeInstanceOf(ProviderAuthError); // validly signed but replayed
      await expect(slack().handleWebhook(req(body, { raw: false }))).rejects.toBeInstanceOf(ProviderAuthError);
      const noSecret = new SlackConnector({ clientId: 'c', clientSecret: 's' });
      await expect(noSecret.handleWebhook(req(body))).rejects.toBeInstanceOf(ProviderAuthError);
      await expect(slack().handleWebhook({ ...req(body), rawBody: Buffer.from(JSON.stringify({ ...body, team_id: 'T2' })) })).rejects.toBeInstanceOf(ProviderAuthError); // tampered body
    });
  });
});

describe('Teams', () => {
  const oauth = new OAuthClient({ authUrl: 'https://idp.test/auth', tokenUrl: 'https://idp.test/token', clientId: 'c', clientSecret: 's' });
  const chat = { id: '19:abc@thread.v2', topic: null, members: [{ userId: 'me', displayName: 'Me' }, { userId: 'u2', displayName: 'Ana' }], viewpoint: { lastMessageReadDateTime: '2026-10-20T08:00:00Z' } };

  it('maps chat messages: subject from members, html to text, read state from the viewpoint', () => {
    const m = teamsToMessage({ id: '1', messageType: 'message', createdDateTime: '2026-10-20T07:00:00Z', from: { user: { id: 'u2', displayName: 'Ana' } }, body: { contentType: 'html', content: '<p>Lunch <at id="0">Me</at>?</p>' } }, chat, 'me');
    expect(m).toMatchObject({ externalId: '19:abc@thread.v2:1', threadExternalId: '19:abc@thread.v2', subject: 'Ana', direction: 'inbound', isRead: true, sender: { name: 'Ana', handle: 'u2' } });
    expect(m.bodyText).toBe('Lunch Me?');
    const mine = teamsToMessage({ id: '2', messageType: 'message', createdDateTime: '2026-10-20T09:00:00Z', from: { user: { id: 'me' } }, body: { contentType: 'text', content: 'ok' } }, chat, 'me');
    expect(mine).toMatchObject({ direction: 'outbound', isRead: true });
  });

  it('only reads chats that changed, skips system events, reports deletions and advances per-chat cursors', async () => {
    const f = fakeFetch([
      [/\/me\/chats\/[^/]+\/messages/, (u) => {
        expect(decodeURIComponent(u.search)).toContain('lastModifiedDateTime gt 2026-10-19T00:00:00.000Z');
        return {
          value: [
            { id: '3', messageType: 'message', createdDateTime: '2026-10-20T09:00:00Z', lastModifiedDateTime: '2026-10-20T09:00:00Z', from: { user: { id: 'u2', displayName: 'Ana' } }, body: { contentType: 'text', content: 'new' } },
            { id: '2', messageType: 'systemEventMessage', lastModifiedDateTime: '2026-10-20T08:30:00Z' },
            { id: '1', messageType: 'message', deletedDateTime: '2026-10-20T08:00:00Z', lastModifiedDateTime: '2026-10-20T08:00:00Z' },
          ],
        };
      }],
      [/\/me\/chats\?/, () => ({ value: [{ ...chat, lastMessagePreview: { createdDateTime: '2026-10-20T09:00:00Z' } }, { id: 'quiet', members: [], lastMessagePreview: { createdDateTime: '2026-10-18T09:00:00Z' } }] })],
    ]);
    const r = await new TeamsConnector(oauth, f).initialSync(acct('teams', 'me@x.com', { userId: 'me' }), new Date('2026-10-19T00:00:00Z'));
    expect(r.messages.map((m) => m.externalId)).toEqual(['19:abc@thread.v2:3']);
    expect(r.deletedExternalIds).toEqual(['19:abc@thread.v2:1']);
    expect(JSON.parse(r.cursor)).toEqual({ '19:abc@thread.v2': '2026-10-20T09:00:00Z' });
    expect(f.calls.filter((c) => c.includes('quiet'))).toEqual([]);
  });

  it('requests only the Chat.Read scope and has no push subscription', () => {
    const t = new TeamsConnector(oauth);
    const scope = new URL(t.getAuthUrl({ state: 's', challenge: 'c', redirectUri: 'https://app/cb' })).searchParams.get('scope')!;
    expect(scope).toContain('Chat.Read');
    expect(scope).not.toMatch(/\.All|ReadWrite|Send/);
    expect((t as { subscribe?: unknown }).subscribe).toBeUndefined();
    expect(t.capabilities.realtime).toBe(false);
  });
});

describe('WhatsApp Business', () => {
  const appSecret = 'app-secret';
  const wa = (f: FetchFn = fakeFetch([])) => new WhatsAppConnector({ appId: 'app', appSecret, configId: 'cfg', verifyToken: 'verify-me', version: 'v21.0' }, f);
  const value = {
    metadata: { display_phone_number: '15550001111', phone_number_id: 'PN1' },
    contacts: [{ wa_id: '6591234567', profile: { name: 'Lee' } }],
    messages: [
      { id: 'wamid.1', from: '6591234567', timestamp: '1760000000', type: 'text', text: { body: 'Is the clinic open?' } },
      { id: 'wamid.2', from: '6591234567', timestamp: '1760000060', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'photo' } },
      { id: 'wamid.3', from: '6591234567', timestamp: '1760000070', type: 'reaction' },
    ],
  };
  const signed = (body: object, key = appSecret) => {
    const raw = JSON.stringify(body);
    return { headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', key).update(raw).digest('hex')}` }, query: {}, body, rawBody: Buffer.from(raw) };
  };
  const hook = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] };

  it('converts stored events into messages: one thread per customer, media by reference only, reactions ignored', () => {
    const r = wa().ingestPushed(acct('whatsapp', 'PN1'), [value]);
    expect(r.messages.map((m) => m.externalId)).toEqual(['wamid.1', 'wamid.2']);
    expect(r.messages[0]).toMatchObject({ threadExternalId: '6591234567', subject: 'Lee (+6591234567)', direction: 'inbound', bodyText: 'Is the clinic open?', sender: { name: 'Lee', handle: '+6591234567' } });
    expect(r.messages[1]).toMatchObject({ bodyText: '[image] photo', attachments: [{ externalRef: 'MEDIA1', mime: 'image/jpeg' }] });
    expect(waToMessage({ id: 'x', from: '1', timestamp: '1', type: 'mystery' }, undefined, undefined)!.bodyText).toBe('[Unsupported message type]');
  });

  it('verifies the signature over the raw body and queues content only for the matching business number', async () => {
    const r = await wa().handleWebhook(signed(hook));
    expect(r.lookups).toEqual([{ externalId: 'PN1', payload: value }]);
    const statusOnly = signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'x', status: 'read' }] } }] }] });
    expect((await wa().handleWebhook(statusOnly)).lookups).toEqual([]);
  });

  it('rejects forged, missing or re-serialized signatures', async () => {
    await expect(wa().handleWebhook(signed(hook, 'other-secret'))).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(wa().handleWebhook({ headers: {}, query: {}, body: hook, rawBody: Buffer.from(JSON.stringify(hook)) })).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(wa().handleWebhook({ ...signed(hook), rawBody: undefined })).rejects.toBeInstanceOf(ProviderAuthError);
    const tampered = signed(hook);
    await expect(wa().handleWebhook({ ...tampered, rawBody: Buffer.from(JSON.stringify({ ...hook, extra: 1 })) })).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('answers the subscription handshake only with the right verify token', () => {
    expect(wa().verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' })).toBe('12345');
    expect(() => wa().verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).toThrow();
    const noToken = new WhatsAppConnector({ appId: 'a', appSecret: 's', configId: 'c', version: 'v21.0' });
    expect(() => noToken.verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' })).toThrow();
  });

  it('connects through the shared business account and subscribes it to the app', async () => {
    const f = fakeFetch([
      [/oauth\/access_token/, () => ({ access_token: 'biz-token' })],
      [/debug_token/, () => ({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['WABA1'] }] } })],
      [/WABA1\/phone_numbers/, () => ({ data: [{ id: 'PN1', display_phone_number: '+1 555 000 1111', verified_name: 'Clinic' }] })],
      [/WABA1\/subscribed_apps/, () => ({ success: true })],
    ]);
    const c = wa(f);
    const r = await c.handleAuthCallback({ code: 'c', verifier: 'v', redirectUri: 'https://app/cb' });
    expect(r).toMatchObject({ externalId: 'PN1', displayName: 'Clinic · +1 555 000 1111', settings: { wabaId: 'WABA1' }, tokens: { refreshToken: null } });
    const sub = await c.subscribe(acct('whatsapp', 'PN1', r.settings));
    expect(sub?.id).toBe('WABA1');
    expect(new URL(c.getAuthUrl({ state: 's', challenge: 'c', redirectUri: 'https://app/cb' })).searchParams.get('config_id')).toBe('cfg');
  });

  it('states the business-number limitation to users', () => {
    expect(wa().notice).toMatch(/Personal WhatsApp accounts cannot be read/);
  });
});

describe('LinkedIn stub', () => {
  it('links the profile through OpenID Connect and syncs nothing', async () => {
    const f = fakeFetch([
      [/token/, () => ({ access_token: 'li', expires_in: 5_184_000, scope: 'openid profile email' })],
      [/userinfo/, () => ({ sub: 'member-1', name: 'Pat' })],
    ]);
    const c = new LinkedInConnector(new OAuthClient({ authUrl: 'https://li.test/auth', tokenUrl: 'https://li.test/token', clientId: 'c', clientSecret: 's' }, f), f);
    const r = await c.handleAuthCallback({ code: 'c', verifier: 'v', redirectUri: 'https://app/cb' });
    expect(r).toMatchObject({ externalId: 'member-1', displayName: 'Pat' });
    expect(new URL(c.getAuthUrl({ state: 's', challenge: 'c', redirectUri: 'https://app/cb' })).searchParams.get('scope')).toBe('openid profile email');
    expect(c.capabilities).toEqual({ read: false, send: false, calendar: false, realtime: false });
    expect((await c.incrementalSync(acct('linkedin', 'member-1'), 'none')).messages).toEqual([]);
    expect(c.notice).toMatch(/approved partners/);
  });
});
