# Unified Inbox AI Service

One place for a person's mail, calendar and chat (Gmail, Outlook, Slack, Teams, WhatsApp Business, Google and Microsoft calendars), organized by channel and topic, summarized, searchable through an assistant, with drafted replies that are **only ever sent after the person confirms the exact text**.

Backend first (NestJS, Postgres with row-level security, Redis), a reference web client (Vite + React), and a versioned API plus a TypeScript SDK for mobile apps.

## Run it locally
```bash
docker compose up -d                 # Postgres (pgvector) + Redis
cp .env.example .env                 # set JWT_SECRET and MASTER_KEY (see comments in the file)
npm install
npm run migrate
npm run create-admin -w apps/api -- you@example.com 'a-long-password'
npm run dev -w apps/api              # API on :3000
npm run dev -w apps/web              # web on :5173
```
No Docker? `npm run verify` runs the real services against embedded Postgres. Checks: `npm run lint`, `npm run build`, `npm test`.

## Where things are
| | |
|---|---|
| `apps/api` | The service: modules for auth, connectors, ingestion, AI, replies, calendar actions, notifications, privacy, observability. SQL migrations in `apps/api/migrations`. OpenAPI contract in `apps/api/openapi/openapi.yaml`. |
| `apps/web` | Reference web client. |
| `packages/sdk` | TypeScript client generated from the OpenAPI file (web and React Native). |
| `deploy/` | Dockerfiles, nginx config, production Compose stack. |
| `ops/` | Prometheus rules, Grafana dashboard. |
| `load/` | k6 load tests and a seed script. |
| `scripts/verify/` | End-to-end service checks on embedded Postgres. |
| `docs/` | Design (`00`-`07`), security review (`08`), operations runbook, and decision records in `docs/decisions/`. |
| `CLAUDE.md` | Conventions and rules for working in this repository. |

## Read next
1. `docs/00-overview.md` for goals and scope, `docs/01-architecture.md` for how it fits together.
2. `apps/api/src/connectors/README.md` to register the provider apps (Google, Microsoft, Slack, Meta, LinkedIn) and see each channel's limits.
3. `apps/api/src/ai/README.md` to configure AI providers and see what is sent where.
4. `docs/08-security-review.md` and `docs/ops-runbook.md` before running it for real people.

## What it will not do
It never sends anything on its own. WhatsApp is limited to business numbers (there is no official way to read a personal account). LinkedIn is a profile-only stub because its messaging APIs are partner-only. AI features are off until each person turns them on.
