import { createHmac, timingSafeEqual } from 'crypto';
import { outboundMessage } from './send';
import {
  ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, NormalizedMessage, ProviderAuthError, ProviderError, SendRequest, SendResult, Subscription, SyncResult, TokenSet,
  WebhookRequest, WebhookResult,
} from './types';

const FAR_FUTURE = Number.MAX_SAFE_INTEGER;
const TEN_YEARS_MS = 10 * 365 * 86_400_000;

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  voice?: { id?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  location?: { name?: string; address?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}
/** The `value` object of a `messages` change in a WhatsApp Business webhook. */
export interface WaChangeValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
}

/**
 * WhatsApp Business Platform (Cloud API). Only messages sent to a registered business number can be read; a personal
 * WhatsApp account has no official API and no unofficial library is used. The API has no history endpoint, so messages
 * exist only as verified webhook events, which the endpoint stores (encrypted) and `ingestPushed` converts.
 */
export class WhatsAppConnector implements ChannelConnector {
  readonly id = 'whatsapp' as const;
  readonly displayName = 'WhatsApp Business';
  readonly capabilities = { read: true, send: true, calendar: false, realtime: true };
  /** Granted by the Embedded Signup configuration itself, so no separate opt-in screen exists on Meta's side. */
  readonly writeScope = 'whatsapp_business_messaging';
  readonly longLivedTokens = true;
  readonly notice = 'Business numbers only. Personal WhatsApp accounts cannot be read: WhatsApp offers no official way to do that. Messages appear from the moment the number is connected; earlier history is not available.';

  constructor(
    private readonly cfg: { appId: string; appSecret: string; configId: string; verifyToken?: string; version: string },
    private readonly f: FetchFn = fetch,
  ) {}

