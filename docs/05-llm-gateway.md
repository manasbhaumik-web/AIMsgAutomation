# 05 LLM gateway

## Goal
Business logic calls `gateway.run(task, input)`. It never names a vendor. The admin chooses provider and model per task, so swapping providers needs no code change.

## Adapter interface
```ts
interface LlmProvider {
  kind: 'anthropic' | 'openai' | 'azure-openai' | 'google' | 'ollama';
  complete(req: LlmRequest): Promise<LlmResponse>;
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  embed(texts: string[], model: string): Promise<number[][]>;
}
```
Adapters normalise messages, tool/JSON output, token counts and errors. Adding a provider means adding one adapter. The first adapter built (Phase 1) is Anthropic; the others follow the same interface and are selectable from the admin console as soon as they exist.

## Task routing (admin-editable, stored in DB)
| Task | Typical tier |
|---|---|
| `classify`, `topic-tag` | small/fast |
| `summarize` | mid |
| `chat`, `draft-reply` | strongest |
| `embed` | embedding model |

Each route: provider, model, temperature, max_tokens, timeout, retries, fallback route.

## Behaviour
1. Resolve route, load the active prompt template version (DB), render with variables.
2. Apply policy: skip if channel `ai_enabled=false`; redact emails, phone numbers and IDs by regex plus configurable patterns (reversible mapping kept in memory only for the call).
3. Check quota and token budget (Redis counters plus ledger); reject with 429 when exceeded.
4. Call the provider with timeout; retry on 429/5xx with jittered backoff; on persistent failure use the fallback route.
5. Write `usage_ledger` (tokens, estimated cost, latency, route, prompt version). Prompt content is not logged by default.

## Admin console (Phase 1 skeleton)
Provider CRUD (API key encrypted at rest, never returned after save), route editor, prompt template versioning with activate/rollback, quota editor, usage report, "test connection" button. Every change is audit-logged.

## Embeddings
Embedding model and dimension are stored on each row. Changing the model triggers a background re-embed job and a new column or table version, so mixed dimensions never meet in one index.
