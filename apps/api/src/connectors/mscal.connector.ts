import { sendJson } from './http';
import { GRAPH, GraphBase, followDelta } from './graph';
import { OAuthClient } from './oauth';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedEvent, Party, ProviderError, RsvpRequest, Subscription, SyncResetError, SyncResult,
  TokenSet, WebhookRequest, WebhookResult,
} from './types';

interface GraphEvent {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  showAs?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: { emailAddress?: { name?: string; address?: string }; status?: { response?: string } }[];
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
}

const FUTURE_DAYS = 90;

/** Requests use `Prefer: outlook.timezone="UTC"`, so `dateTime` values are UTC without a suffix. */
const utc = (s: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

export function parseGraphEvent(e: GraphEvent): NormalizedEvent | null {
  if (e.isCancelled || !e.start || !e.end) return null;
  const addr = (r?: { name?: string; address?: string }): Party | null => (r?.address ? { email: r.address.toLowerCase(), ...(r.name ? { name: r.name } : {}) } : null);
  return {
    externalId: e.id,
    title: e.subject || '(no title)',
    start: utc(e.start.dateTime),
    end: utc(e.end.dateTime),
    allDay: e.isAllDay ?? false,
    timezone: 'UTC',
    organizer: addr(e.organizer?.emailAddress),
    attendees: (e.attendees ?? []).flatMap((a) => {
      const p = addr(a.emailAddress);
      return p ? [{ ...p, response: a.status?.response }] : [];
    }),
    location: e.location?.displayName || null,
    meetingLink: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
    status: e.showAs === 'tentative' ? 'tentative' : 'confirmed',
  };
}

export class MicrosoftCalendarConnector implements ChannelConnector {
  readonly id = 'microsoft_calendar' as const;
  readonly displayName = 'Microsoft Calendar';
  readonly capabilities = { read: true, send: false, calendar: true, realtime: true };
  readonly writeScope = 'Calendars.ReadWrite';
  private readonly base: GraphBase;

  constructor(oauth: OAuthClient, private readonly f: FetchFn = fetch) {
    this.base = new GraphBase(oauth, f, 'me/events', ['Calendars.Read']);
  }

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    return this.base.authUrl(a, a.write ? ['Calendars.ReadWrite'] : []);
  }

  async respondToEvent(acct: ConnectorAccount, req: RsvpRequest): Promise<void> {
    const action = { accept: 'accept', decline: 'decline', tentative: 'tentativelyAccept' }[req.response];
    await sendJson(this.f, 'POST', `${GRAPH}/me/events/${encodeURIComponent(req.eventExternalId)}/${action}`, acct.tokens.accessToken, { comment: req.comment ?? '', sendResponse: true });
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

  initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    const end = new Date(Date.now() + FUTURE_DAYS * 86_400_000);
    const q = new URLSearchParams({ startDateTime: since.toISOString(), endDateTime: end.toISOString() });
    return this.run(acct, `${GRAPH}/me/calendarView/delta?${q}`);
  }

  incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    return this.run(acct, cursor);
  }

  private async run(acct: ConnectorAccount, url: string): Promise<SyncResult> {
    try {
      const r = await followDelta<GraphEvent>(this.f, url, acct.tokens.accessToken, { Prefer: 'odata.maxpagesize=50, outlook.timezone="UTC"' });
      const events: NormalizedEvent[] = [];
      const deleted: string[] = [];
      for (const item of r.items) {
        const ev = item['@removed'] ? null : parseGraphEvent(item);
        if (ev) events.push(ev);
        else deleted.push(item.id);
      }
      return { messages: [], events, deletedExternalIds: deleted, cursor: r.cursor };
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 410 || e.status === 404)) throw new SyncResetError('Graph delta token expired');
      throw e;
    }
  }

  async revoke(): Promise<void> {
    // See OutlookConnector.revoke: no delegated-token revocation endpoint exists.
  }
}
