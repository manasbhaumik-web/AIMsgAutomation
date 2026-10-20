# Security review (Phase 6)

This is a review by the engineer who built the system, not an independent audit. It lists what was checked, what was found, what was fixed, and what is still open. An external penetration test and a legal review of the data-protection position are still recommended before real users.

## How it was done
- Read the authentication, session, connector, webhook, send, privacy and admin code paths against the threat model in `06-security-privacy.md`.
- Wrote an automated test for every fix so it cannot silently return (test names are in the right-hand column).
- Ran `npm audit` on the production dependencies.
- Not done: penetration testing, fuzzing, testing against live Google/Microsoft/Slack/Meta/LLM services, review of the cloud environment (none exists yet).

## Findings

| # | Severity | Finding | Status | Evidence |
|---|---|---|---|---|
| 1 | High | Access tokens kept working for up to 15 minutes after logout, device revocation, disabling or deleting the user, because they were checked by signature only. | **Fixed.** Every request checks the session in the database (`auth_session_alive`), cached for at most 10 seconds per instance; logout and revocation clear that instance's cache at once. | `auth/session.spec.ts`, `scripts/verify/privacy.mjs` |
| 2 | Medium | The web client stored the refresh token in `localStorage`, readable by any injected script. | **Fixed.** Browsers get it in an `HttpOnly; SameSite=Strict; Secure` cookie scoped to `/api/v1/auth`, accepted only together with the `x-client: web` header (the CSRF check). Apps still receive it in the response body. Refreshes are single-flight, because refresh tokens are single-use and a parallel refresh looks like theft. | `auth/session.spec.ts` |
| 3 | Medium | An administrator could point an AI provider at any URL, so the server would call internal services or the cloud metadata address with the provider key (SSRF). | **Fixed.** https only, no credentials in URLs, no private/loopback/link-local/metadata addresses, including IPv4-mapped IPv6 forms; Ollama may use private addresses but never link-local. Residual: names are checked, not resolved (DNS rebinding); keep egress filtering at the network. | `llm/url-guard.spec.ts` |
| 4 | Medium | `sanitize-html` was pinned to an old version with published bypasses (URI-scheme checks on unusual attributes, mutation XSS). Mail HTML is the main untrusted input. | **Fixed.** Upgraded to 2.18.1; inline images limited to PNG/JPEG/GIF/WebP data URLs (no SVG); 25-vector XSS corpus run on every build. The web client still renders mail only in a sandboxed iframe without scripts, under a strict CSP. | `observability/hardening.spec.ts` |
| 5 | Medium | A production deployment could start with a placeholder `JWT_SECRET`, development database passwords, an `http://` origin, the **table-owner** database role (which would make row-level security meaningless), or the in-memory queue. | **Fixed.** The API refuses to start in production with any of these. | `config/env.spec.ts` |
| 6 | Medium | `tenants.retention_days` could be set by a tenant admin but nothing deleted anything, so the promise made to users was not kept. | **Fixed.** An hourly sweep deletes messages (and, by cascade, their embeddings and analysis) past each tenant's retention, plus expired sessions, old notifications, stale webhook events, old discarded drafts, and old audit and usage rows (ages in `.env.example`). | `scripts/verify/privacy.mjs` |
| 7 | Medium | Account deletion revoked provider access *before* the database refused the deletion (last administrator), leaving an account with revoked connections. Found by the new verification script. | **Fixed.** Credentials are read first, the data is deleted, and provider access is revoked last (best effort). | `scripts/verify/privacy.mjs` |
| 8 | Low | The metrics endpoint would expose operational data. | **Fixed.** Disabled unless `METRICS_TOKEN` is set, bearer-protected with constant-time comparison, hidden by the nginx config. Labels never contain ids, addresses or query strings. | `observability/hardening.spec.ts` |
| 9 | Low | Behind a reverse proxy every client shares the proxy's address, so per-client rate limits would not work. | **Fixed.** `TRUST_PROXY` (hops) is configurable and documented. | deploy files |
| 10 | Low | No key rotation path for the master key. | **Fixed.** `MASTER_KEY_PREVIOUS` + `rotate-keys` re-wraps every stored data key without downtime and is repeatable. | `crypto/crypto.service.spec.ts` |
| 11 | Low | Password hashing used scrypt N=2^14, p=1, below current OWASP guidance (N=2^15 with p=3). | **Fixed.** New hashes use N=2^15, r=8, p=3 and carry their parameters, so the cost can be raised later; earlier hashes keep verifying. Stored parameters outside a sane range are refused. | `auth/auth.spec.ts` |
| 12 | Low | `npm audit` (production) reports advisories in the NestJS 10 line: `@nestjs/platform-express` (multer, body-parser) and `@nestjs/core`. | **Accepted for now, upgrade recommended.** The application has no file-upload endpoints (multer is unreachable), uses the default body-parser limits (the advisory concerns invalid limit values), and CI blocks on *critical* advisories. The fix is the NestJS 11/12 major upgrade; plan it as its own change. | CI `supply-chain` job |
| 13 | Info | The rate limiter keeps its counters in memory, so limits are per instance. | **Accepted.** One API instance is the supported topology. Before running several, move the limiter to Redis. | `app.module.ts` comment |
| 14 | Info | Webhook endpoints are not rate limited by the app. | **Accepted.** Verification is a single HMAC or token check; rejections are counted (`inbox_webhooks_total{result="rejected"}`) and alerted. Add rate limiting at the ingress. | `ops/alerts.yml` |
| 15 | Info | The master key lives in an environment variable. | **Open (needs the cloud decision).** `KeyProvider` is the seam for a KMS/Key Vault implementation. | ADR 0002 |

