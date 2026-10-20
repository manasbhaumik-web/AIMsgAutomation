# ADR 0003: Sync, ingestion and background jobs

**Status:** Accepted (Phase 2)

## Decisions
1. **Workers act as the account owner.** Jobs receive only an account id. `sys_account_ctx(id)` (SECURITY DEFINER) returns the owner's user and tenant, and every later query runs in `Db.tx(ownerCtx)`. A bug in a connector therefore cannot write another user's rows; RLS rejects it. The only cross-user reads are the four `sys_*` functions, which return ids or the minimum context.
2. **Webhooks only enqueue.** They verify provenance (Google OIDC token, Graph/Google per-account HMAC secret), look up accounts, and queue a sync. Notification contents are never trusted as data; the sync re-reads from the provider.
3. **Polling is the backstop, not a fallback mode.** A one-minute tick syncs any active account idle for 2 minutes. Webhooks reduce latency; correctness does not depend on them.
4. **Cursors live on the account.** Gmail historyId, Google syncToken, Graph deltaLinks (mail: JSON pair for Inbox and Sent). A `SyncResetError` triggers a fresh initial sync; upserts keyed on `(account_id, external_id)` make re-applying safe.
5. **Token refresh is serialized** per account with `pg_advisory_xact_lock`, re-reading the row inside the lock, so rotating refresh tokens (Microsoft) cannot be consumed twice. The tradeoff is a transaction held open during one HTTP call.
6. **BullMQ when `REDIS_URL` is set, in-process otherwise.** Same handlers either way. The in-process queue is for development only: it is serial and loses work on restart (the tick recovers it).
7. **HTML mail is sanitized at ingestion** (allow-list; remote images dropped; links get `rel=noopener`), stored sanitized only, and rendered in a script-free sandboxed iframe with a deny-all CSP.
8. **Read state is local.** Marking mail read in the app does not change the provider mailbox (read-only scopes).
9. Jobs, connectors and ingestion share one NestJS module (`ChannelsModule`) because they form a cycle (connect -> enqueue -> sync -> store).

## Consequences
- Initial sync holds up to 2,000 messages in memory and applies them in one transaction. Fine at the target scale; chunk it before raising the cap.
- Rate limits are handled by retry/backoff only. Per-provider token buckets arrive with the Slack/Teams connectors.
- The failed-job record in BullMQ (last 1,000) serves as the dead-letter queue until an admin view exists.
- Deleting messages found missing at the provider is immediate and permanent.
