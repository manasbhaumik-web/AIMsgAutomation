export const CHANNELS = ['gmail', 'google_calendar', 'outlook', 'microsoft_calendar', 'slack', 'teams', 'whatsapp', 'linkedin'] as const;
export type Channel = (typeof CHANNELS)[number];
export type FetchFn = typeof fetch;

/** A person on any channel. Mail and calendar parties have an email; chat parties have a channel-specific handle (Slack user id, phone number). */
export interface Party {
  name?: string;
  email?: string;
  handle?: string;
}

/** Best human-readable label for a party. */
export const partyLabel = (p: Party | null | undefined): string => p?.name || p?.email || p?.handle || 'Unknown';

export interface NormalizedMessage {
  externalId: string;
  threadExternalId: string;
  subject: string;
  sender: Party | null;
  recipients: { to: Party[]; cc: Party[] };
  bodyText: string;
  /** Unsanitized provider HTML. Ingestion sanitizes it before storage. */
  bodyHtml: string | null;
  attachments: { name: string; mime: string; size: number; externalRef: string }[];
  timestamp: Date;
  direction: 'inbound' | 'outbound';
  isRead: boolean;
  rawRef: string;
}

export interface NormalizedEvent {
  externalId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  timezone: string | null;
  organizer: Party | null;
  attendees: (Party & { response?: string })[];
  location: string | null;
  meetingLink: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms */
  expiresAt: number;
}

export interface ConnectorAccount {
  id: string;
  channel: Channel;
  externalId: string;
  tokens: TokenSet;
  backfillDays: number;
  /** Channel-specific, non-secret details captured at connect time (e.g. the WhatsApp business account id). */
  settings?: Record<string, unknown>;
}

export interface SyncResult {
  messages: NormalizedMessage[];
  events: NormalizedEvent[];
  deletedExternalIds: string[];
  cursor: string;
}

export interface Subscription {
  id: string;
  expiresAt: Date;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
  /** Exact bytes received. Signature schemes (Slack, Meta) are computed over these, never over re-serialized JSON. */
  rawBody?: Buffer;
}

export interface WebhookResult {
  /** Plain-text body to echo (Graph validation handshake). */
  response?: string;
  lookups: {
    externalId?: string;
    /** Matches every account whose external id starts with this (e.g. all users of one Slack workspace). */
    externalIdPrefix?: string;
    subscriptionId?: string;
    clientState?: string;
    /** Push-only channels (WhatsApp): verified event content to store durably for the account, since the provider has no history API. */
    payload?: unknown;
  }[];
}

export interface ConnectResult {
  tokens: TokenSet;
  externalId: string;
  displayName: string | null;
  scopes: string[];
  settings?: Record<string, unknown>;
}

/** What a reply needs. Recipients come from stored data on the server, never from the client. */
export interface SendRequest {
  threadExternalId: string;
  /** External id of the message being answered. */
  replyToExternalId: string;
  to: Party[];
  subject: string | null;
  text: string;
}
export interface SendResult {
  externalId: string;
  /** The sent message, when the provider gives enough to show it immediately. Otherwise the next sync brings it in. */
  message: NormalizedMessage | null;
}
export interface RsvpRequest {
  eventExternalId: string;
  response: 'accept' | 'decline' | 'tentative';
  comment?: string;
}

export interface ChannelConnector {
  readonly id: Channel;
  readonly displayName: string;
  readonly capabilities: { read: boolean; send: boolean; calendar: boolean; realtime: boolean };
  /** Limitation shown to users next to the channel (e.g. WhatsApp reads business numbers only). */
  readonly notice?: string;
  /** Tokens do not expire and have no refresh token (Slack, WhatsApp): connecting without a refresh token is fine. */
  readonly longLivedTokens?: boolean;
  /** `write` asks for the extra permissions needed to reply (mail/chat) or respond to invitations (calendar). Off by default. */
  getAuthUrl(a: { state: string; challenge: string; redirectUri: string; write?: boolean }): string;
  /** Scope that must appear in the account's granted scopes before sendReply / respondToEvent may be used. */
  readonly writeScope?: string;
  handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult>;
  refreshToken(tokens: TokenSet): Promise<TokenSet>;
  initialSync(acct: ConnectorAccount, since: Date): Promise<SyncResult>;
  incrementalSync(acct: ConnectorAccount, cursor: string): Promise<SyncResult>;
  /** Registers push notifications. Returns null when the provider or config cannot support it. */
  subscribe?(acct: ConnectorAccount, notifyUrl: string, clientState: string): Promise<Subscription | null>;
  /** Verifies provenance and extracts which accounts changed. Throws if the request is not genuine. */
  handleWebhook?(req: WebhookRequest): Promise<WebhookResult>;
  /** Answers the provider's subscription handshake (Meta GET challenge). Throws if the verify token is wrong. */
  verifyHandshake?(query: Record<string, string | undefined>): string;
  /**
   * Push-only channels have no history API: the only source is verified webhook payloads, stored durably by the
   * webhook endpoint and handed here by the sync worker.
   */
  ingestPushed?(acct: ConnectorAccount, payloads: unknown[]): SyncResult;
  /** Only called by the confirmed-send service after the user approved this exact text. */
  sendReply?(acct: ConnectorAccount, req: SendRequest): Promise<SendResult>;
  respondToEvent?(acct: ConnectorAccount, req: RsvpRequest): Promise<void>;
  revoke(acct: ConnectorAccount): Promise<void>;
}

/** The provider rejected our credentials: the user must reconnect. */
export class ProviderAuthError extends Error {
  constructor(message = 'Provider rejected the access token') {
    super(message);
  }
}

/** The incremental cursor is no longer valid: run a fresh initial sync. */
export class SyncResetError extends Error {}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number) {
    super(message);
  }
}