  private get graph(): string {
    return `https://graph.facebook.com/${this.cfg.version}`;
  }

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string }): string {
    // Embedded Signup through Facebook Login for Business: the config id selects the WhatsApp permissions.
    const u = new URL(`https://www.facebook.com/${this.cfg.version}/dialog/oauth`);
    u.search = new URLSearchParams({
      client_id: this.cfg.appId, redirect_uri: a.redirectUri, state: a.state, response_type: 'code', config_id: this.cfg.configId, override_default_response_type: 'true',
    }).toString();
    return u.toString();
  }

  async handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const t = await this.get<{ access_token?: string }>('/oauth/access_token', { client_id: this.cfg.appId, client_secret: this.cfg.appSecret, redirect_uri: a.redirectUri, code: a.code });
    if (!t.access_token) throw new ProviderAuthError('Meta returned no access token');
    // Which business account the user shared is only visible in the token's granular scopes.
    const dbg = await this.get<{ data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] } }>('/debug_token', { input_token: t.access_token, access_token: `${this.cfg.appId}|${this.cfg.appSecret}` });
    const waba = dbg.data?.granular_scopes?.find((s) => s.scope === 'whatsapp_business_management')?.target_ids?.[0];
    if (!waba) throw new ProviderAuthError('No WhatsApp Business account was shared with this app');
    const nums = await this.get<{ data?: { id: string; display_phone_number?: string; verified_name?: string }[] }>(`/${waba}/phone_numbers`, { fields: 'id,display_phone_number,verified_name', access_token: t.access_token });
    const num = nums.data?.[0];
    if (!num) throw new ProviderAuthError('The WhatsApp Business account has no phone number');
    return {
      tokens: { accessToken: t.access_token, refreshToken: null, expiresAt: FAR_FUTURE },
      externalId: num.id,
      displayName: [num.verified_name, num.display_phone_number].filter(Boolean).join(' · ') || null,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
      settings: { wabaId: waba, displayPhone: num.display_phone_number ?? null },
    };
  }

  /**
   * Free-form text, which WhatsApp only allows within 24 hours of the customer's last message (the send service
   * enforces that before calling). Template messages outside the window are not supported.
   */
  async sendReply(acct: ConnectorAccount, req: SendRequest): Promise<SendResult> {
    const res = await this.f(`${this.graph}/${acct.externalId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${acct.tokens.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: req.threadExternalId, type: 'text', text: { preview_url: false, body: req.text } }),
    });
    if (res.status === 401) throw new ProviderAuthError();
    if (!res.ok) throw new ProviderError(`graph.facebook.com responded ${res.status}`, res.status);
    const j = (await res.json()) as { messages?: { id: string }[] };
    const id = j.messages?.[0]?.id;
    if (!id) throw new ProviderError('WhatsApp returned no message id', 502);
    // WhatsApp never echoes our own messages back, so this local copy is the only record of the reply.
    return { externalId: id, message: outboundMessage({ channel: 'whatsapp', externalId: id, threadExternalId: req.threadExternalId, subject: req.subject, to: req.to, text: req.text }) };
  }

  /** Business tokens from Embedded Signup do not expire; if Meta revokes one the next call fails and the user reconnects. */
  async refreshToken(t: TokenSet): Promise<TokenSet> {
    return t;
  }

  /** Subscribes the business account to this app. The callback URL itself is configured once in the Meta app dashboard. */
  async subscribe(acct: ConnectorAccount): Promise<Subscription | null> {
    const waba = acct.settings?.wabaId as string | undefined;
    if (!waba) return null;
    const res = await this.f(`${this.graph}/${waba}/subscribed_apps`, { method: 'POST', headers: { authorization: `Bearer ${acct.tokens.accessToken}` } });
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError();
    if (!res.ok) throw new ProviderError(`graph.facebook.com responded ${res.status}`, res.status);
    return { id: waba, expiresAt: new Date(Date.now() + TEN_YEARS_MS) };
  }

  // No history API exists: nothing to pull. Content arrives through ingestPushed.
  async initialSync(): Promise<SyncResult> {
    return { messages: [], events: [], deletedExternalIds: [], cursor: 'push' };
  }
  async incrementalSync(): Promise<SyncResult> {
    return { messages: [], events: [], deletedExternalIds: [], cursor: 'push' };
  }

  ingestPushed(acct: ConnectorAccount, payloads: unknown[]): SyncResult {
    const messages: NormalizedMessage[] = [];
    for (const p of payloads as WaChangeValue[]) {
      const names = new Map((p.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? '']));
      for (const m of p.messages ?? []) {
        const n = waToMessage(m, names.get(m.from) || undefined, p.metadata?.display_phone_number);
        if (n) messages.push(n);
      }
    }
    return { messages, events: [], deletedExternalIds: [], cursor: 'push' };
  }

  /** Meta's subscription handshake (GET with hub.* parameters). */
  verifyHandshake(q: Record<string, string | undefined>): string {
    const expected = this.cfg.verifyToken;
    const given = q['hub.verify_token'] ?? '';
    if (!expected || q['hub.mode'] !== 'subscribe' || !safeEqual(given, expected) || !q['hub.challenge']) throw new ProviderAuthError('Verification failed');
    return q['hub.challenge'];
  }

  /** `X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>` */
  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    if (!req.rawBody) throw new ProviderAuthError('Rejected WhatsApp request');
    const expected = `sha256=${createHmac('sha256', this.cfg.appSecret).update(req.rawBody).digest('hex')}`;
    if (!safeEqual(sig, expected)) throw new ProviderAuthError('Rejected WhatsApp request');
    const body = req.body as { object?: string; entry?: { changes?: { field?: string; value?: WaChangeValue }[] }[] };
    if (body.object !== 'whatsapp_business_account') return { lookups: [] };
    const lookups: WebhookResult['lookups'] = [];
    for (const e of body.entry ?? []) {
      for (const c of e.changes ?? []) {
        const id = c.value?.metadata?.phone_number_id;
        // Delivery/read receipts (`statuses`) carry no message content and are ignored.
        if (c.field === 'messages' && id && c.value?.messages?.length) lookups.push({ externalId: id, payload: c.value });
      }
    }
    return { lookups };
  }

  async revoke(acct: ConnectorAccount): Promise<void> {
    const waba = acct.settings?.wabaId as string | undefined;
    if (waba) await this.f(`${this.graph}/${waba}/subscribed_apps`, { method: 'DELETE', headers: { authorization: `Bearer ${acct.tokens.accessToken}` } });
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await this.f(`${this.graph}${path}?${new URLSearchParams(params)}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new ProviderAuthError('Meta rejected the request');
    if (!res.ok) throw new ProviderError(`graph.facebook.com responded ${res.status}`, res.status);
    return (await res.json()) as T;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function waToMessage(m: WaMessage, contactName: string | undefined, businessNumber: string | undefined): NormalizedMessage | null {
  if (m.type === 'reaction') return null; // reactions carry no content of their own
  const media = m.image ?? m.video ?? m.audio ?? m.voice ?? m.sticker ?? m.document;
  const caption = m.image?.caption ?? m.video?.caption ?? m.document?.caption;
  let text: string;
  switch (m.type) {
    case 'text': text = m.text?.body ?? ''; break;
    case 'button': text = m.button?.text ?? ''; break;
    case 'interactive': text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ''; break;
    case 'location': text = ['[Location]', m.location?.name, m.location?.address].filter(Boolean).join(' '); break;
    case 'contacts': text = '[Shared a contact]'; break;
    case 'image': case 'video': case 'audio': case 'voice': case 'sticker': case 'document':
      text = caption ? `[${m.type}] ${caption}` : `[${m.type}]`; break;
    default: text = '[Unsupported message type]';
  }
  const phone = `+${m.from}`;
  return {
    externalId: m.id,
    threadExternalId: m.from,
    subject: contactName ? `${contactName} (${phone})` : phone,
    sender: { name: contactName, handle: phone },
    recipients: { to: businessNumber ? [{ handle: businessNumber }] : [], cc: [] },
    bodyText: text,
    bodyHtml: null,
    // Media is not downloaded: fetching it needs a short-lived URL and the user's token, and is a separate decision.
    attachments: media?.id ? [{ name: (m.document?.filename ?? m.type), mime: media.mime_type ?? 'application/octet-stream', size: 0, externalRef: media.id }] : [],
    timestamp: new Date(Number(m.timestamp) * 1000),
    direction: 'inbound',
    isRead: false,
    rawRef: m.id,
  };
}
