import { randomUUID } from 'crypto';
import { getJson, sendJson } from './http';
import { OAuthClient, emailFromIdToken } from './oauth';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, EventWrite, EventWriteResult, FetchFn, NormalizedEvent, ProviderAuthError, ProviderError, RsvpRequest, Subscription, SyncResetError,
  SyncResult, TokenSet, WebhookRequest, WebhookResult,
} from './types';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary';
export const GCAL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'];
export const GCAL_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const FUTURE_DAYS = 90;

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

/** Returns null for cancelled events or events without a usable start. */
export function parseGoogleEvent(e: GEvent): NormalizedEvent | null {
  if (e.status === 'cancelled' || !e.start) return null;
  const allDay = !e.start.dateTime;
  const start = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00Z`);
  const end = new Date(e.end?.dateTime ?? `${e.end?.date ?? e.start.date}T00:00:00Z`);
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  return {
    externalId: e.id,
    title: e.summary ?? '(no title)',
    start,
    end,
    allDay,
    timezone: e.start.timeZone ?? null,
    organizer: e.organizer?.email ? { email: e.organizer.email.toLowerCase(), ...(e.organizer.displayName ? { name: e.organizer.displayName } : {}) } : null,
    attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ email: a.email!.toLowerCase(), ...(a.displayName ? { name: a.displayName } : {}), response: a.responseStatus })),
    location: e.location ?? null,
    meetingLink: e.hangoutLink ?? video ?? null,
    status: e.status === 'tentative' ? 'tentative' : 'confirmed',
  };
}

export class GoogleCalendarConnector implements ChannelConnector {
  readonly id = 'google_calendar' as const;
  readonly displayName = 'Google Calendar';
  readonly capabilities = { read: true, send: false, calendar: true, realtime: true };
  readonly writeScope = GCAL_WRITE_SCOPE;

  constructor(private readonly oauth: OAuthClient, private readonly f: FetchFn = fetch) {}

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string {
    return this.oauth.authUrl({ scopes: a.write ? [...GCAL_SCOPES, GCAL_WRITE_SCOPE] : GCAL_SCOPES, state: a.state, challenge: a.challenge, redirectUri: a.redirectUri });
  }

  /** Updates only the user's own attendee entry; other attendees are sent back unchanged. */
  async respondToEvent(acct: ConnectorAccount, req: RsvpRequest): Promise<void> {
    const tok = acct.tokens.accessToken;
    const url = `${API}/events/${encodeURIComponent(req.eventExternalId)}`;
    const ev = await getJson<{ attendees?: { email?: string; self?: boolean; responseStatus?: string; comment?: string }[] }>(this.f, url, tok);
    const me = ev.attendees?.find((a) => a.self);
    if (!me) throw new ProviderError('You are not an invited attendee of this event', 422);
    const status = { accept: 'accepted', decline: 'declined', tentative: 'tentative' }[req.response];
    const attendees = ev.attendees!.map((a) => (a.self ? { ...a, responseStatus: status, ...(req.comment ? { comment: req.comment } : {}) } : a));
    await sendJson(this.f, 'PATCH', `${url}?sendUpdates=all`, tok, { attendees });
  }

  /** Request body for Google Calendar from the fields the user supplied. Only the fields present are sent, so a patch changes nothing else. */
  private body(ev: Partial<EventWrite>): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (ev.title !== undefined) b.summary = ev.title;
    if (ev.location !== undefined) b.location = ev.location ?? '';
    if (ev.description !== undefined) b.description = ev.description ?? '';
    if (ev.start && ev.end) {
      if (ev.allDay) {
        b.start = { date: ev.start.toISOString().slice(0, 10) };
        b.end = { date: ev.end.toISOString().slice(0, 10) };
      } else {
        b.start = { dateTime: ev.start.toISOString(), ...(ev.timezone ? { timeZone: ev.timezone } : {}) };
        b.end = { dateTime: ev.end.toISOString(), ...(ev.timezone ? { timeZone: ev.timezone } : {}) };
      }
    }
    if (ev.attendees) b.attendees = ev.attendees.map((email) => ({ email }));
    return b;
  }

  async createEvent(acct: ConnectorAccount, ev: EventWrite): Promise<EventWriteResult> {
    const made = await sendJson<GEvent>(this.f, 'POST', `${API}/events?sendUpdates=all`, acct.tokens.accessToken, this.body(ev));
    if (!made?.id) throw new ProviderError('Google did not return the new event', 502);
    return { externalId: made.id, event: parseGoogleEvent(made) };
  }

  async updateEvent(acct: ConnectorAccount, externalId: string, patch: Partial<EventWrite>): Promise<EventWriteResult> {
    const made = await sendJson<GEvent>(this.f, 'PATCH', `${API}/events/${encodeURIComponent(externalId)}?sendUpdates=all`, acct.tokens.accessToken, this.body(patch));
    return { externalId, event: made ? parseGoogleEvent(made) : null };
  }

  async cancelEvent(acct: ConnectorAccount, externalId: string): Promise<void> {
    await sendJson(this.f, 'DELETE', `${API}/events/${encodeURIComponent(externalId)}?sendUpdates=all`, acct.tokens.accessToken);
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

  initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult> {
    const timeMax = new Date(Date.now() + FUTURE_DAYS * 86_400_000);
    return this.list(acct.tokens.accessToken, { timeMin: since.toISOString(), timeMax: timeMax.toISOString() });
  }

  async incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult> {
    try {
      return await this.list(acct.tokens.accessToken, { syncToken: cursor });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 410) throw new SyncResetError('Calendar sync token expired');
      throw e;
    }
  }

  private async list(tok: string, extra: Record<string, string>): Promise<SyncResult> {
    const events: NormalizedEvent[] = [];
    const deleted: string[] = [];
    let pageToken: string | undefined;
    let next = '';
    do {
      const q = new URLSearchParams({ singleEvents: 'true', maxResults: '250', showDeleted: 'true', ...extra });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await getJson<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(this.f, `${API}/events?${q}`, tok);
      for (const item of page.items ?? []) {
        const ev = parseGoogleEvent(item);
        if (ev) events.push(ev);
        else deleted.push(item.id);
      }
      pageToken = page.nextPageToken;
      next = page.nextSyncToken ?? next;
    } while (pageToken);
    return { messages: [], events, deletedExternalIds: deleted, cursor: next };
  }

  /** Calendar watch channels cannot be renewed in place: create a new one; the old one expires on its own. */
  async subscribe(acct: ConnectorAccount, notifyUrl: string, clientState: string): Promise<Subscription | null> {
    const id = randomUUID();
    const expiration = Date.now() + 6 * 86_400_000;
    await sendJson(this.f, 'POST', `${API}/events/watch`, acct.tokens.accessToken, { id, type: 'web_hook', address: notifyUrl, token: clientState, expiration });
    return { id, expiresAt: new Date(expiration) };
  }

  /** Google sends channel id + our token in headers. The token is verified against the account after lookup. */
  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    const channel = String(req.headers['x-goog-channel-id'] ?? '');
    const token = String(req.headers['x-goog-channel-token'] ?? '');
    if (!channel || !token) throw new ProviderAuthError('Missing channel headers');
    return { lookups: [{ subscriptionId: channel, clientState: token }] };
  }

  async revoke(acct: ConnectorAccount): Promise<void> {
    await this.f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.tokens.refreshToken ?? acct.tokens.accessToken)}`, { method: 'POST' }).catch(() => undefined);
  }
}
