# Load tests (k6)

Scripts for a **staging** environment. They create and use synthetic users; never point them at production. None has been run yet (no environment exists), so the thresholds are starting targets for fewer than 1,000 users on one API instance and one Postgres, to be confirmed on the real hardware.

## Prepare
```bash
npm run build
# Seed 200 users x 400 messages into a TEST database, as the owner role:
psql "$DATABASE_ADMIN_URL" -v pwhash="$(node load/make-hash.mjs LoadTest-Pass-123)" -v users=200 -v msgs=400 -f load/seed.sql
```
Run the API with `WORKERS_ENABLED=false` for pure read tests (so background sync does not compete), and with Redis plus real workers for the webhook test. The seed is repeatable. `npm run verify` checks that `seed.sql` itself works.

## Scenarios
| Script | What it does | Pass criteria |
|---|---|---|
| `read-mix.js` | Up to 200 users read the inbox, filtered thread lists, thread detail and notifications. Also asserts that each user only ever sees their own account's threads. | error rate < 1%; p95 threads < 400 ms, thread/inbox/notifications < 300 ms; isolation checks 100% |
| `webhook-burst.js` | Up to 100 signed webhooks per second plus forged ones. | p95 < 250 ms; every forgery answered 401 |
| `chat-stream.js` | 20 concurrent assistant streams (needs an AI route; use a stub or a cheap model). | p95 first byte < 3 s; every stream ends with `done` |

```bash
k6 run -e BASE_URL=https://staging.example.com/api/v1 load/read-mix.js
k6 run -e BASE_URL=... -e SLACK_SIGNING_SECRET=... load/webhook-burst.js
k6 run -e BASE_URL=... -e CHAT_VUS=20 load/chat-stream.js
```

## What to watch while they run
Grafana: request latency by route, `inbox_oldest_sync_age_seconds`, queue depth, database connections (pool of 10 per instance is the first limit to hit), event-loop lag. If `threads` p95 degrades with data size, look at the `ORDER BY last_message_at` plan and the `messages` aggregate in `inbox.controller.ts` first.
