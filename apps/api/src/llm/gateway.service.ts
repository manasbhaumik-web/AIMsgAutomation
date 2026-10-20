import { Injectable } from '@nestjs/common';
import { DbCtx } from '../db/db.service';
import { GatewayStore, PromptConfig, RouteConfig } from './gateway.store';
import { AdapterRegistry } from './registry';
import { Redactor, StreamRestorer, renderTemplate } from './redact';
import { withRetry } from './retry';
import { EMBED_DIM, GatewayError, LlmError, LlmRequest, LlmTask, ProviderConn } from './types';

export interface RunOptions {
  /** False when the user switched AI off for this channel/account. */
  aiEnabled?: boolean;
  /** Default true. Disable only for providers the admin has marked as local/trusted. */
  redact?: boolean;
}

export interface RunResult {
  text: string;
  model: string;
  providerKind: string;
  tokensIn: number;
  tokensOut: number;
  promptVersion: number;
  usedFallback: boolean;
}

export type StreamEvent = { type: 'text'; text: string } | { type: 'end'; meta: Omit<RunResult, 'text'> };

interface Prepared {
  route: RouteConfig;
  prompt: PromptConfig;
  content: string;
  redactor: Redactor;
  shouldRedact: boolean;
}

const EMBED_BATCH = 64;

/**
 * Single entry point for every LLM call. Callers name a task, never a vendor.
 * Order: policy -> route/prompt lookup -> quota -> call with retry -> fallback -> usage ledger.
 */
@Injectable()
export class LlmGateway {
  constructor(private readonly store: GatewayStore, private readonly adapters: AdapterRegistry) {}

  private async checkQuota(ctx: DbCtx): Promise<void> {
    const [used, limit] = await Promise.all([this.store.tokensUsedToday(ctx), this.store.dailyTokenLimit(ctx)]);
    if (limit !== null && used >= limit) throw new GatewayError('quota_exceeded', 'Daily AI token quota reached');
  }

