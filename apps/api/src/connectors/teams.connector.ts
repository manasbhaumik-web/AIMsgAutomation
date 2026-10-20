import { GRAPH, GraphBase } from './graph';
import { getJson, mapLimit, sendJson } from './http';
import { outboundMessage } from './send';
import { OAuthClient } from './oauth';
import { htmlToText } from './text';
import { ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedMessage, ProviderError, SendRequest, SendResult, SyncResult, TokenSet } from './types';

const MAX_CHATS = 100;
const MAX_PAGES = 5;

interface GraphUser {
  id?: string;
  displayName?: string;
}
export interface TeamsChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  lastMessagePreview?: { createdDateTime?: string } | null;
  viewpoint?: { lastMessageReadDateTime?: string | null } | null;
  members?: { userId?: string; displayName?: string }[];
}
export interface TeamsMessage {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string | null;
  subject?: string | null;
  from?: { user?: GraphUser | null; application?: { displayName?: string } | null } | null;
  body?: { contentType?: string; content?: string };
  attachments?: { id?: string; name?: string; contentType?: string; contentUrl?: string }[];
}
type Cursor = Record<string, string>;

/**
 * Microsoft Teams chats (1:1, group and meeting chats) via delegated Graph. Channels need the admin-consent scope
 * ChannelMessage.Read.All and are left for a later decision. There is no push: delegated Graph change notifications
 * for chats need a subscription per chat with a one-hour lifetime, so the minute poll is the delivery path.
 */
export class TeamsConnector implements ChannelConnector {
  readonly id = 'teams' as const;
  readonly displayName = 'Microsoft Teams';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: false };
  readonly writeScope = 'ChatMessage.Send';
  readonly notice = 'Reads your Teams chats (not team channels). New messages appear within a few minutes. Work or school accounts only.';
  private readonly base: GraphBase;

  constructor(oauth: OAuthClient, private readonly f: FetchFn = fetch) {
    this.base = new GraphBase(oauth, f, '', ['Chat.Read']);
  }

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    return this.base.authUrl(a, a.write ? ['ChatMessage.Send'] : []);
  }

  /** Sends into the chat the thread belongs to, as the signed-in user. */
  async sendReply(acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const m = await sendJson<{ id?: string; createdDateTime?: string }>(this.f, 'POST', `${GRAPH}/me/chats/${encodeURIComponent(req.threadExternalId)}/messages`, acct.tokens.accessToken, {
      body: { contentType: 'text', content: req.text },
    });
    if (!m?.id) throw new ProviderError('Teams returned no message id', 502);
    const externalId = `${req.threadExternalId}:${m.id}`;
    return { externalId, message: outboundMessage({ channel: 'teams', externalId, threadExternalId: req.threadExternalId, subject: req.subject, to: req.to, text: req.text, at: m.createdDateTime ? new Date(m.createdDateTime) : undefined }) };
  }

  async handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const r = await this.base.callback(a);
    const me = await getJson<{ id?: string }>(this.f, `${GRAPH}/me?$select=id`, r.tokens.accessToken);
    return { ...r, settings: { userId: me.id ?? null } };
  }

  refreshToken(t: TokenSet): Promise<TokenSet> {
    return this.base.refresh(t);
  }

  initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    return this.run(acct, {}, since.toISOString());
  }

  incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    return this.run(acct, JSON.parse(cursor) as Cursor, new Date(Date.now() - 86_400_000).toISOString());
  }

  private async run(acct: ConnectorAccount, from: Cursor, floor: string): Promise<SyncResult> {
    const tok = acct.tokens.accessToken;
    const meId = (acct.settings?.userId as string | undefined) ?? '';
    const chats = await this.chats(tok);
    const next: Cursor = { ...from };
    const messages: NormalizedMessage[] = [];
    const deleted: string[] = [];

    // lastMessagePreview tells us which chats have anything new without reading every chat.
    const changed = chats.filter((c) => c.lastMessagePreview?.createdDateTime && c.lastMessagePreview.createdDateTime > (from[c.id] ?? floor));
    await mapLimit(changed, 4, async (chat) => {
      const since = from[chat.id] ?? floor;
      let url: string | undefined = `${GRAPH}/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=${encodeURIComponent(`lastModifiedDateTime gt ${since}`)}`;
      let newest = since;
      for (let i = 0; i < MAX_PAGES && url; i++) {
        const page: { value: TeamsMessage[]; '@odata.nextLink'?: string } = await getJson(this.f, url, tok);
        for (const m of page.value) {
          if (m.lastModifiedDateTime && m.lastModifiedDateTime > newest) newest = m.lastModifiedDateTime;
          const id = `${chat.id}:${m.id}`;
          if (m.deletedDateTime) deleted.push(id);
          else if (m.messageType === 'message') messages.push(teamsToMessage(m, chat, meId));
        }
        url = page['@odata.nextLink'];
      }
      next[chat.id] = newest;
    });
    return { messages, events: [], deletedExternalIds: deleted, cursor: JSON.stringify(next) };
  }

  private async chats(tok: string): Promise<TeamsChat[]> {
    const out: TeamsChat[] = [];
    let url: string | undefined = `${GRAPH}/me/chats?$expand=members,lastMessagePreview&$orderby=${encodeURIComponent('lastMessagePreview/createdDateTime desc')}&$top=50`;
    for (let i = 0; i < MAX_PAGES && url && out.length < MAX_CHATS; i++) {
      const page: { value: TeamsChat[]; '@odata.nextLink'?: string } = await getJson(this.f, url, tok);
      out.push(...page.value);
      url = page['@odata.nextLink'];
    }
    return out.slice(0, MAX_CHATS);
  }

  async revoke(): Promise<void> {
    // As with Outlook, delegated Microsoft tokens cannot be revoked by an API call; the user removes the app in their account.
  }
}

export function teamsToMessage(m: TeamsMessage, chat: TeamsChat, meId: string): NormalizedMessage {
  const others = (chat.members ?? []).filter((x) => x.userId !== meId).map((x) => x.displayName).filter((x): x is string => !!x);
  const subject = chat.topic || (others.length ? others.slice(0, 4).join(', ') + (others.length > 4 ? ` +${others.length - 4}` : '') : 'Teams chat');
  const html = m.body?.contentType?.toLowerCase() === 'html';
  const content = m.body?.content ?? '';
  const user = m.from?.user;
  const outbound = !!user?.id && user.id === meId;
  return {
    externalId: `${chat.id}:${m.id}`,
    threadExternalId: chat.id,
    subject,
    sender: user ? { name: user.displayName, handle: user.id } : m.from?.application ? { name: m.from.application.displayName ?? 'App' } : null,
    recipients: { to: (chat.members ?? []).filter((x) => x.userId !== meId).map((x) => ({ name: x.displayName, handle: x.userId })), cc: [] },
    bodyText: html ? htmlToText(content) : content,
    bodyHtml: html ? content : null,
    attachments: (m.attachments ?? []).map((a) => ({ name: a.name ?? 'attachment', mime: a.contentType ?? 'application/octet-stream', size: 0, externalRef: a.id ?? a.contentUrl ?? '' })),
    timestamp: new Date(m.createdDateTime ?? Date.now()),
    direction: outbound ? 'outbound' : 'inbound',
    isRead: outbound || (!!chat.viewpoint?.lastMessageReadDateTime && (m.createdDateTime ?? '') <= chat.viewpoint.lastMessageReadDateTime),
    rawRef: m.id,
  };
}
