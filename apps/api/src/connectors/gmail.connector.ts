import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getJson, mapLimit, sendJson } from './http';
import { OAuthClient, emailFromIdToken } from './oauth';
import { buildMime, isEmail, outboundMessage, replySubject } from './send';
import { htmlToText, parseAddressList } from './text';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedMessage, ProviderError, SendRequest, SendResult, Subscription, SyncResetError, SyncResult,
  TokenSet, WebhookRequest, WebhookResult, ProviderAuthError,
} from './types';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const MAX_INITIAL = 2000;

interface GPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
  headers?: { name: string; value: string }[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart;
}

const b64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/** Pure mapping from a Gmail `format=full` message to the unified model. */
export function parseGmailMessage(m: GmailMessage): NormalizedMessage {
  const headers = new Map((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  let text = '';
  let html = '';
  const attachments: NormalizedMessage['attachments'] = [];
  const walk = (p: GPart) => {
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ name: p.filename, mime: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? 0, externalRef: p.body.attachmentId });
    } else if (p.mimeType === 'text/plain' && p.body?.data && !text) text = b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64(p.body.data);
    p.parts?.forEach(walk);
  };
  if (m.payload) walk(m.payload);
  const labels = new Set(m.labelIds ?? []);
  const date = headers.get('date');
  const ts = m.internalDate ? new Date(Number(m.internalDate)) : date ? new Date(date) : new Date();
  return {
    externalId: m.id,
    threadExternalId: m.threadId,
    subject: headers.get('subject') ?? '',
    sender: parseAddressList(headers.get('from'))[0] ?? null,
    recipients: { to: parseAddressList(headers.get('to')), cc: parseAddressList(headers.get('cc')) },
    bodyText: text || (html ? htmlToText(html) : ''),
    bodyHtml: html || null,
    attachments,
    timestamp: ts,
    direction: labels.has('SENT') ? 'outbound' : 'inbound',
    isRead: !labels.has('UNREAD'),
    rawRef: m.id,
  };
}

