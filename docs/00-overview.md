# 00 Overview

**Status:** Phase 0 (design only). No application code yet.

## Goal
A multi-tenant, backend-first service that gathers each user's messages and calendar events from many channels, organises them by channel, tags and summarises them by topic, and lets the user chat with an assistant (RAG with citations). The assistant drafts replies. **Sending always needs explicit user confirmation.**

Clients: Android, iOS (consume the API and a generated SDK; not built here) and a React web client (built here, from Phase 2).

## Decisions taken
| Area | Decision |
|---|---|
| Backend | NestJS (TypeScript), modular monolith |
| Data | PostgreSQL + pgvector (RLS), Redis |
| Jobs | BullMQ on Redis |
| Realtime | SSE for chat streaming and events (WebSocket optional later) |
| LLM | Provider-agnostic gateway; admin chooses provider/model per task |
| Infra | Docker Compose only for now; cloud and IaC deferred (Phase 6) |
| Scale target | Under 1k users; individuals plus small orgs |

## Assumptions
- A user belongs to exactly one personal tenant, and may also be a member of an organisation tenant.
- Backfill default is 14 days, configurable per user.
- Dev secrets come from `.env`; a KMS adapter is pluggable later.

## Phase map
0 Design, 1 Foundation, 2 Google/Microsoft mail+calendar, 3 AI core, 4 Slack/Teams/WhatsApp (+LinkedIn stub), 5 Replies/actions/push, 6 Hardening. Each phase ends with a stop for approval.

## Coverage checklist (prompt sections to docs)
- §1 Channels and connector interface: 03-connectors
- §2 AI layer and admin: 05-llm-gateway, 02-data-model
- §3 Multi-tenancy, auth, roles: 01-architecture, 02-data-model, 04-api
- §4 Security/privacy/compliance: 06-security-privacy
- §5 Architecture: 01-architecture, decisions/
- §6 Phases: this file
- Risks and open decisions: 07-risks-and-decisions
