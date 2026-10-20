# ADR 0001: Core stack and structure

**Status:** Proposed (Phase 0)

## Decisions
1. **NestJS (TypeScript)** backend. Shares language and types with the React client and generated SDK; mature ecosystem for OAuth, BullMQ and OpenAPI.
2. **Modular monolith** (Auth, Connectors, Ingestion, AI, Chat, Notifications, Admin). Under 1k users does not justify microservices; module boundaries keep a later split possible.
3. **PostgreSQL + pgvector** with **row-level security**. One store for relational data, vectors and full-text; isolation enforced in the data layer.
4. **Redis + BullMQ** for jobs, locks, cache and rate limiting. Idempotent jobs, backoff, dead-letter queue.
5. **SSE** for chat streaming and event push; simpler than WebSockets through proxies and mobile. WebSocket can be added if bidirectional needs appear.
6. **Provider-agnostic LLM gateway** with DB-stored routes and prompts; Anthropic adapter first, others pluggable.
7. **Docker Compose only** for now; cloud and IaC deferred to Phase 6 to avoid committing early.

## Consequences
- One deployable unit and simple local dev.
- RLS requires a per-request transaction with GUCs, so a request-scoped DB wrapper is mandatory.
- BullMQ ties job durability to Redis persistence settings (AOF on).

## Alternatives considered
ASP.NET Core + Hangfire/SignalR (good Graph/Azure fit, but splits language from web client); separate vector DB (extra service, not needed at this scale).
