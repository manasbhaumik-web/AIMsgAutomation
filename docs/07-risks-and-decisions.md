# 07 Risks and open decisions

## Risks
| # | Risk | Impact | Handling |
|---|---|---|---|
| 1 | WhatsApp has no official API for personal accounts | Feature gap vs. expectation | Implement Business Cloud API only; clear UI notice; no unofficial libraries |
| 2 | LinkedIn messaging API is partner-only | Cannot read inbox | Feature-flagged stub; optional notification-email ingestion |
| 3 | Google restricted Gmail scopes need verification + CASA assessment | Blocks public launch; test-user cap (100) | Design for it; use test users; budget time and cost |
| 4 | Microsoft Teams protected APIs and tenant admin consent | Delayed or partial Teams support | Delta polling fallback; document admin consent steps |
| 5 | Webhook subscriptions expire (Graph, Gmail watch, Google channels) | Silent sync gaps | Renewal jobs, alerting, polling backstop |
| 6 | LLM cost and privacy of sending mail to third parties | Spend, compliance | Quotas, redaction, per-channel AI-off, local model option |
| 7 | Prompt injection through email content | Wrong drafts or leaks | Data/instruction separation, no autonomous actions, confirm to send |
| 8 | Embedding model changes | Re-index cost | Versioned embeddings, background re-embed |

## Resolved decisions (user answers)
- LLM adapters after Anthropic: Gemini (Google), OpenAI, Grok (xAI). Ollama is not in the initial set.
- Embeddings: no local model; use a hosted embedding model through the gateway (provider chosen by admin; OpenAI or Gemini embeddings are the candidates). Confirm if "No" meant something else.
- Web client: Vite + React + TypeScript.
- App login: email, Google and Microsoft from day one.
- Shareable summary page: yes (published alongside docs/).

## Open decisions (need your input before or during Phase 1)
(Items 2 to 5 and the provider list in item 3 below are now resolved above; kept for history.)
1. **Cloud target** (Azure/AWS) is deferred; confirm decision point is Phase 6.
2. **Embedding provider**: default to a hosted embedding model or a local one (Ollama)?
3. **Which LLM providers to build adapters for first** beyond Anthropic (OpenAI, Azure OpenAI, Google, Ollama).
4. **Web client framework**: Vite React (recommended, simpler) or Next.js.
5. **Login providers for the app**: email + Google + Microsoft from day one, or email first?
6. **Hosted auth vs. self-built** (e.g. Keycloak/Auth0) versus NestJS-native OIDC. Self-built is assumed to stay free of new paid services.
7. **Design delivery format**: docs/ folder is used; say if you also want a single shareable page.
8. **Developer accounts** needed for Phase 2: Google Cloud project, Entra app registration (free), later Slack and Meta apps.