  private async prepare(ctx: DbCtx, task: LlmTask, vars: Record<string, string>, opts: RunOptions): Promise<Prepared> {
    if (opts.aiEnabled === false) throw new GatewayError('ai_disabled', 'AI processing is turned off for this source');
    const route = await this.store.getRoute(ctx, task);
    if (!route) throw new GatewayError('route_not_configured', `No usable route configured for task "${task}"`);
    const prompt = await this.store.getActivePrompt(ctx, task);
    if (!prompt) throw new GatewayError('prompt_not_configured', `No active prompt for task "${task}"`);
    await this.checkQuota(ctx);

    const redactor = new Redactor();
    const shouldRedact = opts.redact !== false;
    try {
      const safeVars = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, shouldRedact ? redactor.redact(v) : v]));
      return { route, prompt, content: renderTemplate(prompt.body, safeVars), redactor, shouldRedact };
    } catch (e) {
      throw new GatewayError('bad_template', (e as Error).message);
    }
  }

  private attempts(route: RouteConfig): { conn: ProviderConn; model: string; fallback: boolean }[] {
    return [{ ...route.primary, fallback: false }, ...(route.fallback ? [{ ...route.fallback, fallback: true }] : [])];
  }

  private request(p: Prepared, model: string): LlmRequest {
    return {
      model,
      system: p.prompt.system ?? undefined,
      messages: [{ role: 'user', content: p.content }],
      temperature: p.route.temperature,
      maxTokens: p.route.maxTokens,
      timeoutMs: p.route.timeoutMs,
    };
  }

  async run(ctx: DbCtx, task: LlmTask, vars: Record<string, string>, opts: RunOptions = {}): Promise<RunResult> {
    const p = await this.prepare(ctx, task, vars, opts);
    for (const a of this.attempts(p.route)) {
      const started = Date.now();
      try {
        const adapter = this.adapters.get(a.conn.kind);
        const res = await withRetry(() => adapter.complete(a.conn, this.request(p, a.model)), { retries: p.route.retries, isRetryable: (e) => e instanceof LlmError && e.retryable });
        await this.store.recordUsage(ctx, { task, providerKind: a.conn.kind, model: a.model, tokensIn: res.tokensIn, tokensOut: res.tokensOut, cost: this.cost(p.route, res.tokensIn, res.tokensOut), latencyMs: Date.now() - started, ok: true });
        return {
          text: p.shouldRedact ? p.redactor.restore(res.text) : res.text,
          model: a.model,
          providerKind: a.conn.kind,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          promptVersion: p.prompt.version,
          usedFallback: a.fallback,
        };
      } catch (e) {
        await this.failed(ctx, task, a, started);
        if (!this.isUpstream(e)) throw e;
      }
    }
    throw new GatewayError('upstream_failed', 'All configured providers failed');
  }

  /**
   * Streaming variant of run(). Falls back to the second route only if the first fails before producing any text;
   * once text has reached the caller the stream cannot be restarted, so a mid-stream error propagates.
   */
  async *stream(ctx: DbCtx, task: LlmTask, vars: Record<string, string>, opts: RunOptions = {}): AsyncGenerator<StreamEvent> {
    const p = await this.prepare(ctx, task, vars, opts);
    for (const a of this.attempts(p.route)) {
      const started = Date.now();
      let produced = false;
      let tokensIn = 0;
      let tokensOut = 0;
      let chars = 0;
      const restorer = new StreamRestorer(p.redactor);
      try {
        const adapter = this.adapters.get(a.conn.kind);
        for await (const chunk of adapter.stream(a.conn, this.request(p, a.model))) {
          if (chunk.usage?.tokensIn !== undefined) tokensIn = chunk.usage.tokensIn;
          if (chunk.usage?.tokensOut !== undefined) tokensOut = chunk.usage.tokensOut;
          if (chunk.text) {
            produced = true;
            chars += chunk.text.length;
            const out = p.shouldRedact ? restorer.push(chunk.text) : chunk.text;
            if (out) yield { type: 'text', text: out };
          }
        }
        const tail = p.shouldRedact ? restorer.flush() : '';
        if (tail) yield { type: 'text', text: tail };
        if (!tokensOut) tokensOut = Math.ceil(chars / 4); // provider did not report usage
        await this.store.recordUsage(ctx, { task, providerKind: a.conn.kind, model: a.model, tokensIn, tokensOut, cost: this.cost(p.route, tokensIn, tokensOut), latencyMs: Date.now() - started, ok: true });
        yield { type: 'end', meta: { model: a.model, providerKind: a.conn.kind, tokensIn, tokensOut, promptVersion: p.prompt.version, usedFallback: a.fallback } };
        return;
      } catch (e) {
        await this.failed(ctx, task, a, started);
        if (produced || !this.isUpstream(e)) throw e;
      }
    }
    throw new GatewayError('upstream_failed', 'All configured providers failed');
  }

  /** Model currently routed for embeddings, or null. Stored vectors from any other model are stale. */
  async embedModel(ctx: DbCtx): Promise<string | null> {
    return (await this.store.getRoute(ctx, 'embed'))?.primary.model ?? null;
  }

  /**
   * Embeds texts with the `embed` route. There is deliberately no fallback: vectors from two models are not
   * comparable, so mixing them would silently break search.
   */
  async embed(ctx: DbCtx, texts: string[], opts: RunOptions = {}): Promise<{ vectors: number[][]; model: string }> {
    if (opts.aiEnabled === false) throw new GatewayError('ai_disabled', 'AI processing is turned off for this source');
    const route = await this.store.getRoute(ctx, 'embed');
    if (!route) throw new GatewayError('route_not_configured', 'No usable route configured for task "embed"');
    const adapter = this.adapters.get(route.primary.conn.kind);
    if (!adapter.embed) throw new GatewayError('embed_unsupported', `Provider "${route.primary.conn.kind}" has no embeddings API`);
    await this.checkQuota(ctx);

    const redactor = new Redactor();
    const input = opts.redact === false ? texts : texts.map((t) => redactor.redact(t));
    const vectors: number[][] = [];
    for (let i = 0; i < input.length; i += EMBED_BATCH) {
      const started = Date.now();
      const batch = input.slice(i, i + EMBED_BATCH);
      try {
        const res = await withRetry(() => adapter.embed!(route.primary.conn, { model: route.primary.model, texts: batch, dimensions: EMBED_DIM, timeoutMs: route.timeoutMs }), {
          retries: route.retries,
          isRetryable: (e) => e instanceof LlmError && e.retryable,
        });
        if (res.vectors.some((v) => v.length !== EMBED_DIM)) {
          throw new GatewayError('dimension_mismatch', `Model "${route.primary.model}" returned ${res.vectors[0]?.length} dimensions; ${EMBED_DIM} are required. Pick a model that supports a ${EMBED_DIM}-dimension output.`);
        }
        await this.store.recordUsage(ctx, { task: 'embed', providerKind: route.primary.conn.kind, model: route.primary.model, tokensIn: res.tokensIn, tokensOut: 0, cost: this.cost(route, res.tokensIn, 0), latencyMs: Date.now() - started, ok: true });
        vectors.push(...res.vectors);
      } catch (e) {
        await this.store.recordUsage(ctx, { task: 'embed', providerKind: route.primary.conn.kind, model: route.primary.model, tokensIn: 0, tokensOut: 0, cost: null, latencyMs: Date.now() - started, ok: false }).catch(() => undefined);
        if (e instanceof GatewayError) throw e;
        if (this.isUpstream(e)) throw new GatewayError('upstream_failed', 'Embedding provider failed');
        throw e;
      }
    }
    return { vectors, model: route.primary.model };
  }

  private isUpstream(e: unknown): boolean {
    return e instanceof LlmError || (e instanceof Error && e.message.startsWith('No adapter'));
  }

  private failed(ctx: DbCtx, task: LlmTask, a: { conn: ProviderConn; model: string }, started: number): Promise<void> {
    return this.store.recordUsage(ctx, { task, providerKind: a.conn.kind, model: a.model, tokensIn: 0, tokensOut: 0, cost: null, latencyMs: Date.now() - started, ok: false }).catch(() => undefined);
  }

  private cost(r: RouteConfig, tin: number, tout: number): number | null {
    if (r.priceInPerMtok === null || r.priceOutPerMtok === null) return null;
    return (tin * r.priceInPerMtok + tout * r.priceOutPerMtok) / 1_000_000;
  }
}
