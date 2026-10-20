export const LLM_TASKS = ['classify', 'topic-tag', 'summarize', 'digest', 'chat', 'draft-reply', 'embed'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export const PROVIDER_KINDS = ['anthropic', 'openai', 'azure-openai', 'google', 'xai', 'ollama'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Fixed vector width of message_embeddings. Adapters must return exactly this many dimensions. */
export const EMBED_DIM = 1536;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** Streaming yields text deltas and, when the provider reports it, token usage. */
export interface LlmChunk {
  text?: string;
  usage?: { tokensIn?: number; tokensOut?: number };
}

export interface EmbedRequest {
  model: string;
  texts: string[];
  dimensions: number;
  timeoutMs: number;
}

export interface EmbedResponse {
  vectors: number[][];
  tokensIn: number;
}

export interface ProviderConn {
  kind: ProviderKind;
  baseUrl?: string | null;
  apiKey: string;
}

/** One adapter per vendor. Business code never sees vendor-specific shapes. */
export interface LlmAdapter {
  readonly kind: ProviderKind;
  complete(conn: ProviderConn, req: LlmRequest): Promise<LlmResponse>;
  stream(conn: ProviderConn, req: LlmRequest): AsyncIterable<LlmChunk>;
  /** Absent when the vendor has no embeddings API (Anthropic). */
  embed?(conn: ProviderConn, req: EmbedRequest): Promise<EmbedResponse>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export type GatewayErrorCode =
  | 'ai_disabled' | 'route_not_configured' | 'prompt_not_configured' | 'quota_exceeded' | 'upstream_failed'
  | 'bad_template' | 'embed_unsupported' | 'dimension_mismatch';

export class GatewayError extends Error {
  constructor(readonly code: GatewayErrorCode, message: string) {
    super(message);
  }
}
