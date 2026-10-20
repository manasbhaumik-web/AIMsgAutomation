# ADR 0002: Authentication and row-level security model

**Status:** Accepted (Phase 1)

## Decisions
1. **Two Postgres roles.** `inbox_owner` owns tables and runs migrations. `inbox_app` is the runtime role: no ownership, no BYPASSRLS. RLS therefore always applies to application queries.
2. **Per-transaction context.** `Db.tx(ctx, fn)` runs `set_config('app.user_id' | 'app.tenant_id' | 'app.role' | 'app.tenant_role', ..., true)` inside the transaction. Values come only from the verified JWT, never from request input.
3. **Pre-login lookups via SECURITY DEFINER functions** (`auth_find_user`, `auth_create_user`, `auth_find_session`, ...). They are the only cross-user reads and are granted to the runtime role only.
4. **Column-level grants** stop self-service escalation: the runtime role can update only `users(name, locale, settings)` and `tenants(name, retention_days, ai_enabled)`.
5. **Tokens.** 15-minute HS256 access JWT (`sub, tid, role, tr, sid`); 30-day opaque refresh token stored as a SHA-256 hash per device session, rotated on every use. Presenting an already-rotated token revokes the session (theft signal).
6. **Passwords** use scrypt (N=16384) with per-hash salt and constant-time compare; unknown users still pay the hashing cost.
7. **Google/Microsoft sign-in** uses authorization code + PKCE with a stateless signed `state` (verifier, nonce, redirect URI). Redirect URIs must be on an allow-list. Accounts auto-link by email only when Google asserts `email_verified`; Microsoft email is never trusted for linking.
8. **Platform admin** is created only through the `create-admin` CLI with the owner connection. There is no email-based bootstrap, because an unverified registration could claim it.

## Consequences
- A logged-out session stays valid for up to 15 minutes at the API (access token lifetime). Acceptable for now; add a revocation check if needed.
- Rate limiting is in-memory per process until Redis storage is wired in Phase 2.
- Deleting a user cascades their rows; their personal tenant row remains and needs a cleanup job (Phase 6 deletion flow).
- The web client keeps the refresh token in localStorage for now. Moving it to an httpOnly cookie is a Phase 6 hardening item.
