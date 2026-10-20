# Connectors (Gmail, Google Calendar, Outlook, Microsoft Calendar; Slack, Teams, WhatsApp Business, LinkedIn stub)

Every channel implements `ChannelConnector` (`types.ts`) and is registered in `registry.ts` only when its provider credentials exist in `.env`. All read-only in this phase. Sending arrives in Phase 5 with its own, narrower consent.

## How a sync works
1. **Connect:** `POST /accounts/:channel/connect` returns the provider URL (PKCE; the verifier travels in a signed 10-minute state bound to the user). After consent the client posts `code` and `state` to `POST /accounts/callback`. Tokens are stored envelope-encrypted.
2. **Initial sync:** last `backfill_days` (default 14), capped at 2,000 messages per run. The incremental cursor is captured before listing so nothing is missed.
3. **Incremental sync:** Gmail `history.list` (historyId), Google Calendar `syncToken`, Graph delta links (mail has one per folder; the cursor is a JSON pair).
4. **Triggers:** provider push (when `PUBLIC_API_URL` is HTTPS) enqueues a sync; a one-minute tick also syncs any account idle for two minutes, so missed webhooks only add latency.
5. **Failure handling:** a rejected token marks the account `reauth` (no retries, user reconnects). Anything else is retried with exponential backoff (BullMQ) and the last error is shown on the account. An expired cursor falls back to a fresh initial sync.
6. **Renewal:** accounts whose push subscription expires within 12 hours are renewed by the tick. If push cannot be set up the account is rechecked after an hour (error) or a week (not configured).

## Google (Gmail + Calendar), one Google Cloud project
1. Google Cloud Console: create a project, enable **Gmail API** and **Google Calendar API**.
2. OAuth consent screen: External, add test users while unverified.
3. Credentials: OAuth client ID, type **Web application**. Authorized redirect URIs: `${WEB_URL}/connect/callback` (and `${WEB_URL}/auth/callback` for sign-in; add the mobile deep link if used).
4. `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

| Channel | Scopes requested | Notes |
|---|---|---|
| Gmail | `openid email gmail.readonly` | `gmail.readonly` is a **restricted** scope: public launch needs Google verification plus an annual CASA security assessment. Until then only listed test users can connect, and refresh tokens expire after 7 days in "Testing" status. |
| Google Calendar | `openid email calendar.readonly` | Sensitive scope (verification, no CASA). Grants are incremental: connecting Calendar after Gmail keeps both. |

**Gmail push (optional):** create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the Publisher role, create a **push** subscription to `${PUBLIC_API_URL}/api/v1/webhooks/google-pubsub` with OIDC authentication (service account + audience). Set `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PUBSUB_SERVICE_ACCOUNT`. Watches last 7 days; the renewal job re-registers them.
**Calendar push:** automatic when `PUBLIC_API_URL` is HTTPS. The channel token is a per-account HMAC checked on every notification. Channels last under 7 days and are recreated by the renewal job.

Known limits: the calendar sync covers the primary calendar, from the backfill start to 90 days ahead. Recurring events are expanded within that window. Spam, trash and drafts are skipped. Gmail history older than about a week forces a fresh initial sync.

## Microsoft (Outlook + Calendar), one Entra app
1. Entra admin center, App registrations, New: supported account types **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI (Web): `${WEB_URL}/connect/callback` (and `${WEB_URL}/auth/callback` for sign-in).
3. Certificates & secrets: create a client secret. `.env`: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.
4. API permissions (delegated): `User.Read`, `offline_access`, `Mail.Read`, `Calendars.Read`. Work/school tenants may require admin consent; users in those tenants see a request-approval screen.

Push: Graph change notifications go to `${PUBLIC_API_URL}/api/v1/webhooks/graph`. The endpoint answers the `validationToken` handshake and checks the per-account `clientState` on every notification. Mail and calendar subscriptions last up to about 70 hours; the renewal job re-creates them.

Known limits: Inbox and Sent Items only (other folders later). Attachment names are not captured from the delta feed yet. Microsoft has no revocation endpoint for delegated tokens, so disconnecting deletes our copy and the user removes the app at account.microsoft.com/privacy/app-access for full revocation.

## Slack (user token, one Slack app)
1. api.slack.com/apps, Create New App. **OAuth & Permissions**: add redirect URL `${WEB_URL}/connect/callback`. Under **User Token Scopes** add: `channels:history groups:history im:history mpim:history channels:read groups:read im:read mpim:read users:read`. No bot scopes are needed; reply sending (`chat:write`) is requested in Phase 5.
2. **Event Subscriptions** (optional but recommended): Request URL `${PUBLIC_API_URL}/api/v1/webhooks/slack`. Under *Subscribe to events on behalf of users* add `message.channels`, `message.groups`, `message.im`, `message.mpim`.
3. `.env`: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (Basic Information). Without the signing secret every webhook is rejected and sync is polling only.
4. Distribution: keep the app **internal to one workspace** for self-hosted use. Slack limits `conversations.history` and `conversations.replies` heavily for commercially distributed apps that are not in the Slack Marketplace; internal customer-built apps are exempt. Plan for Marketplace review before offering this to other workspaces.

How it maps: a Slack thread (or a lone top-level message) in a channel is one thread; a DM or group DM is one thread per conversation. Webhooks only say "something changed in team T": the sync job reads the history. Cursor: newest timestamp per conversation, plus the last reply seen in each thread active in the last 7 days (replies never appear in channel history).
Known limits: up to 100 conversations per account per pass; edits and deletions of messages already imported are not noticed (Slack history does not report them); files are listed, never downloaded.

## Microsoft Teams (same Entra app as Outlook)
1. Add the delegated permission `Chat.Read` to the Entra app. Work or school accounts only (personal Microsoft accounts have no Teams chats API). Many tenants require admin consent for `Chat.Read`.
2. No other configuration: it reuses `MICROSOFT_CLIENT_ID/SECRET`.

How it works: `/me/chats` with `lastMessagePreview` shows which chats changed; only those are read, filtered by `lastModifiedDateTime`. Edits are caught and deletions are removed. Read state comes from the chat `viewpoint`.
**No push.** Delegated change notifications for chats need one subscription per chat with a very short lifetime, and the "all chats" resources need application permissions that fall under Microsoft's *protected APIs* approval. The one-minute poll is the delivery path, so messages appear within a few minutes. Team **channels** need `ChannelMessage.Read.All` (admin consent) and are not included; adding them is a product decision.

## WhatsApp Business (Cloud API; business numbers only)
Personal WhatsApp accounts cannot be read: there is no official API, and unofficial libraries are not used (they violate WhatsApp's terms and get numbers banned). This connects a **WhatsApp Business number** and receives the messages customers send to it.
1. Create a Meta app (type Business) with the WhatsApp product and complete Business Verification. Serving other businesses means being a **Tech Provider** and passing App Review for `whatsapp_business_management` and `whatsapp_business_messaging`.
2. Create a **Facebook Login for Business configuration** for Embedded Signup and note its id. Add `${WEB_URL}/connect/callback` as a valid OAuth redirect URI.
3. WhatsApp > Configuration: callback URL `${PUBLIC_API_URL}/api/v1/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages`.
4. `.env`: `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_CONFIG_ID`, `WHATSAPP_VERIFY_TOKEN`, optionally `WHATSAPP_API_VERSION`.

How it works: the Cloud API has **no history endpoint**, so a message exists only as a webhook event. The endpoint verifies `X-Hub-Signature-256` over the raw body, writes the event encrypted into `webhook_inbox` for the owning account (the one exception to "webhooks only enqueue": there is nothing to re-fetch later), then queues a sync. The sync worker converts the events, ingests them and deletes the rows. Meta redeliveries are harmless (upsert by message id). Messages are visible only from the moment of connection. One thread per customer phone number. Media is listed by id, never downloaded. Replies are only possible inside WhatsApp's 24-hour customer-service window (Phase 5).
Not verified against live Meta: the redirect-based Embedded Signup and the `debug_token` lookup used to find the shared business account. Test with a Meta test number first.

## LinkedIn (feature-flagged stub, `LINKEDIN_ENABLED=true`)
LinkedIn's messaging APIs are restricted to approved partners; an ordinary app cannot read a member's inbox. The stub offers **Sign in with LinkedIn (OpenID Connect)** only: it links the profile (`openid profile email`) and imports no messages. `.env`: `LINKEDIN_ENABLED=true`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`; redirect URL `${WEB_URL}/connect/callback`. Becoming a LinkedIn partner is a business process; once approved, the work is a new `initialSync`/`incrementalSync` in `linkedin.connector.ts`. Meanwhile, LinkedIn notification emails already arrive through the connected mailbox.

