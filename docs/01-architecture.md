# 01 Architecture

## Components
```mermaid
flowchart LR
  subgraph Clients
    W[Web React] --- A[Android] --- I[iOS]
  end
  Clients -->|HTTPS REST /api/v1 + SSE| API
  subgraph Monolith[NestJS modular monolith]
    API[API gateway layer<br/>auth, rate limit, validation]
    AUTH[Auth module]
    CONN[Connectors module]
    ING[Ingestion module]
    AI[AI module<br/>LLM gateway, RAG]
    CHAT[Chat module]
    NOTIF[Notifications module]
    ADM[Admin module]
    API --> AUTH & CONN & CHAT & ADM
    CONN --> ING --> AI
    CHAT --> AI
    AI --> NOTIF
  end
  DB[(Postgres + pgvector<br/>RLS)]
  R[(Redis<br/>BullMQ, cache, rate limit)]
  Monolith --- DB
  Monolith --- R
  EXT[Gmail, GCal, Graph, Slack, Meta WhatsApp] -->|signed webhooks| API
  CONN -->|OAuth, sync, send| EXT
  AI -->|HTTPS| LLM[LLM providers<br/>Anthropic, OpenAI, Azure, Google, Ollama]
  NOTIF --> PUSH[FCM / APNs]
```

## Module boundaries
Each module exposes a typed service interface and owns its tables. No cross-module table access; modules talk through services or events (in-process event bus, replaceable by a queue).

| Module | Owns |
|---|---|
| Auth | users, tenants, memberships, sessions, OIDC/JWT, roles |
| Connectors | connected_accounts, channel plugins, sync cursors, subscriptions |
| Ingestion | messages, threads, events, normalisation, dedupe, sanitisation |
| AI | embeddings, tags, summaries, digests, prompt templates, LLM gateway |
| Chat | conversations, turns, citations, drafts |
| Notifications | device tokens, preferences, SSE hub |
| Admin | LLM provider config, quotas, audit viewer |

## Flow: ingestion
```mermaid
sequenceDiagram
  participant P as Provider
  participant W as Webhook endpoint
  participant Q as BullMQ
  participant C as Connector
  participant I as Ingestion
  participant A as AI jobs
  P->>W: signed notification
  W->>W: verify signature, enqueue (idempotency key)
  W-->>P: 2xx fast
  Q->>C: incrementalSync(account, cursor)
  C->>I: normalised messages/events
  I->>I: sanitise HTML, dedupe, store (RLS)
  I->>Q: enqueue embed, classify
  Q->>A: redact, call gateway, write tags/vectors
  A-->>Notifications: new-message SSE / push
```
Failures retry with backoff and land in a dead-letter queue. Polling backstops missed webhooks.

## Flow: RAG chat
1. Client posts a question and opens the SSE stream.
2. Server sets `app.user_id` for the transaction, so RLS scopes every query.
3. Hybrid retrieval: pgvector similarity plus Postgres full-text, merged by reciprocal rank fusion, limited to the user's allowed channels (AI-off channels excluded).
4. Context is redacted per policy, then sent through the gateway (`chat` route).
5. Tokens stream back; citations (message ids) are attached and linked in the client.

## Flow: reply (never auto-send)
```mermaid
sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: "reply to X saying ..."
  S->>S: draft via gateway, store draft (status=draft)
  S-->>U: draft preview
  U->>S: POST /drafts/{id}/send (explicit confirm)
  S->>S: re-check ownership, audit log
  S->>Connector: sendReply
```
There is no code path that sends without a confirm call from an authenticated user session. The audit log records every send.

## Auth and tenancy
- OIDC login (email, Google, Microsoft), short-lived JWT access tokens, rotating refresh tokens bound to device sessions.
- Roles: `admin` (platform), `tenant_admin`, `user`.
- Every row carries `tenant_id` and (where personal) `user_id`; RLS enforces both.
