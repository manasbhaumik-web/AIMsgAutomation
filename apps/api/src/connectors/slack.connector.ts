import { createHmac, timingSafeEqual } from 'crypto';
import { mapLimit } from './http';
import { outboundMessage } from './send';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedMessage, Party, ProviderAuthError, ProviderError, SendRequest, SendResult, SyncResult, TokenSet,
  WebhookRequest, WebhookResult,
} from './types';

const API = 'https://slack.com/api';
// User-token scopes: read-only. chat:write arrives with reply sending in Phase 5 (incremental consent).
export const SLACK_USER_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'];
export const SLACK_WRITE_SCOPE = 'chat:write';
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;
const MAX_CONVERSATIONS = 100;
const MAX_TRACKED_THREADS = 60;
const THREAD_WINDOW_SEC = 7 * 86_400;
const MAX_PAGES = 5;
const MAX_NAMES = 200;
const SIGNATURE_TOLERANCE_SEC = 300;
// Messages with these subtypes carry content; everything else (joins, topic changes, pins...) is channel noise.
const CONTENT_SUBTYPES = new Set([undefined, 'thread_broadcast', 'me_message', 'file_share', 'bot_message']);

interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [k: string]: unknown;
}
interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
}
export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: { id: string; name?: string; mimetype?: string; size?: number }[];
}

/** Cursor: newest ts seen per conversation, and the last reply seen in each recently active thread. */
interface Cursor {
  c: Record<string, string>;
  t: Record<string, string>;
}

const tsToDate = (ts: string) => new Date(parseFloat(ts) * 1000);
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'invalid_refresh_token']);