## Checks that were already in place and still hold
- Cross-user isolation at the database (row-level security, non-owner runtime role, `SECURITY DEFINER` functions as the only cross-user reads), tested on real Postgres in CI and on embedded Postgres in `npm run verify`.
- Every webhook is verified (Slack signature with replay window, Meta signature, Graph `clientState`, Pub/Sub token) before anything is queued; WhatsApp content is stored encrypted.
- No send without the user's confirmation of the exact text; AI code cannot reach the send path.
- AI is opt-in; prompts treat message text as untrusted data; model output is validated before use; the assistant has no tools.
- Provider tokens and API keys are envelope-encrypted (AES-256-GCM); never returned by the API; never logged.
- Input validation with zod on every body; parameterized SQL; strict allowlist HTML sanitizing at ingestion.

## OWASP ASVS 4.0 level 2, by chapter

| Chapter | Status | Notes |
|---|---|---|
| V1 Architecture | Partly met | Threat model, ADRs, trust boundaries documented. No formal threat-modelling workshop. |
| V2 Authentication | Met, with notes | Memory-hard password hashing, rate-limited login (login does not reveal whether an email exists; registration does, by answering 409), OIDC with PKCE and verified-email auto-linking only. No MFA yet (recommended before launch; rely on Google/Microsoft sign-in for MFA meanwhile). Password-reset by email is not implemented. |
| V3 Session management | Met | Short-lived access tokens, rotating single-use refresh tokens with reuse detection, server-side revocation within seconds, HttpOnly cookie for browsers, device list and remote sign-out. |
| V4 Access control | Met | Deny-by-default global guard, role guard, row-level security as the backstop. |
| V5 Validation, sanitization | Met | zod everywhere, allowlist HTML sanitizer, SQL parameters, prompt-injection controls. |
| V6 Cryptography | Mostly met | AES-256-GCM envelope encryption, rotation supported, TLS terminated at the edge. Master key not yet in a KMS. |
| V7 Errors and logging | Met | Structured access logs without query strings or bodies; audit log for admin actions, sends, exports and erasures; internal error text never reaches clients. |
| V8 Data protection | Met | Export, erasure, retention, consent, minimized push text, redaction before LLM calls. |
| V9 Communication | Depends on deployment | HSTS and CSP set in nginx; TLS must be terminated in front (documented). |
| V10 Malicious code | Partly met | Dependency audit and secret scanning in CI; image scanning; no dynamic code evaluation. No signed commits or build provenance yet. |
| V11 Business logic | Met | Confirmation gates, atomic send claim, per-user rate limits, WhatsApp window enforcement. |
| V12 Files | N/A | No uploads or downloads of user files (attachment bytes are never fetched). |
| V13 API | Met | OpenAPI contract tested against the routes; consistent errors; SSE failures before the stream are normal HTTP errors. |
| V14 Configuration | Met | Production startup validation, non-root read-only containers with dropped capabilities, no secrets in images. |

## Still recommended before real users
1. Independent penetration test, including the OAuth connect flows and the webhook endpoints.
2. MFA for password accounts, and a password-reset flow.
3. Move the master key to a KMS once the cloud is chosen; encrypt database backups.
4. Data-processing agreements with each AI provider; confirm their retention and training terms. Google restricted-scope verification (CASA) and Meta app review are lead-time items.
5. Redis-backed rate limiting before a second API instance; ingress rate limits and a WAF for the webhook paths.
6. Plan the NestJS major upgrade (finding 12).
7. A legal review of the PDPA/GDPR position (controller/processor roles, cross-border transfer to AI providers, breach notification process).