## Replying and responding (opt-in)
Connecting asks for read access only. Ticking "Also allow replies and calendar responses" (or "Allow replies…" on an existing account) reconnects with the extra scope below. Until then the account reports `can_send: false` and every send is refused.

| Channel | Extra permission | How a reply is sent |
|---|---|---|
| Gmail | `gmail.send` (sensitive; Google verification applies in production) | `messages.send` with `In-Reply-To`/`References` from the original, in its thread |
| Outlook | `Mail.Send` | Graph `createReply` draft, address checked against the confirmed recipient, text set, then sent |
| Slack | user scope `chat:write` | `chat.postMessage` as the user, into the thread; text is entity-escaped |
| Teams | `ChatMessage.Send` | `POST /me/chats/{id}/messages` |
| WhatsApp | none beyond the Embedded Signup grant | Cloud API text message, only within 24 hours of the customer's last message |
| Google Calendar | `calendar.events` | `events.patch` on the user's own attendee entry (`sendUpdates=all`) |
| Microsoft Calendar | `Calendars.ReadWrite` | `accept`, `decline`, `tentativelyAccept` actions |

Add the same permissions to the provider app registrations (Google consent screen, Entra API permissions, Slack user token scopes). `sendReply` and `respondToEvent` are called only by `RepliesService` / `CalendarActionsService` after the user's confirmation; never call them from AI code. Replies go to the sender of the latest incoming message; reply-all, editing recipients and attachments are not supported.

## Tests
Fixture-driven (`connectors.spec.ts`, `chat.spec.ts`): no test calls a real provider. Pure parsers (`parseGmailMessage`, `parseGoogleEvent`, `parseGraphMessage`, `parseGraphEvent`) take recorded payload shapes. When a provider response format surprises us in production, add the payload as a new fixture first.
