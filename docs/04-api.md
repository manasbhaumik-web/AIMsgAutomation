# 04 API surface (`/api/v1`, OpenAPI 3, committed spec)

## Auth
- `POST /auth/login`, `/auth/oidc/{google|microsoft}/callback`, `/auth/refresh`, `/auth/logout`
- `GET/DELETE /me/sessions` (device sessions)

## Accounts (per user)
- `GET /accounts`, `POST /accounts/{channel}/connect` (returns auth URL), `GET /accounts/callback`
- `PATCH /accounts/{id}` (pause, include/exclude folders or chats, backfill window, ai_enabled)
- `POST /accounts/{id}/reauth`, `DELETE /accounts/{id}?deleteData=true`

## Inbox
- `GET /inbox?channel=&account=&unread=` (grouped channel, account, thread, with unread counts)
- `GET /threads/{id}`, `GET /messages/{id}`, `POST /messages/{id}/read`
- `GET /topics`, `GET /topics/{id}/messages`
- `GET /calendar/events?from=&to=`

## AI
- `GET /summaries?scope=thread|channel|topic&ref=`, `POST /summaries` (on demand)
- `GET /digests/latest`, `PUT /me/digest-schedule`
- `GET /action-items`

## Chat (RAG)
- `POST /chat/conversations`, `GET /chat/conversations/{id}`
- `POST /chat/conversations/{id}/messages` returns `text/event-stream` (token events, then a `citations` event, then `done`)
- `POST /drafts`, `PATCH /drafts/{id}`, `POST /drafts/{id}/send` (explicit confirmation only)

## Events
- `GET /events/stream` (SSE: new-message, sync-status)
- `POST /devices` (register FCM/APNs token)

## Privacy
- `GET /me/export` (async job), `DELETE /me` (hard delete), `GET/PUT /me/consents`

## Webhooks (unauthenticated routes, signature-verified)
- `POST /webhooks/slack`, `/webhooks/graph`, `/webhooks/whatsapp`, `/webhooks/google-pubsub`

## Admin (`admin` role)
- `/admin/llm/providers`, `/admin/llm/routes`, `/admin/prompts`, `/admin/quotas`, `/admin/usage`, `/admin/audit`
- Tenant admins: `/tenant/members`, `/tenant/retention`

## Conventions
Cursor pagination, RFC 7807 errors, idempotency keys on sends and uploads, per-route rate limits (Redis).

## Mobile
Channel OAuth runs in the system browser with PKCE and returns through an app deep link (`app://oauth/callback`). Phase 6 delivers a typed SDK generated from the OpenAPI spec plus an auth/deep-link guide.
