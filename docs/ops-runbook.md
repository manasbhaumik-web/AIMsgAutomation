# Operations runbook

For whoever runs the service. Nothing here was exercised against a live cloud environment (none has been chosen); the commands target the single-host Docker Compose stack in `deploy/` and map directly to Kubernetes or a managed platform.

## Topology
`web` (nginx, the only published port) → `api` (NestJS, one instance) → `postgres` (pgvector) and `redis`. A TLS-terminating load balancer sits in front of `web`. Prometheus scrapes `api:3000/api/v1/metrics` over the internal network; Grafana shows `ops/grafana/dashboards/inbox-overview.json`. **Run exactly one `api` instance** until rate limiting is moved to Redis (security review, finding 13).

## Deploy a release
1. Tag `vX.Y.Z`. The `release` workflow builds, scans (fails on fixable critical findings), and pushes `ghcr.io/<owner>/<repo>-api:vX.Y.Z` and `-web:`. Nothing deploys automatically.
2. On the host: set `API_IMAGE` / `WEB_IMAGE` in `deploy/.env.prod`, then
   ```bash
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod pull
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
   ```
   The `migrate` service applies pending SQL first (owner role); `api` starts only after it succeeds. Migrations are forward-only and idempotent.
3. Check `GET /api/v1/health/ready`, the dashboard, and that `inbox_oldest_sync_age_seconds` is falling.

**Rollback.** Images roll back by re-pointing `API_IMAGE`. Migrations do not: write a new forward migration, or restore the pre-deploy backup. Take a backup before any release that adds a migration.

## Backups and restore
- Database: nightly `pg_dump -Fc` of `inbox` plus WAL archiving if you need point-in-time recovery. Encrypt backups at rest and keep them off the host. Redis holds only queue state: losing it loses no mail (the minute poll re-syncs), only queued jobs.
- **Back up `MASTER_KEY` separately** (a password manager or vault, not the same place as the database dump). Without it every stored provider token and API key is unreadable and all accounts must be reconnected.
- Restore drill (do this once a quarter, to a scratch database): `pg_restore --clean --if-exists -d inbox_restore backup.dump`, point a throwaway API at it with the same `MASTER_KEY`, sign in, open a thread. Restored data older than a user's erasure request must be re-erased: keep a log of erasure dates and re-run them after any restore (the audit log row `account.deleted` records when, without identifying anyone).

## Secrets and keys
| Secret | Rotation |
|---|---|
| `MASTER_KEY` | Generate a new key. Set `MASTER_KEY=<new>` and `MASTER_KEY_PREVIOUS=<old>`, deploy, run `docker compose ... run --rm migrate node dist/db/cli.js rotate-keys`, confirm the output shows every table re-wrapped, then remove `MASTER_KEY_PREVIOUS` and redeploy. Repeatable and zero downtime. Keep the old key in the vault until the old backups are retired. |
| `JWT_SECRET` | Changing it signs everyone out of access tokens (refresh tokens keep working, so clients recover silently) and invalidates in-flight OAuth states and the per-account webhook `clientState`. After rotating, the next renewal job re-registers subscriptions; until then rely on polling. |
| Database passwords | Change the role password in Postgres, update `.env.prod`, restart `api`. |
| Provider client secrets / signing secrets | Rotate at the provider, update `.env.prod`, restart. Slack and Meta webhooks fail verification until both sides match (watch `WebhookRejectionsSpike`). |
| AI provider keys | Admin console → Providers → update the key. No restart. |

## Alerts: what to do
<a id="api-down"></a>
**ApiDown.** `docker compose ps`, `docker compose logs --tail 200 api`. A startup refusal prints the invalid setting (production checks, see `config/env.ts`). If the database is down, `health/ready` fails and the API keeps answering liveness.

<a id="high-error-rate"></a>
**HighServerErrorRate.** Grafana → requests by status, p95 by route. Correlate with `x-request-id` in the JSON access log. Common causes: database saturation (connection pool is 10), a failing deploy (roll back the image), or a provider outage surfacing through a sync-triggered path.

<a id="sync-behind"></a>
**SyncFallingBehind.** Check `inbox_jobs_total{job="sync",result="error"}` and queue depth. Per account: Accounts page shows `last_error`. Accounts in `reauth` need the user to reconnect (provider revoked access or an app secret changed). Slack limits history reads for apps outside the Marketplace; a large workspace can legitimately lag. Redis down → jobs fall back to nothing: restart Redis, the minute tick re-queues everything.

<a id="jobs-failing"></a>
**BackgroundJobsFailing.** Look at which `job` label. `ai` failing usually means the AI provider (next item). `renew` failing means subscription renewals are being rejected: polling continues, so mail still arrives, just slower.

<a id="llm-errors"></a>
**LlmErrors.** Admin console → Providers → Test. Typical causes: expired key, exhausted provider quota, a changed model name, or the route pointing at a provider with no embedding support. Fallback is used automatically for chat/summaries where configured, never for embeddings. The pipeline pauses quietly and resumes when calls succeed.

**WebhookRejectionsSpike.** Either a secret was rotated on one side only, or someone is probing the endpoint. Compare `channel` label; confirm the signing secret in the provider console equals `.env.prod`. Rejected requests change nothing.

**ReplySendsFailing.** Users see the failure reason on the draft. Check the channel's provider status and whether many accounts moved to `reauth`.

## Data subject requests
- **Access / portability:** the person uses *Download my data* (`GET /api/v1/me/export`, newline-delimited JSON). For a request received by email, ask them to sign in and use it; operators do not read mail content.
- **Erasure:** `DELETE /api/v1/me` (the person confirms with their email and password). Refused with a clear message if they are the last administrator of a workspace; hand over administration first. Provider access is revoked on a best-effort basis; tell users they can also remove the app in Google/Microsoft/Slack/Meta account settings.
- **Withdrawing AI consent:** Accounts page, or `PUT /me/consents`. Derived data is erased by default.
- **Retention:** the hourly sweep; tenant admins set `retention_days` for messages. Defaults for sessions, notifications, webhook events, drafts, audit and usage are in `.env.example`.

## Personal-data breach checklist
1. Contain: rotate the exposed secret (table above), revoke sessions if needed (`UPDATE device_sessions SET revoked_at = now()` as the owner role signs everyone out within seconds).
2. Establish scope from the audit log and access logs (`x-request-id`).
3. GDPR: notify the supervisory authority within 72 hours of becoming aware if there is a risk to people; PDPA (Malaysia/Singapore): follow the applicable notification duty and timeline. Inform affected users without undue delay when the risk is high.
4. Record what happened and what changed.

## Capacity notes
Designed for fewer than 1,000 users on one API instance and one Postgres. Vector search is an exact per-user scan (fine to a few hundred thousand messages per user). Revisit before growing: Redis-backed rate limiting, read replicas, partitioning `messages` by user, an ANN index with per-user filtering, a managed queue.
