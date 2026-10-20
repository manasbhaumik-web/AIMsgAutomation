# ADR 0005: Chat connectors (Slack, Teams, WhatsApp Business, LinkedIn)

**Status:** Accepted (Phase 4)

## Decisions
1. **Same `ChannelConnector` contract, widened for chat.** `Party.email` became optional and gained `handle` (Slack user id, phone number, Entra object id). A channel can declare `notice` (a limitation shown in the UI) and `longLivedTokens` (no refresh token needed). Connect results can carry non-secret `settings` (the WhatsApp business account id).
2. **Slack uses a user token, with polling plus the Events API as a nudge.** Events carry only "team T changed", which maps to every connected user of that team through a prefix lookup (`sys_find_accounts_prefix`, using `starts_with`, not LIKE). Content is always read by the sync job. Slack history cannot show edits or deletions, and history rate limits for distributed apps outside the Marketplace are severe; both are documented in the connectors README.
3. **Teams is poll-only.** Delegated notifications for chats need per-chat subscriptions with very short lifetimes, and "all chats" resources need application permissions behind Microsoft's protected-API approval. Team channels are excluded because they need admin-consented `ChannelMessage.Read.All`. Revisit when there is a tenant to test against.
4. **WhatsApp content is stored by the webhook endpoint.** The Cloud API has no history, so "verify then only enqueue" would lose messages if the queue were lost. The verified payload is encrypted and written to `webhook_inbox` (RLS by user) through `sys_push_webhook_event`, a definer function that resolves tenant and user itself, so the unauthenticated endpoint cannot choose whose inbox it writes to. The sync worker converts the events and deletes the rows. Only business numbers are supported; no unofficial library is used.
5. **Signatures are verified over the raw request bytes** (`rawBody: true` in Nest): Slack `v0` HMAC with a 5-minute window, and Meta `X-Hub-Signature-256`. Comparison is constant-time, and a missing secret rejects everything. A real-HTTP test signs a non-canonical body to prove the raw bytes are used.
6. **LinkedIn is a profile-only stub behind `LINKEDIN_ENABLED`.** Its messaging APIs are partner-only.

## Consequences
- Slack, Teams and WhatsApp messages flow through the same ingestion, AI pipeline and inbox as mail. The AI sees phone numbers and Slack ids as handles, and redaction masks phone-like values.
- WhatsApp messages sent before connecting are unrecoverable. Paused accounts accumulate encrypted events until resumed.
- Not verified against live providers: the redirect-based WhatsApp Embedded Signup and its business-account lookup, Teams `lastMessagePreview` ordering, and Slack Events payload variants. Fixtures were written from provider documentation; add recorded payloads as they are captured.