export class GmailConnector implements ChannelConnector {
  readonly id = 'gmail' as const;
  readonly displayName = 'Gmail';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: true };
  readonly writeScope = GMAIL_SEND_SCOPE;

  constructor(
    private readonly oauth: OAuthClient,
    private readonly cfg: { pubsubTopic?: string; pubsubAudience?: string; pubsubServiceAccount?: string } = {},
    private readonly f: FetchFn = fetch,
  ) {}

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    return this.oauth.authUrl({ scopes: a.write ? [...GMAIL_SCOPES, GMAIL_SEND_SCOPE] : GMAIL_SCOPES, state: a.state, challenge: a.challenge, redirectUri: a.redirectUri });
  }

  /** Replies to the sender of one message, in its thread, with the RFC 822 threading headers Gmail needs. */
  async sendReply(acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const tok = acct.tokens.accessToken;
    const to = req.to.map((p) => p.email).filter(isEmail);
    if (!to.length) throw new ProviderError('No valid recipient address', 422);
    const q = new URLSearchParams({ format: 'metadata' });
    for (const h of ['Message-ID', 'References']) q.append('metadataHeaders', h);
    const orig = await getJson<{ payload?: { headers?: { name: string; value: string }[] } }>(this.f, `${API}/messages/${encodeURIComponent(req.replyToExternalId)}?${q}`, tok);
    const hv = (n: string) => orig.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
    const msgId = hv('Message-ID');
    const raw = buildMime({ to, subject: replySubject(req.subject), inReplyTo: msgId, references: [hv('References'), msgId].filter(Boolean).join(' ') || undefined, text: req.text });
    const sent = await sendJson<{ id: string; threadId?: string }>(this.f, 'POST', `${API}/messages/send`, tok, { raw: Buffer.from(raw).toString('base64url'), threadId: req.threadExternalId });
    if (!sent?.id) throw new ProviderError('Gmail returned no message id', 502);
    return { externalId: sent.id, message: outboundMessage({ channel: 'gmail', externalId: sent.id, threadExternalId: sent.threadId ?? req.threadExternalId, subject: replySubject(req.subject), to: req.to, text: req.text }) };
  }

  async handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const r = await this.oauth.exchange(a);
    const { email, name } = emailFromIdToken(r.idToken);
    if (!email) throw new ProviderAuthError('Google did not return an email address');
    return { tokens: r.tokens, externalId: email.toLowerCase(), displayName: name, scopes: r.scope };
  }

  refreshToken(t: TokenSet): Promise<TokenSet> {
    return this.oauth.refresh(t);
  }

  async initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    const tok = acct.tokens.accessToken;
    // Read the history id first: anything arriving during the listing is then caught by the next incremental run.
    const profile = await getJson<{ historyId: string }>(this.f, `${API}/profile`, tok);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: `after:${Math.floor(since.getTime() / 1000)}`, maxResults: '100' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await getJson<{ messages?: { id: string }[]; nextPageToken?: string }>(this.f, `${API}/messages?${q}`, tok);
      ids.push(...(page.messages ?? []).map((x) => x.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_INITIAL);
    const messages = await this.fetchMessages(tok, ids.slice(0, MAX_INITIAL));
    return { messages: messages.found, events: [], deletedExternalIds: [], cursor: profile.historyId };
  }

  async incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    const tok = acct.tokens.accessToken;
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let latest = cursor;
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ startHistoryId: cursor, maxResults: '500' });
      for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) q.append('historyTypes', t);
      if (pageToken) q.set('pageToken', pageToken);
      let page: {
        history?: { messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }[];
        nextPageToken?: string;
        historyId?: string;
      };
      try {
        page = await getJson(this.f, `${API}/history?${q}`, tok);
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) throw new SyncResetError('Gmail history expired');
        throw e;
      }
      for (const h of page.history ?? []) {
        for (const x of [...(h.messagesAdded ?? []), ...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(x.message.id);
        for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id);
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const id of deleted) changed.delete(id);
    const r = await this.fetchMessages(tok, [...changed]);
    return { messages: r.found, events: [], deletedExternalIds: [...deleted, ...r.missing], cursor: latest };
  }

  private async fetchMessages(tok: string, ids: string[]): Promise<{ found: NormalizedMessage[]; missing: string[] }> {
    const found: NormalizedMessage[] = [];
    const missing: string[] = [];
    await mapLimit(ids, 8, async (id) => {
      try {
        const m = await getJson<GmailMessage>(this.f, `${API}/messages/${id}?format=full`, tok);
        const labels = m.labelIds ?? [];
        if (labels.includes('SPAM') || labels.includes('TRASH') || labels.includes('DRAFT')) missing.push(id);
        else found.push(parseGmailMessage(m));
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404) missing.push(id);
        else throw e;
      }
    });
    return { found, missing };
  }

  async subscribe(acct: ConnectorAccount): Promise<Subscription | null> {
    if (!this.cfg.pubsubTopic) return null;
    const r = await sendJson<{ expiration: string }>(this.f, 'POST', `${API}/watch`, acct.tokens.accessToken, { topicName: this.cfg.pubsubTopic, labelIds: ['INBOX', 'SENT'] });
    return r ? { id: 'gmail-watch', expiresAt: new Date(Number(r.expiration)) } : null;
  }

  /** Pub/Sub push: verify the Google-signed OIDC token, then read the mailbox address from the message. */
  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    const { pubsubAudience, pubsubServiceAccount } = this.cfg;
    if (!pubsubAudience || !pubsubServiceAccount) throw new ProviderAuthError('Pub/Sub push is not configured');
    const auth = String(req.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) throw new ProviderAuthError('Missing push token');
    const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    const { payload } = await jwtVerify(auth.slice(7), jwks, { audience: pubsubAudience, issuer: ['https://accounts.google.com', 'accounts.google.com'] }).catch(() => {
      throw new ProviderAuthError('Invalid push token');
    });
    if (payload.email !== pubsubServiceAccount || payload.email_verified !== true) throw new ProviderAuthError('Unexpected push sender');
    const data = (req.body as { message?: { data?: string } })?.message?.data;
    if (!data) return { lookups: [] };
    const j = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as { emailAddress?: string };
    return { lookups: j.emailAddress ? [{ externalId: j.emailAddress }] : [] };
  }

  async revoke(acct: ConnectorAccount): Promise<void> {
    await this.f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.tokens.refreshToken ?? acct.tokens.accessToken)}`, { method: 'POST' }).catch(() => undefined);
  }
}
