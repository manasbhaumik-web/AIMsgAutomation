import { Injectable, Optional } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { MetricsService } from '../observability/metrics.service';
import { LlmTask, ProviderConn, ProviderKind } from './types';

export interface RouteConfig {
  task: LlmTask;
  primary: { conn: ProviderConn; model: string };
  fallback?: { conn: ProviderConn; model: string };
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  priceInPerMtok: number | null;
  priceOutPerMtok: number | null;
}

export interface PromptConfig {
  system: string | null;
  body: string;
  version: number;
}

export interface UsageRecord {
  task: LlmTask;
  providerKind: ProviderKind;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  latencyMs: number;
  ok: boolean;
}

/** Persistence seam so the gateway logic can be tested without a database. */
export abstract class GatewayStore {
  abstract getRoute(ctx: DbCtx, task: LlmTask): Promise<RouteConfig | null>;
  abstract getActivePrompt(ctx: DbCtx, task: LlmTask): Promise<PromptConfig | null>;
  abstract tokensUsedToday(ctx: DbCtx): Promise<number>;
  /** Lowest applicable daily token limit (global, tenant, user), or null for unlimited. */
  abstract dailyTokenLimit(ctx: DbCtx): Promise<number | null>;
  abstract recordUsage(ctx: DbCtx, u: UsageRecord): Promise<void>;
}

@Injectable()
export class PgGatewayStore extends GatewayStore {
  constructor(private readonly db: Db, private readonly crypto: CryptoService, @Optional() private readonly metrics?: MetricsService) {
    super();
  }

  async getRoute(ctx: DbCtx, task: LlmTask): Promise<RouteConfig | null> {
    const r = await this.db.tx(ctx, (c) =>
      c.query(
        `SELECT r.*, p.kind AS p_kind, p.base_url AS p_base, p.enc_api_key AS p_key, p.enabled AS p_enabled,
                f.kind AS f_kind, f.base_url AS f_base, f.enc_api_key AS f_key, f.enabled AS f_enabled
         FROM llm_routes r JOIN llm_providers p ON p.id = r.provider_id
         LEFT JOIN llm_providers f ON f.id = r.fallback_provider_id WHERE r.task = $1`,
        [task],
      ),
    );
    const row = r.rows[0];
    if (!row || !row.p_enabled || !row.p_key) return null;
    const fallback =
      row.f_kind && row.f_enabled && row.f_key && row.fallback_model
        ? { conn: { kind: row.f_kind, baseUrl: row.f_base, apiKey: this.crypto.decrypt(row.f_key) }, model: row.fallback_model }
        : undefined;
    return {
      task,
      primary: { conn: { kind: row.p_kind, baseUrl: row.p_base, apiKey: this.crypto.decrypt(row.p_key) }, model: row.model },
      fallback,
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      timeoutMs: row.timeout_ms,
      retries: row.retries,
      priceInPerMtok: row.price_in_per_mtok === null ? null : Number(row.price_in_per_mtok),
      priceOutPerMtok: row.price_out_per_mtok === null ? null : Number(row.price_out_per_mtok),
    };
  }

  async getActivePrompt(ctx: DbCtx, task: LlmTask): Promise<PromptConfig | null> {
    const r = await this.db.tx(ctx, (c) => c.query('SELECT system, body, version FROM prompt_templates WHERE task = $1 AND active', [task]));
    return r.rows[0] ?? null;
  }

  async tokensUsedToday(ctx: DbCtx): Promise<number> {
    const r = await this.db.tx(ctx, (c) =>
      c.query(`SELECT coalesce(sum(tokens_in + tokens_out), 0)::bigint AS n FROM usage_ledger WHERE user_id = $1 AND at >= date_trunc('day', now())`, [ctx.userId]),
    );
    return Number(r.rows[0].n);
  }

  async dailyTokenLimit(ctx: DbCtx): Promise<number | null> {
    const r = await this.db.tx(ctx, (c) =>
      c.query(
        `SELECT min(tokens_per_day) AS lim FROM quotas WHERE tokens_per_day IS NOT NULL AND
           (scope = 'global' OR (scope = 'tenant' AND scope_id = $1) OR (scope = 'user' AND scope_id = $2))`,
        [ctx.tenantId ?? '00000000-0000-0000-0000-000000000000', ctx.userId ?? '00000000-0000-0000-0000-000000000000'],
      ),
    );
    return r.rows[0].lim === null ? null : Number(r.rows[0].lim);
  }

  async recordUsage(ctx: DbCtx, u: UsageRecord): Promise<void> {
    const m = this.metrics;
    if (m) {
      m.llmCalls.inc({ task: u.task, provider: u.providerKind, ok: String(u.ok) });
      m.llmTokens.inc({ task: u.task, provider: u.providerKind, direction: 'in' }, u.tokensIn);
      m.llmTokens.inc({ task: u.task, provider: u.providerKind, direction: 'out' }, u.tokensOut);
      if (u.latencyMs !== null && u.latencyMs !== undefined) m.llmSeconds.observe({ task: u.task, provider: u.providerKind }, u.latencyMs / 1000);
    }
    await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO usage_ledger(user_id, tenant_id, task, provider_kind, model, tokens_in, tokens_out, cost, latency_ms, ok)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [ctx.userId, ctx.tenantId ?? null, u.task, u.providerKind, u.model, u.tokensIn, u.tokensOut, u.cost, u.latencyMs, u.ok],
      ),
    );
  }
}
