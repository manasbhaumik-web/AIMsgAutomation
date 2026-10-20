# ADR 0007: Hardening, privacy rights and operations

**Status:** Accepted (Phase 6)

## Decisions
1. **Sessions are checked against the database on every request** (cached up to 10 seconds per instance). Stateless access tokens alone cannot be revoked, and logout, device removal, disabling and deletion must take effect in seconds. Cost: one indexed lookup per user per few seconds, acceptable at this scale.
2. **Browsers use an HttpOnly cookie for the refresh token; apps keep using the response body.** One contract serves both: the web client sends `x-client: web`, which also serves as the CSRF check together with `SameSite=Strict`. Refresh is single-flight in both clients (the web app and the SDK).
3. **Privacy rights are database functions plus thin services.** Export streams the caller's own rows under row-level security (no tokens, hashes or embeddings). Erasure is one `SECURITY DEFINER` function that only acts for the calling user, deletes by cascade, removes personal tenants, anonymizes the audit trail (keeps the security record, drops the actor) and refuses to orphan a shared workspace or remove the last platform admin. Provider revocation happens after the deletion, from credentials read beforehand.
4. **Retention is enforced, not just configured.** An hourly sweep applies per-tenant message retention and fixed windows for sessions, notifications, stale webhook events, old drafts, audit and usage rows. Ages are arguments to a database function, set from environment variables.
5. **Observability is Prometheus plus structured logs, nothing proprietary.** `/metrics` is off unless a token is set, labels are fixed small sets, access logs record route patterns only. Dashboards and alert rules are files in `ops/`, and a test fails if they reference a metric the code no longer exports.
6. **The API contract is a hand-written OpenAPI file, kept honest by tests.** A test compares it to the controllers' real routes and `@Public` markers in both directions. TypeScript types for the SDK are generated from it, and CI fails if the generated file is stale. Mobile apps in other languages can generate clients from the same file.
7. **Deployment is cloud-agnostic and conservative.** Non-root, read-only containers with dropped capabilities; the API runs as the restricted database role (startup refuses otherwise); production refuses placeholder secrets, http origins and the in-memory queue. Releases are built and scanned on tags and never deploy themselves. No paid service was added: CI uses free tooling (npm audit, TruffleHog, Trivy, SBOM generation).
8. **Master-key rotation is built in** (`MASTER_KEY_PREVIOUS` + `rotate-keys`), ahead of a KMS adapter, because the cloud is still undecided.
9. **Password hashing follows current OWASP scrypt guidance** and stores its parameters with each hash.

## Consequences
- One API instance is the supported topology until rate limiting moves to Redis.
- The NestJS 10 line carries advisories that need a major upgrade; CI gates on critical findings only (security review, finding 12).
- Load-test scripts (k6) and a seed script exist, but no load test has been run: there is no environment to run it against yet. Targets in `load/README.md` are starting points to be confirmed on real hardware.
- No MFA, password reset, web push, real-time stream or independent penetration test yet (listed in the security review).
