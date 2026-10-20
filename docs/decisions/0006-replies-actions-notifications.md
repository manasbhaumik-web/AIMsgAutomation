# ADR 0006: Replies, calendar actions and notifications

**Status:** Accepted (Phase 5)

## Decisions
1. **Nothing is sent without the user's confirmation of the exact text.** The assistant writes a draft (`DraftService`, AI module) and can do nothing else: its constructor takes the database, the LLM gateway and the consent service, with no connector, registry or send service. Sending is `RepliesService.send`, which needs `confirm: true` and the sha256 of the body the client displayed. If the draft changed since, or a newer message arrived (unless acknowledged), nothing is sent. Calendar responses need `confirm: true` too. Both are enforced by request validation and covered by real-HTTP tests.
2. **Send permissions are opt-in at connect time.** Connecting asks for read access by default. "Allow replies and calendar responses" adds the write scope (Gmail `gmail.send`, Mail.Send, Slack `chat:write`, Teams `ChatMessage.Send`, Calendars.ReadWrite, Google `calendar.events`). An account whose granted scopes lack it reports `can_send: false` and the send call refuses. Existing read-only accounts are unchanged until the user chooses to reconnect.
3. **Recipients are derived on the server** from the stored conversation, shown on the confirmation screen, and never accepted from the client. Outlook builds the reply draft in Graph and aborts (deleting the draft) if Graph would address anyone other than the confirmed person (a Reply-To header cannot redirect a reply). Header values have line breaks removed. Slack text is entity-escaped so it cannot become a mention or link.
4. **Sending is synchronous and never retried automatically.** A queue retry could deliver a message twice. The draft is claimed with an atomic `draft -> sending` update (a double click or a second device sends once). On failure the draft becomes `failed` with an honest reason; an ambiguous network failure says the message may have been sent. The user confirms again to retry.
5. **WhatsApp**: free-form replies only inside the 24-hour customer-service window (checked before sending). Our own reply is stored locally because WhatsApp does not echo it. Template messages are not supported.
6. **Meeting-time suggestions are computed locally** from the user's synced events (working hours in their time zone, buffers, weekends off, daylight saving handled). No LLM call and no write to any calendar. Responses (accept, decline, tentative) change only the user's own attendee entry.
7. **Notifications**: a feed in the database plus optional push through FCM only (Android, and iOS through Firebase's APNs relay), so no Apple credentials live here. One notification per (thread, latest inbound message), never repeated; threads the user already answered are skipped; at most five pushes per scan; quiet hours supported. Push text carries no sender or subject unless the user turns on previews, because it passes through third-party servers. Notification rows hold no message content.
8. **Audit**: `reply.send`, `reply.send_failed`, `event.respond`, `event.respond_failed` are logged with channel and ids, never message text.
9. Assistant-written drafts count as derived AI data and are erased with it; drafts the user wrote or sent are kept.

## Consequences
- A user must reconnect an account once to enable replies. Google may require extra verification for `gmail.send` in production (sensitive scope).
- Web push (service worker) and native APNs are not implemented; the web app polls the feed every 30 seconds. Real-time streams (SSE/WebSocket) remain a later improvement.
- No daily send cap beyond rate limiting (15 sends per minute per user). Revisit with abuse data.
- Reply-all, editing recipients, attachments and creating new events are out of scope.
- Not exercised against live providers: all send and RSVP calls were built from provider documentation and tested with recorded-shape fixtures.
