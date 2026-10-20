# 03 Connectors

## Interface
```ts
interface ChannelConnector {
  id: string; displayName: string;
  capabilities: { read: boolean; send: boolean; calendar: boolean; realtime: boolean };
  getAuthUrl(user: UserRef, pkce: PkceChallenge): string;
  handleAuthCallback(code: string, state: string): Promise<ConnectedAccount>;
  refreshToken(account: ConnectedAccount): Promise<void>;
  initialSync(account: ConnectedAccount, since: Date): AsyncIterable<NormalizedItem>;
  incrementalSync(account: ConnectedAccount, cursor: string): Promise<{ items: NormalizedItem[]; cursor: string }>;
  handleWebhook(req: RawRequest): Promise<WebhookResult>; // verifies signature first
  sendReply?(account: ConnectedAccount, threadRef: string, content: ReplyContent): Promise<void>; // only if capabilities.send
  revoke(account: ConnectedAccount): Promise<void>;
}
```
Connectors register in a registry by `id`; the rest of the system never imports a concrete connector. LinkedIn is behind a feature flag.

## Unified models
- **Message**: id, user_id, channel, account_id, thread_id, sender, recipients, subject, body_text, body_html_sanitized, attachments_meta, timestamp, direction, is_read, raw_ref.
- **Event**: id, title, start, end, timezone, organizer, attendees, location/meeting_link, status, source.

HTML is sanitised server-side (allow-list) before storage. Items are idempotent on (account_id, external_id).

## Per-channel plan
| Channel | Auth/scopes (minimal) | Sync | Realtime | Limits |
|---|---|---|---|---|
| Gmail | Google OAuth; `gmail.readonly`, add `gmail.send` only when replies are enabled | `history.list` with historyId cursor | `users.watch` to Pub/Sub push (renew weekly) | Restricted scopes need Google verification + CASA assessment; use test users until then |
| Google Calendar | `calendar.readonly`, later `calendar.events` | syncToken | watch channels (expire, renew) | Same OAuth app |
| Outlook mail | Entra multi-tenant app; `Mail.Read`, later `Mail.Send` | Graph delta queries | change notifications | Subscriptions expire (max about 3 days), renewal job |
| Microsoft Calendar | `Calendars.Read`, later `Calendars.ReadWrite` | delta | change notifications | Same renewal job |
| Teams | `Chat.Read`, `ChannelMessage.Read.All` | delta polling fallback | protected-API notifications if approved | Needs Microsoft approval and often tenant admin consent |
| Slack | OAuth v2 user token; `channels:history`, `im:history`, etc. | `conversations.history` with oldest cursor | Events API (signing secret) | Rate tiers; one app, installed per workspace |
| WhatsApp | Meta Business Cloud API | webhooks only | `X-Hub-Signature-256` | **No personal-account access.** Only messages to a registered business number. UI must say so. No unofficial libraries |
| LinkedIn | Sign-in/profile only | none | none | Messaging APIs are partner-only. Stub behind a flag. Optional: parse LinkedIn notification emails from the user's mailbox |

## Operational jobs
- Subscription renewal (Graph, Gmail watch, Google channels) on a schedule, with alerts on failure.
- Token refresh with a per-account lock (Redis) to avoid refresh races.
- Rate-limit aware backoff per provider; accounts in `reauth` state surface in the client.
- Each connector gets a README (scopes, registration steps, webhook setup, limits) in Phase 2 and later.

## Testing
Unit tests use recorded fixtures only; CI never calls real provider APIs.
