# Unified Inbox AI Service

Status: **Phase 6 (hardening: privacy rights, retention, observability, OpenAPI + SDK, deployment, security review) built, awaiting approval.** All phases of the brief are now built. Open items are listed in `docs/08-security-review.md` and ADR 0007. Source brief: `unified-inbox-ai-prompt.md` (Downloads). Design: `docs/`.

## Rules from the brief
- Work in phases; stop for approval after each. Ask before adding paid services, changing stack, or touching production data.
- Sending a reply always requires explicit user confirmation. Never auto-send.
- Retrieval is always scoped to the requesting user. Cross-user leakage is a critical bug.
- No unofficial WhatsApp/LinkedIn libraries.

## Stack
NestJS 10 (TypeScript) modular monolith in `apps/api`, Vite + React in `apps/web`, Postgres 16 + pgvector with RLS, Redis (BullMQ arrives with the first background job in Phase 2), Docker Compose. LLM calls only through `LlmGateway`.

## Layout
- `apps/api/src/{config,db,crypto,auth,admin,llm,common,health}`; one NestJS module per folder
- `apps/api/src/ai` (consent, pipeline, retrieval, chat, summaries, digest; README has admin setup), `apps/api/src/llm` (gateway + adapters: anthropic, openai/xai, gemini)
- `apps/api/src/connectors` (one file per channel, `registry.ts`, `accounts.*`, README with provider setup), `ingestion` (`sync`, `ingestion`, `subscription`, inbox + webhook controllers, `channels.module.ts`), `jobs` (BullMQ or in-process)
- `apps/api/migrations/NNN_name.sql`: plain SQL, applied in order by `npm run migrate`
- `apps/web/src`: `App.tsx` (sign-in), `Admin.tsx` (LLM console), `api.ts` (client with refresh)
- `docs/` design, `docs/08-security-review.md`, `docs/ops-runbook.md`; `docs/decisions/` ADRs; `docker/postgres-init.sql` creates the dev runtime role; `deploy/` production images and Compose; `ops/` Prometheus + Grafana; `load/` k6; `packages/sdk` TypeScript client

## Commands
```
docker compose up -d                 # postgres (pgvector) + redis
cp .env.example .env                 # fill JWT_SECRET, MASTER_KEY
npm install
npm run migrate                      # as owner role (DATABASE_ADMIN_URL)
npm run create-admin -w apps/api -- you@example.com 'a-long-password'
npm run dev -w apps/api              # API on :3000
npm run dev -w apps/web              # web on :5173
npm test | npm run lint | npm run build
```
Isolation tests need `TEST_DATABASE_ADMIN_URL` and `TEST_DATABASE_URL`; they are skipped without them (CI sets both).

## Conventions
- All data access goes through `Db.tx(ctx, fn)` so RLS context is set. The runtime role is not the table owner and has no BYPASSRLS. Never connect the app as the owner.
- Pre-login lookups use the `auth_*` SECURITY DEFINER functions in the migration; nothing else reads across users.
- New table: enable RLS, add policies, add grants in the migration, add cases to `src/db/isolation.spec.ts`.
- Secrets (provider keys, later OAuth tokens) use `CryptoService.encrypt`; never log them or return them from the API.
- Every admin mutation calls `AuditService.log`.
- Prompts and routes live in the DB, not in code. Add a vendor by writing an `LlmAdapter` and registering it in `llm/registry.ts`.
- Connectors implement `ChannelConnector`; tests use recorded fixtures (`fakeFetch` in `connectors.spec.ts`), never real APIs. Add a channel: write the connector, add the channel to the CHECK in a new migration and to `CHANNELS`, register it in `connectors/registry.ts`.
- Workers get only an account id and act as its owner via `sys_account_ctx`; never query across users in a job. Webhooks verify, then enqueue only.
- Mail HTML is sanitized once, at ingestion (`sanitizeMailHtml`). Never store or render raw provider HTML.
- Connector errors: `ProviderAuthError` (needs reconnect, no retry), `SyncResetError` (fresh initial sync), anything else is retried. Error messages must not contain addresses, subjects or tokens.
- Request bodies are validated with zod via `ZodPipe`.
- AI code: every endpoint and job checks `ConsentService`; every query filters by `ai_enabled` accounts; every prompt value goes through `neutralize()`; model output is validated before use (`parseAnalysis`, `extractCitations`). The assistant has no tools and never acts.
- Embeddings are `vector(1536)` from the single routed embed model (`EMBED_DIM`). Never mix models; never add a fallback to the embed route.
- BullMQ job ids must not contain ":" (use "-"); BullMQ rejects them.
- No Docker? `npm run verify` runs the real compiled services against embedded Postgres (PGlite + pgvector) under the restricted role: `scripts/verify/`. CI additionally runs the isolation suite on real Postgres.
- Chat channels (ADR 0005): `Party.email` is optional; use `handle`. Push-only channels (WhatsApp) implement `ingestPushed`; their webhook stores the verified payload encrypted via `sys_push_webhook_event` and the sync worker drains `webhook_inbox`. Verify signatures over `req.rawBody` (Nest `rawBody: true`); never re-serialize the body. Put channel limitations in the connector's `notice` so the UI shows them.
- Sending (ADR 0006): only `RepliesService.send` / `CalendarActionsService.respond` may call `connector.sendReply` / `respondToEvent`, and only after `confirm: true` + the hash of the displayed text. AI code (`DraftService`) must never depend on a connector, registry or send service. Recipients are derived server-side. No automatic retries of sends. Write scopes are opt-in at connect (`write` flag, `writeScope`); gate on the account's granted scopes. Notification rows and push text carry no message content by default.
- Generated columns must be immutable; compute hashes in the app (a `convert_to`/`textsend` generated column failed in Postgres).
- Hardening (ADR 0007, `docs/08-security-review.md`): every authenticated request checks session liveness (`SessionLiveness`); browsers hold the refresh token only in the HttpOnly `inbox_rt` cookie (`x-client: web`), apps use the body. New provider URLs go through `assertSafeProviderUrl`. Production startup rejects weak config (`config/env.ts`).
- Privacy: export (`/me/export`), erasure (`sys_delete_user`, only for the caller) and the hourly retention sweep (`sys_purge_expired`). A new table with personal data must be added to the export list in `privacy.service.ts`, to the isolation spec, and must cascade from `users`.
- Observability: metrics use fixed low-cardinality labels only (never ids, emails, subjects, URLs). Add a metric in `MetricsService`; dashboards and alerts in `ops/` are tested against the exported names.
- The OpenAPI file (`apps/api/openapi/openapi.yaml`) is tested against the controllers: add or change a route and update the spec, then `npm run generate -w packages/sdk` (CI fails if `packages/sdk/src/schema.ts` is stale).
- Rotating the master key: `MASTER_KEY_PREVIOUS` + `npm run rotate-keys -w apps/api` (see `docs/ops-runbook.md`). Run exactly one API instance until rate limiting uses Redis.
- Shell tip: very long heredocs in the Bash tool can fail on quotes; create files with the editor tools instead.
