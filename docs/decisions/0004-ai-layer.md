# ADR 0004: AI layer, retrieval and consent

**Status:** Accepted (Phase 3)

## Decisions
1. **Opt-in per user, enforced in the data path.** `ConsentService.require` guards every AI endpoint; the pipeline and the sweep function `sys_accounts_pending_ai` both skip users without an active `ai_processing` consent. Withdrawing erases derived data unless the user keeps it. Rationale: GDPR/PDPA purpose limitation, because AI sends message text to a third party.
2. **Fixed 1536-dimension vectors, one model at a time.** `vector(1536)` column; adapters request that width (`dimensions` for OpenAI, `outputDimensionality` for Gemini). The gateway rejects other widths with an actionable error. Each row records its model; search and "pending" detection compare against the currently routed embed model, so switching models triggers a background re-embed and never mixes vector spaces. The embed route cannot have a fallback for the same reason.
3. **Exact, per-user vector search; no ANN index.** An HNSW index is global, and filtering by user after the index scan can silently return too few rows when other users' vectors are nearer. Exact search over one user's rows is complete and trivially isolated. Revisit with partitioning or pgvector iterative scans past a few hundred thousand messages per user.
4. **Hybrid retrieval with reciprocal rank fusion.** Vector rank plus full-text rank (match-any, ranked by overlap) so exact names, invoice numbers and addresses still hit when embeddings miss them, and the system degrades to keyword search if embeddings are unavailable. `websearch_to_tsquery` was rejected because it requires every word to match, which fails on natural-language questions.
5. **Analysis is structured, validated and idempotent.** One `topic-tag` call per changed thread returns JSON (topics, priority, action items) validated with zod. Invalid output is recorded as `failed` against the thread's last-message time and not retried until the thread changes. Open action items are regenerated; completed ones are kept.
6. **The assistant is read-only.** No tools, no actions. Citations are the intersection of markers in the answer and sources actually supplied, so fabricated sources are dropped. Replies are drafted in Phase 5 behind an explicit confirm step.
7. **Redaction runs in the gateway for every call**, including embeddings and streams (a `StreamRestorer` handles placeholders split across chunks). Dates and times are excluded from redaction so context stays readable.
8. **SSE over fetch for streaming.** `EventSource` cannot send the bearer header; the client reads the stream with `fetch`. The server waits for the first event before sending headers, so consent/ownership/validation failures are ordinary HTTP errors.
9. **Added OpenAI-compatible (OpenAI, xAI) and Gemini adapters now**, because Anthropic cannot embed and the user chose Gemini, OpenAI and Grok.

## Consequences
- Until an admin configures an embed route and a chat route, AI endpoints answer with a plain "not set up" message and search is keyword-only.
- Re-embedding cost scales with mailbox size when the embed model changes.
- Mid-stream provider failures cannot fall back to another model; the user retries.
- Digest/chat quotes of deleted accounts persist until AI data is erased (documented in the UI and the AI README).