export class SlackConnector implements ChannelConnector {
  readonly id = 'slack' as const;
  readonly displayName = 'Slack';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: true };
  readonly writeScope = SLACK_WRITE_SCOPE;
  readonly longLivedTokens = true;
  readonly notice = 'Reads the channels, direct messages and group messages you belong to. Slack limits how fast apps outside the Slack Marketplace can read history, so large workspaces sync slowly.';

  constructor(private readonly cfg: { clientId: string; clientSecret: string; signingSecret?: string }, private readonly f: FetchFn = fetch) {}

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    // Slack's OAuth v2 has no PKCE; the signed state (bound to the user) protects the exchange.
    const u = new URL('https://slack.com/oauth/v2/authorize');
    u.search = new URLSearchParams({ client_id: this.cfg.clientId, user_scope: (a.write ? [...SLACK_USER_SCOPES, SLACK_WRITE_SCOPE] : SLACK_USER_SCOPES).join(','), redirect_uri: a.redirectUri, state: a.state }).toString();
    return u.toString();
  }

  async handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const r = await this.oauth({ code: a.code, redirect_uri: a.redirectUri });
    const user = r.authed_user as { id?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } | undefined;
    const team = r.team as { id?: string; name?: string } | undefined;
    if (!user?.access_token || !user.id || !team?.id) throw new ProviderAuthError('Slack returned no user token');
    return {
      tokens: { accessToken: user.access_token, refreshToken: user.refresh_token ?? null, expiresAt: user.expires_in ? Date.now() + user.expires_in * 1000 : FAR_FUTURE },
      externalId: `${team.id}:${user.id}`,
      displayName: team.name ?? null,
      scopes: (user.scope ?? '').split(',').filter(Boolean),
    };
  }

  async refreshToken(t: TokenSet): Promise<TokenSet> {
    if (!t.refreshToken) return t; // non-rotating token: valid until revoked
    const r = await this.oauth({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
    // Token rotation responses are top-level, unlike the install response.
    const access = (r.access_token as string | undefined) ?? (r.authed_user as { access_token?: string } | undefined)?.access_token;
    if (!access) throw new ProviderAuthError('Slack returned no access token');
    return { accessToken: access, refreshToken: (r.refresh_token as string | undefined) ?? t.refreshToken, expiresAt: Date.now() + ((r.expires_in as number | undefined) ?? 43_200) * 1000 };
  }

  private async oauth(extra: Record<string, string>): Promise<SlackResponse> {
    const res = await this.f(`${API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...extra }),
    });
    if (!res.ok) throw new ProviderError(`slack.com responded ${res.status}`, res.status);
    const j = (await res.json()) as SlackResponse;
    if (!j.ok) throw new ProviderAuthError('Slack rejected the authorization');
    return j;
  }

  async initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    return this.run(acct, { c: {}, t: {} }, String(Math.floor(since.getTime() / 1000)));
  }

  async incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    const parsed = JSON.parse(cursor) as Cursor;
    return this.run(acct, { c: parsed.c ?? {}, t: parsed.t ?? {} }, '0');
  }

  private async run(acct: ConnectorAccount, from: Cursor, defaultOldest: string): Promise<SyncResult> {
    const token = acct.tokens.accessToken;
    const me = acct.externalId.split(':')[1];
    const convs = (await this.conversations(token)).slice(0, MAX_CONVERSATIONS);
    const next: Cursor = { c: { ...from.c }, t: { ...from.t } };
    const raw: { conv: SlackConversation; msg: SlackMessage; threadSubject?: string }[] = [];
    const lastRead = new Map<string, string>();

    await mapLimit(convs, 4, async (conv) => {
      const oldest = from.c[conv.id] ?? defaultOldest;
      const msgs = await this.history(token, conv.id, oldest);
      if (!msgs.length) return;
      next.c[conv.id] = msgs.reduce((m, x) => (parseFloat(x.ts) > parseFloat(m) ? x.ts : m), oldest);
      const info = await this.call('conversations.info', token, { channel: conv.id }).catch(() => null);
      lastRead.set(conv.id, ((info?.channel as { last_read?: string } | undefined)?.last_read) ?? '0');
      for (const msg of msgs) {
        raw.push({ conv, msg });
        // A thread that has replies is followed from now on, starting from its beginning.
        if ((msg.reply_count ?? 0) > 0 && (!msg.thread_ts || msg.thread_ts === msg.ts)) next.t[`${conv.id}:${msg.ts}`] ??= '0';
      }
    });

    // Replies never appear in conversation history; poll recently active threads for them.
    const now = Date.now() / 1000;
    for (const key of Object.keys(next.t)) if (now - parseFloat(key.split(':')[1]) > THREAD_WINDOW_SEC) delete next.t[key];
    const tracked = Object.keys(next.t).sort((a, b) => parseFloat(b.split(':')[1]) - parseFloat(a.split(':')[1])).slice(0, MAX_TRACKED_THREADS);
    for (const key of Object.keys(next.t)) if (!tracked.includes(key)) delete next.t[key];
    const convById = new Map(convs.map((c) => [c.id, c]));
    await mapLimit(tracked, 4, async (key) => {
      const [channel, threadTs] = key.split(':');
      const conv = convById.get(channel);
      if (!conv) return;
      const replies = await this.replies(token, channel, threadTs, next.t[key]);
      const fresh = replies.filter((m) => m.ts !== threadTs && parseFloat(m.ts) > parseFloat(next.t[key]));
      if (!fresh.length) return;
      const parent = replies.find((m) => m.ts === threadTs);
      if (!lastRead.has(channel)) {
        const info = await this.call('conversations.info', token, { channel }).catch(() => null);
        lastRead.set(channel, ((info?.channel as { last_read?: string } | undefined)?.last_read) ?? '0');
      }
      if (parent && !raw.some((r) => r.conv.id === channel && r.msg.ts === threadTs)) raw.push({ conv, msg: parent });
      for (const m of fresh) raw.push({ conv, msg: m, threadSubject: parent?.text });
      next.t[key] = fresh.reduce((m, x) => (parseFloat(x.ts) > parseFloat(m) ? x.ts : m), next.t[key]);
    });

    const content = raw.filter((r) => CONTENT_SUBTYPES.has(r.msg.subtype) && (r.msg.text || r.msg.files?.length));
    const names = await this.resolveNames(token, content.flatMap((r) => [r.msg.user, r.conv.user, ...[...(r.msg.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1])]).filter((x): x is string => !!x));
    const seen = new Set<string>();
    const messages: NormalizedMessage[] = [];
    for (const r of content) {
      const m = slackToMessage(r.msg, r.conv, me, names, lastRead.get(r.conv.id) ?? '0', r.threadSubject);
      if (seen.has(m.externalId)) continue;
      seen.add(m.externalId);
      messages.push(m);
    }
    return { messages, events: [], deletedExternalIds: [], cursor: JSON.stringify(next) };
  }

  private async conversations(token: string): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.call('users.conversations', token, { types: 'public_channel,private_channel,mpim,im', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) });
      out.push(...((r.channels as SlackConversation[]) ?? []));
      cursor = r.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return out;
  }

  private async history(token: string, channel: string, oldest: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      let r: SlackResponse;
      try {
        r = await this.call('conversations.history', token, { channel, oldest, limit: '100', ...(cursor ? { cursor } : {}) });
      } catch (e) {
        if (e instanceof SkippableConversation) return out; // left the channel or lost access since the list call
        throw e;
      }
      out.push(...((r.messages as SlackMessage[]) ?? []));
      cursor = r.has_more ? r.response_metadata?.next_cursor ?? '' : '';
      if (!cursor) break;
    }
    return out;
  }

  private async replies(token: string, channel: string, ts: string, oldest: string): Promise<SlackMessage[]> {
    try {
      const r = await this.call('conversations.replies', token, { channel, ts, oldest, limit: '100' });
      return (r.messages as SlackMessage[]) ?? [];
    } catch (e) {
      if (e instanceof SkippableConversation) return [];
      throw e;
    }
  }

  private async resolveNames(token: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].slice(0, MAX_NAMES);
    const out = new Map<string, string>();
    await mapLimit(unique, 4, async (id) => {
      const r = await this.call('users.info', token, { user: id }).catch(() => null);
      const u = r?.user as { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const name = u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name;
      if (name) out.set(id, name);
    });
    return out;
  }

  /** Slack reports most problems as HTTP 200 with ok:false. */
  private async call(method: string, token: string, params: Record<string, string>): Promise<SlackResponse> {
    const res = await this.f(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    if (res.status === 429) throw new ProviderError('slack.com rate limited', 429, Number(res.headers.get('retry-after')) || 30);
    if (!res.ok) throw new ProviderError(`slack.com responded ${res.status}`, res.status);
    const j = (await res.json()) as SlackResponse;
    if (j.ok) return j;
    if (AUTH_ERRORS.has(j.error ?? '')) throw new ProviderAuthError();
    if (j.error === 'ratelimited') throw new ProviderError('slack.com rate limited', 429, 30);
    if (['channel_not_found', 'not_in_channel', 'thread_not_found', 'user_not_found'].includes(j.error ?? '')) throw new SkippableConversation();
    throw new ProviderError(`slack ${method}: ${j.error ?? 'unknown error'}`, 400);
  }

  /** Posts as the user. Channel threads reply into the Slack thread; DMs and group DMs post to the conversation. */
  async sendReply(acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const [channel, threadTs] = req.threadExternalId.split(':');
    // Entities, not markup: nothing in the text can become a mention, channel ping or link target.
    const text = req.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const r = await this.call('chat.postMessage', acct.tokens.accessToken, { channel, text, unfurl_links: 'false', link_names: 'false', ...(threadTs ? { thread_ts: threadTs } : {}) });
    const ts = r.ts as string | undefined;
    if (!ts) throw new ProviderError('Slack returned no timestamp', 502);
    const externalId = `${channel}:${ts}`;
    return { externalId, message: outboundMessage({ channel: 'slack', externalId, threadExternalId: req.threadExternalId, subject: req.subject, to: req.to, text: req.text, at: tsToDate(ts) }) };
  }

  async revoke(acct: ConnectorAccount): Promise<void> {
    await this.call('auth.revoke', acct.tokens.accessToken, {});
  }

  /** Events API: https://api.slack.com/authentication/verifying-requests-from-slack */
  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    const secret = this.cfg.signingSecret;
    const h = (n: string) => String(req.headers[n] ?? '');
    const ts = h('x-slack-request-timestamp');
    const sig = h('x-slack-signature');
    if (!secret || !req.rawBody || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_SEC) throw new ProviderAuthError('Rejected Slack request');
    const expected = `v0=${createHmac('sha256', secret).update(`v0:${ts}:`).update(req.rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ProviderAuthError('Rejected Slack request');

    const body = req.body as { type?: string; challenge?: string; team_id?: string; authorizations?: { user_id?: string; team_id?: string }[]; event?: { type?: string } };
    if (body.type === 'url_verification' && typeof body.challenge === 'string') return { response: body.challenge, lookups: [] };
    if (body.type !== 'event_callback' || !body.team_id || !body.event?.type?.startsWith('message')) return { lookups: [] };
    const users = (body.authorizations ?? []).filter((x) => x.user_id).map((x) => x.user_id!);
    return { lookups: users.length ? users.map((u) => ({ externalId: `${body.team_id}:${u}` })) : [{ externalIdPrefix: `${body.team_id}:` }] };
  }
}

class SkippableConversation extends Error {}

/** Slack text markup to plain text: <@U1> mentions, <#C1|name> channels, <url|label> links and HTML entities. */
export function slackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function slackToMessage(msg: SlackMessage, conv: SlackConversation, me: string, names: Map<string, string>, lastRead: string, threadParentText?: string): NormalizedMessage {
  const outbound = msg.user === me;
  const label = conv.is_im ? `Direct message with ${names.get(conv.user ?? '') ?? conv.user ?? 'unknown'}` : conv.is_mpim ? `Group message ${conv.name ?? ''}`.trim() : `#${conv.name ?? conv.id}`;
  const isThreaded = !conv.is_im && !conv.is_mpim;
  const threadTs = msg.thread_ts ?? msg.ts;
  const text = slackText(msg.text ?? '', names);
  const parentText = threadParentText !== undefined ? slackText(threadParentText, names) : msg.thread_ts && msg.thread_ts !== msg.ts ? '' : text;
  // Channels: one thread per Slack thread, titled by its first message. DMs: one thread per conversation.
  const subject = isThreaded && parentText ? `${label} · ${parentText.replace(/\s+/g, ' ').slice(0, 60)}` : label;
  const sender: Party | null = msg.user
    ? { name: names.get(msg.user), handle: msg.user }
    : msg.bot_id || msg.username ? { name: msg.username ?? 'App', handle: msg.bot_id } : null;
  return {
    externalId: `${conv.id}:${msg.ts}`,
    threadExternalId: isThreaded ? `${conv.id}:${threadTs}` : conv.id,
    subject,
    sender: sender && sender.name === undefined ? { handle: sender.handle } : sender,
    recipients: { to: conv.is_im && conv.user && conv.user !== me ? [{ name: names.get(conv.user), handle: conv.user }] : [], cc: [] },
    bodyText: text,
    bodyHtml: null,
    attachments: (msg.files ?? []).map((f) => ({ name: f.name ?? 'file', mime: f.mimetype ?? 'application/octet-stream', size: f.size ?? 0, externalRef: f.id })),
    timestamp: tsToDate(msg.ts),
    direction: outbound ? 'outbound' : 'inbound',
    isRead: outbound || parseFloat(msg.ts) <= parseFloat(lastRead),
    rawRef: `${conv.id}:${msg.ts}`,
  };
}
