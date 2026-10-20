import { GRAPH, GraphBase, followDelta } from './graph';
import { OAuthClient } from './oauth';
import { sendJson } from './http';
import { isEmail } from './send';
import { htmlToText } from './text';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedMessage, Party, ProviderError, SendRequest, SendResult, Subscription, SyncResetError, SyncResult,
  TokenSet, WebhookRequest, WebhookResult,
} from './types';

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}
export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  internetMessageId?: string;
}

const party = (r: Recipient): Party | null => (r.emailAddress?.address ? { email: r.emailAddress.address.toLowerCase(), ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}) } : null);
const parties = (rs?: Recipient[]): Party[] => (rs ?? []).map(party).filter((p): p is Party => p !== null);

/** Pure mapping from a Graph message to the unified model. `outbound` is true for items from Sent Items. */
export function parseGraphMessage(m: GraphMessage, outbound: boolean): NormalizedMessage {
  const isHtml = m.body?.contentType?.toLowerCase() === 'html';
  const content = m.body?.content ?? '';
  return {
    externalId: m.id,
    threadExternalId: m.conversationId ?? m.id,
    subject: m.subject ?? '',
    sender: m.from ? party(m.from) : null,
    recipients: { to: parties(m.toRecipients), cc: parties(m.ccRecipients) },
    bodyText: isHtml ? htmlToText(content) : content,
    bodyHtml: isHtml ? content : null,
    // Graph's delta feed does not expand attachments; per-attachment metadata arrives with the send/reply phase.
    attachments: [],
    timestamp: new Date((outbound ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime ?? m.sentDateTime ?? Date.now()),
    direction: outbound ? 'outbound' : 'inbound',
    isRead: outbound ? true : m.isRead ?? false,
    rawRef: m.internetMessageId ?? m.id,
  };
}

const SELECT = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,body,internetMessageId';
const FOLDERS = { inbox: 'inbox', sent: 'sentitems' } as const;
type Cursor = { inbox: string; sent: string };

export class OutlookConnector implements ChannelConnector {
  readonly id = 'outlook' as const;
  readonly displayName = 'Outlook';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: true };
  readonly writeScope = 'Mail.Send';
  private readonly base: GraphBase;

  constructor(oauth: OAuthClient, private readonly f: FetchFn = fetch) {
    this.base = new GraphBase(oauth, f, "me/mailFolders('inbox')/messages", ['Mail.Read']);
  }

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    return this.base.authUrl(a, a.write ? ['Mail.Send'] : []);
  }

  /**
   * Graph builds the reply draft, so we can check who it is really addressed to (Reply-To headers) before sending.
   * If that differs from what the user confirmed, the draft is deleted and nothing is sent.
   */
  async sendReply(acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const tok = acct.tokens.accessToken;
    const confirmed = new Set(req.to.map((p) => p.email?.toLowerCase()).filter(isEmail));
    const draft = await sendJson<{ id: string; toRecipients?: Recipient[] }>(this.f, 'POST', `${GRAPH}/me/messages/${encodeURIComponent(req.replyToExternalId)}/createReply`, tok, {});
    if (!draft?.id) throw new ProviderError('Graph returned no draft', 502);
    const actual = (draft.toRecipients ?? []).map((r) => r.emailAddress?.address?.toLowerCase());
    if (!actual.length || actual.some((a) => !a || !confirmed.has(a))) {
      await sendJson(this.f, 'DELETE', `${GRAPH}/me/messages/${encodeURIComponent(draft.id)}`, tok).catch(() => undefined);
      throw new ProviderError('The reply would go to a different address than the one you confirmed', 409);
    }
    await sendJson(this.f, 'PATCH', `${GRAPH}/me/messages/${encodeURIComponent(draft.id)}`, tok, { body: { contentType: 'text', content: req.text } });
    await sendJson(this.f, 'POST', `${GRAPH}/me/messages/${encodeURIComponent(draft.id)}/send`, tok);
    return { externalId: draft.id, message: null }; // the sent copy arrives from Sent Items on the next sync
  }
  handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    return this.base.callback(a);
  }
  refreshToken(t: TokenSet): Promise<TokenSet> {
    return this.base.refresh(t);
  }
  subscribe(acct: ConnectorAccount, url: string, state: string): Promise<Subscription | null> {
    return this.base.subscribe(acct, url, state);
  }
  handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    return this.base.handleWebhook(req);
  }

  async initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
    const url = (folder: string) => `${GRAPH}/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${filter}`;
    return this.run(acct, { inbox: url(FOLDERS.inbox), sent: url(FOLDERS.sent) });
  }

  async incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    return this.run(acct, JSON.parse(cursor) as Cursor);
  }

  private async run(acct: ConnectorAccount, from: Cursor): Promise<SyncResult> {
    const tok = acct.tokens.accessToken;
    const headers = { Prefer: 'odata.maxpagesize=50' };
    const messages: NormalizedMessage[] = [];
    const deleted: string[] = [];
    const next: Cursor = { inbox: '', sent: '' };
    for (const key of ['inbox', 'sent'] as const) {
      try {
        const r = await followDelta<GraphMessage>(this.f, from[key], tok, headers);
        for (const item of r.items) {
          if (item['@removed']) deleted.push(item.id);
          else messages.push(parseGraphMessage(item, key === 'sent'));
        }
        next[key] = r.cursor;
      } catch (e) {
        if (e instanceof ProviderError && (e.status === 410 || e.status === 404)) throw new SyncResetError('Graph delta token expired');
        throw e;
      }
    }
    return { messages, events: [], deletedExternalIds: deleted, cursor: JSON.stringify(next) };
  }

  async revoke(): Promise<void> {
    // Microsoft offers no token revocation endpoint for delegated tokens: the user removes the app at
    // account.microsoft.com/privacy/app-access. Local tokens are deleted by the caller.
  }
}
