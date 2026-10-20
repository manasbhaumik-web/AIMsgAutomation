# 06 Security and privacy

## Threat model (top items)
| Threat | Mitigation |
|---|---|
| Cross-user data leakage (critical) | Postgres RLS on every personal table, non-BYPASSRLS app role, per-transaction GUCs, retrieval filters, tenant-isolation test suite in CI |
| Token theft | Envelope encryption: per-record DEK wrapped by a master key (local key in dev, KMS/Key Vault adapter later); tokens never logged; log scrubbing |
| Forged webhooks | Verify before parsing: Slack signing secret + timestamp; Graph `clientState` + validation token; Meta `X-Hub-Signature-256`; Google Pub/Sub OIDC JWT. Reject and rate-limit failures |
| Prompt injection from message content | Treat message text as data: delimiters, no tool access that sends or deletes, drafts only, send needs user confirm, citations required |
| Accidental auto-send | Single send endpoint requiring authenticated confirm call; audit log |
| Stored XSS via HTML mail | Server-side sanitiser allow-list, CSP, no remote content by default |
| Abuse/DoS | Redis rate limits per IP/user/route, body size limits, job concurrency caps |
| Secrets in git | `.env.example` only, secret scanning in CI |

## Auth
OIDC login, JWT access (about 15 min), rotating refresh tokens stored hashed per device session, revocation, argon2id for any local passwords, optional MFA later. Baseline: OWASP ASVS L2.

## Data lifecycle
- Retention per tenant (default off = keep until disconnect); a scheduled job purges older content.
- Disconnect with "delete data" hard-deletes messages, embeddings, tags, summaries, drafts for that account.
- `DELETE /me` removes the user and all personal data; backups age out on a documented schedule.
- `GET /me/export` produces a machine-readable archive.

## Compliance mapping (design intent, not legal advice)
| Requirement | Feature |
|---|---|
| Consent (PDPA, GDPR) | `consent` table, per-purpose, withdrawable; AI processing is its own purpose |
| Access/portability | export endpoint |
| Erasure | hard delete flows |
| Minimisation | minimal incremental scopes, attachments not stored, redaction before LLM |
| Transparency | UI states which provider processes data; third-party processors listed |
| Cross-border transfer | admin can restrict to self-hosted/regional providers (e.g. Ollama, Azure region) |
| Accountability | audit log of admin actions, sends, exports |

A legal review of PDPA/GDPR obligations is recommended before any production launch.

## Test plan: isolation
- Two users, two tenants seeded; every list/get/search/RAG endpoint is called as user A with user B's ids and must return 404/empty.
- Direct DB tests using the app role without GUCs must return zero rows.
- Vector search test: user B's closest embedding must never appear in user A's results.
- Runs in CI on every change.
