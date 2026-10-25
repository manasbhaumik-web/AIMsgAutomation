import { randomUUID } from 'crypto';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, EventWrite, EventWriteResult, NormalizedEvent, RsvpRequest, SendRequest, SendResult, SyncResult, TokenSet,
} from './types';

/** Scope the demo accounts are created with, so every write path is exercised exactly as it is for a real account. */
export const DEMO_WRITE_SCOPE = 'demo.write';
const NOTICE = 'Demo mode: nothing is read from or sent to a real mailbox or calendar.';
const FAR = () => Date.now() + 365 * 86_400_000;

const empty = (cursor = 'demo'): SyncResult => ({ messages: [], events: [], deletedExternalIds: [], cursor });

/**
 * Stand-ins for Gmail and Google Calendar used only when DEMO_MODE=true (never allowed in production). They keep nothing:
 * a "sent" reply comes back as the outbound message and a "created" event as the event, which ingestion then stores,
 * so the whole confirm, approve and audit path can be tried from the UI without a provider account.
 */
export class DemoMailConnector implements ChannelConnector {
  readonly id = 'gmail' as const;
  readonly displayName = 'Gmail (demo)';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: false };
  readonly notice = NOTICE;
  readonly longLivedTokens = true;
  readonly writeScope = DEMO_WRITE_SCOPE;

  getAuthUrl(a: { redirectUri: string }): string {
    return `${a.redirectUri}?error=demo_mode`;
  }
  async handleAuthCallback(): Promise<ConnectResult> {
    throw new Error('Demo mode accounts are created with the demo data button, not by signing in.');
  }
  async refreshToken(t: TokenSet): Promise<TokenSet> {
    return { ...t, expiresAt: FAR() };
  }
  async initialSync(): Promise<SyncResult> {
    return empty();
  }
  async incrementalSync(): Promise<SyncResult> {
    return empty();
  }
  async sendReply(_acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const externalId = `demo-sent-${randomUUID()}`;
    return {
      externalId,
      message: {
        externalId, threadExternalId: req.threadExternalId, subject: req.subject ?? '', sender: { name: 'You', email: 'demo@example.com' },
        recipients: { to: req.to, cc: [] }, bodyText: req.text, bodyHtml: null, attachments: [], timestamp: new Date(), direction: 'outbound', isRead: true, rawRef: externalId,
      },
    };
  }
  async revoke(): Promise<void> {
    /* nothing to revoke */
  }
}

export class DemoCalendarConnector implements ChannelConnector {
  readonly id = 'google_calendar' as const;
  readonly displayName = 'Google Calendar (demo)';
  readonly capabilities = { read: true, send: false, calendar: true, realtime: false };
  readonly notice = NOTICE;
  readonly longLivedTokens = true;
  readonly writeScope = DEMO_WRITE_SCOPE;

  getAuthUrl(a: { redirectUri: string }): string {
    return `${a.redirectUri}?error=demo_mode`;
  }
  async handleAuthCallback(): Promise<ConnectResult> {
    throw new Error('Demo mode accounts are created with the demo data button, not by signing in.');
  }
  async refreshToken(t: TokenSet): Promise<TokenSet> {
    return { ...t, expiresAt: FAR() };
  }
  async initialSync(): Promise<SyncResult> {
    return empty();
  }
  async incrementalSync(): Promise<SyncResult> {
    return empty();
  }
  async respondToEvent(_acct: ConnectorAccount, _req: RsvpRequest): Promise<void> {
    /* accepted */
  }
  private event(externalId: string, ev: Partial<EventWrite>, base?: Partial<EventWrite>): NormalizedEvent {
    const m = { ...base, ...ev };
    return {
      externalId, title: m.title ?? '(no title)', start: m.start ?? new Date(), end: m.end ?? new Date(), allDay: m.allDay ?? false, timezone: m.timezone ?? 'UTC',
      organizer: { email: 'demo@example.com', name: 'You' }, attendees: (m.attendees ?? []).map((email) => ({ email, response: 'needsAction' })),
      location: m.location ?? null, meetingLink: null, status: 'confirmed',
    };
  }
  async createEvent(_acct: ConnectorAccount, ev: EventWrite): Promise<EventWriteResult> {
    const externalId = `demo-event-${randomUUID()}`;
    return { externalId, event: this.event(externalId, ev) };
  }
  async updateEvent(_acct: ConnectorAccount, externalId: string, patch: Partial<EventWrite>): Promise<EventWriteResult> {
    return { externalId, event: this.event(externalId, patch) };
  }
  async cancelEvent(): Promise<void> {
    /* removed */
  }
  async revoke(): Promise<void> {
    /* nothing to revoke */
  }
}
