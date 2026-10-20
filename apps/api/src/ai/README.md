# AI layer (Phase 3)

Embeddings, topics and priority, action items, summaries, the daily digest, and the chat assistant. Every model call goes through `LlmGateway`; nothing in this folder names a vendor.

## Admin setup (Admin console)
1. **Providers:** add at least one. Anthropic, OpenAI, Google (Gemini) and xAI (Grok) adapters exist. Azure OpenAI and Ollama are still planned.
2. **Routes:** assign a provider and model to each task.

| Task | Used for | Notes |
|---|---|---|
| `embed` | message vectors, query vectors | **Must be OpenAI, Gemini or xAI** (Anthropic has no embeddings API). No fallback is allowed: vectors from different models are not comparable. The model must return **1536 dimensions**: OpenAI `text-embedding-3-small` (or `-large`, shortened to 1536) and Gemini `gemini-embedding-001` (shortened) both work. |
| `topic-tag` | topics, priority, action items per thread | Small, fast model. JSON output. |
| `summarize` | thread / channel / topic summaries | Mid model. |
| `digest` | daily digest | Mid model. |
| `chat` | the assistant | Strongest model. Streams. |
| `classify`, `draft-reply` | reserved (Phase 5 for drafting) | |

3. **Prompts:** version 1 of `topic-tag`, `summarize`, `digest` and `chat` is seeded by migration 003. Edit them as new versions in the console and activate. Variables in `{{double braces}}` must all be supplied or the call is refused. Do not remove the "untrusted data" wording.
4. **Quotas:** a global or per-user `tokens_per_day` limit stops AI work quietly (the pipeline pauses; chat explains).

Changing the `embed` model re-embeds every message in the background; until a message is re-embedded, only keyword search finds it.

## User opt-in and data handling
- AI is **off until the user turns it on** (`consents` row, purpose `ai_processing`). Without it the pipeline does nothing and every AI endpoint answers `403 ai_consent_required`.
- Per account, "Allow AI features" can be switched off: that account is skipped by embedding, analysis, summaries, digests, retrieval and chat.
- Before text leaves the system, email addresses, phone numbers and long digit runs are replaced by placeholders and restored in the answer. Dates and times are left alone.
- Turning AI off erases derived data by default (`DELETE /me/ai-data` does it on demand): vectors, topics, priorities, action items, summaries, digests and chats. Mail and accounts are untouched.
- Deleting an account with its data also deletes summaries derived from it. Past digests and chat answers may still quote it until AI data is erased.

## How it works
- **Pipeline** (`pipeline.service.ts`): after each sync, and from a one-minute tick, embed messages that lack a vector for the current model, then analyze threads that are new or changed since last analyzed. Unusable model output is stored as `failed` and not retried until the thread changes; provider errors are retried by the queue.
- **Retrieval** (`retrieval.service.ts`): exact cosine search over the caller's own vectors for the current model, plus match-any full-text search, merged with reciprocal rank fusion. If embeddings are unavailable it falls back to keywords. Always filtered by user (and by RLS) and by the account AI switch.
- **Chat** (`chat.service.ts`): top 8 messages plus the next two weeks of events are numbered `[M1]`, `[E1]`, and the model must cite them. Only markers that exist become citations. The assistant has no tools: it cannot send, delete or change anything.
- **Prompt injection:** message text is untrusted. It is placed inside delimiter tags, tag-closing sequences are neutralized, system prompts say so, outputs are validated (JSON schema for analysis, known-marker filter for citations), and no model output triggers an action.
- **Digest:** last 24 hours of activity, today and tomorrow in the user's time zone, open action items due within three days. Generated on demand or at the user's chosen hour.

## Limits
- Search is an exact per-user scan, intended for mailboxes up to a few hundred thousand messages.
- Only the first 6,000 characters of a message are embedded; threads are summarized from their latest 12 to 30 messages.
- Stopping a chat in the browser stops the server loop, but the upstream provider request is not cancelled, so the tokens it was already generating are still billed.
- Attachment contents are not read.
- Costs appear in the usage ledger only if the route has per-million-token prices set.

## Reply drafts (Phase 5)
The `draft-reply` route (strongest model recommended) and its v1 prompt write a reply to the latest message. `DraftService` stores the result as an editable draft and has no way to send it: sending is a separate, confirmed step in `replies/` (see ADR 0006). The prompt tells the model the conversation is untrusted, to invent no facts, links or numbers, and to output only the reply text. Thread text goes through `neutralize()`; the user's optional guidance is limited to 500 characters. The user always reads the draft, and the exact recipient, before it can be sent. Assistant drafts are erased with other AI data when the user turns AI off.
