import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Roles, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { CryptoService } from '../crypto/crypto.service';
import { Db } from '../db/db.service';
import { AdapterRegistry } from '../llm/registry';
import { assertSafeProviderUrl } from '../llm/url-guard';
import { LLM_TASKS, PROVIDER_KINDS } from '../llm/types';

const providerCreate = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(8).max(500),
  enabled: z.boolean().optional(),
});
const providerPatch = z.object({
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(8).max(500).optional(),
  enabled: z.boolean().optional(),
});
const route = z.object({
  providerId: z.string().uuid(),
  model: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(1).max(200_000).default(1024),
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  retries: z.number().int().min(0).max(5).default(2),
  fallbackProviderId: z.string().uuid().nullable().optional(),
  fallbackModel: z.string().min(1).max(120).nullable().optional(),
  priceInPerMtok: z.number().min(0).nullable().optional(),
  priceOutPerMtok: z.number().min(0).nullable().optional(),
});
const promptCreate = z.object({ task: z.enum(LLM_TASKS), system: z.string().max(20_000).nullable().optional(), body: z.string().min(1).max(50_000) });
const quotaPut = z.object({
  scope: z.enum(['global', 'tenant', 'user']),
  scopeId: z.string().uuid().optional(),
  tokensPerDay: z.number().int().min(0).nullable().optional(),
  requestsPerMin: z.number().int().min(1).nullable().optional(),
});
const testBody = z.object({ model: z.string().min(1).max(120) });

const NIL = '00000000-0000-0000-0000-000000000000';

/** Platform admin console API. Every mutation is audited and enforced again by RLS. */
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly db: Db, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly adapters: AdapterRegistry) {}

  // ---- providers (API keys are write-only) ----
  @Get('llm/providers')
  async providers(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query('SELECT id, name, kind, base_url, enabled, (enc_api_key IS NOT NULL) AS has_key, created_at FROM llm_providers ORDER BY name'),
    );
    const supported = new Set(this.adapters.supported());
    return r.rows.map((p) => ({ ...p, adapterAvailable: supported.has(p.kind) }));
  }

  @Post('llm/providers')
  async createProvider(@CurrentUser() u: AuthUser, @Body(new ZodPipe(providerCreate)) b: z.infer<typeof providerCreate>) {
    assertSafeProviderUrl(b.baseUrl, b.kind);
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query('INSERT INTO llm_providers(name, kind, base_url, enc_api_key, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, kind', [
        b.name, b.kind, b.baseUrl ?? null, this.crypto.encrypt(b.apiKey), b.enabled ?? true,
      ]),
    );
    await this.audit.log(dbCtx(u), 'admin.provider.create', r.rows[0].id, { name: b.name, kind: b.kind });
    return r.rows[0];
  }

  @Patch('llm/providers/:id')
  async patchProvider(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(providerPatch)) b: z.infer<typeof providerPatch>) {
    if (b.baseUrl) {
      const kind = (await this.db.tx(dbCtx(u), (c) => c.query('SELECT kind FROM llm_providers WHERE id = $1', [id]))).rows[0]?.kind;
      if (!kind) throw new NotFoundException();
      assertSafeProviderUrl(b.baseUrl, kind);
    }
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `UPDATE llm_providers SET name = coalesce($2, name), base_url = CASE WHEN $3::boolean THEN $4 ELSE base_url END,
           enc_api_key = coalesce($5, enc_api_key), enabled = coalesce($6, enabled) WHERE id = $1 RETURNING id`,
        [id, b.name ?? null, b.baseUrl !== undefined, b.baseUrl ?? null, b.apiKey ? this.crypto.encrypt(b.apiKey) : null, b.enabled ?? null],
      ),
    );
    if (!r.rowCount) throw new NotFoundException();
    await this.audit.log(dbCtx(u), 'admin.provider.update', id, { keyRotated: !!b.apiKey, enabled: b.enabled });
    return { id };
  }

  @HttpCode(204) @Delete('llm/providers/:id')
  async deleteProvider(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    try {
      const r = await this.db.tx(dbCtx(u), (c) => c.query('DELETE FROM llm_providers WHERE id = $1', [id]));
      if (!r.rowCount) throw new NotFoundException();
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new BadRequestException('Provider is used by a route. Change the route first.');
      throw e;
    }
    await this.audit.log(dbCtx(u), 'admin.provider.delete', id);
  }

  @HttpCode(200) @Post('llm/providers/:id/test')
  async testProvider(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(testBody)) b: z.infer<typeof testBody>) {
    const r = await this.db.tx(dbCtx(u), (c) => c.query('SELECT kind, base_url, enc_api_key FROM llm_providers WHERE id = $1', [id]));
    const p = r.rows[0];
    if (!p) throw new NotFoundException();
    const adapter = this.adapters.get(p.kind);
    const started = Date.now();
    try {
      await adapter.complete({ kind: p.kind, baseUrl: p.base_url, apiKey: this.crypto.decrypt(p.enc_api_key) }, {
        model: b.model, messages: [{ role: 'user', content: 'Reply with OK.' }], temperature: 0, maxTokens: 8, timeoutMs: 15_000,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---- routes ----
  @Get('llm/routes')
  async routes(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) => c.query('SELECT * FROM llm_routes ORDER BY task'));
    return r.rows;
  }

  @Put('llm/routes/:task')
  async putRoute(@CurrentUser() u: AuthUser, @Param('task') task: string, @Body(new ZodPipe(route)) b: z.infer<typeof route>) {
    if (!(LLM_TASKS as readonly string[]).includes(task)) throw new BadRequestException('Unknown task');
    if (!!b.fallbackProviderId !== !!b.fallbackModel) throw new BadRequestException('Fallback needs both a provider and a model');
    const ps = await this.db.tx(dbCtx(u), (c) => c.query('SELECT id, kind FROM llm_providers WHERE id = ANY($1::uuid[])', [[b.providerId, b.fallbackProviderId ?? b.providerId]]));
    const supported = new Set(this.adapters.supported());
    for (const p of ps.rows) if (!supported.has(p.kind)) throw new BadRequestException(`No adapter is available yet for provider kind "${p.kind}"`);
    if (!ps.rows.some((p) => p.id === b.providerId)) throw new BadRequestException('Unknown provider');
    if (task === 'embed') {
      const primary = ps.rows.find((p) => p.id === b.providerId);
      if (!this.adapters.supportsEmbed(primary.kind)) throw new BadRequestException(`Provider kind "${primary.kind}" has no embeddings API. Use OpenAI, Gemini or xAI for the embed task.`);
      if (b.fallbackProviderId) throw new BadRequestException('The embed task cannot have a fallback: vectors from different models are not comparable.');
    }
    await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `INSERT INTO llm_routes(task, provider_id, model, temperature, max_tokens, timeout_ms, retries, fallback_provider_id, fallback_model, price_in_per_mtok, price_out_per_mtok)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (task) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, temperature = EXCLUDED.temperature,
           max_tokens = EXCLUDED.max_tokens, timeout_ms = EXCLUDED.timeout_ms, retries = EXCLUDED.retries,
           fallback_provider_id = EXCLUDED.fallback_provider_id, fallback_model = EXCLUDED.fallback_model,
           price_in_per_mtok = EXCLUDED.price_in_per_mtok, price_out_per_mtok = EXCLUDED.price_out_per_mtok, updated_at = now()`,
        [task, b.providerId, b.model, b.temperature, b.maxTokens, b.timeoutMs, b.retries, b.fallbackProviderId ?? null, b.fallbackModel ?? null, b.priceInPerMtok ?? null, b.priceOutPerMtok ?? null],
      ),
    );
    await this.audit.log(dbCtx(u), 'admin.route.put', task, { model: b.model, providerId: b.providerId });
    return { task };
  }

  // ---- prompts (append-only versions; one active per task) ----
  @Get('prompts')
  async prompts(@CurrentUser() u: AuthUser, @Query('task') task?: string) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query('SELECT id, task, version, system, body, active, created_at FROM prompt_templates WHERE ($1::text IS NULL OR task = $1) ORDER BY task, version DESC', [task ?? null]),
    );
    return r.rows;
  }

  @Post('prompts')
  async createPrompt(@CurrentUser() u: AuthUser, @Body(new ZodPipe(promptCreate)) b: z.infer<typeof promptCreate>) {
    const r = await this.db.tx(dbCtx(u), async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`prompt:${b.task}`]);
      return c.query(
        `INSERT INTO prompt_templates(task, version, system, body, created_by)
         VALUES ($1, coalesce((SELECT max(version) FROM prompt_templates WHERE task = $1), 0) + 1, $2, $3, $4) RETURNING id, version`,
        [b.task, b.system ?? null, b.body, u.id],
      );
    });
    await this.audit.log(dbCtx(u), 'admin.prompt.create', r.rows[0].id, { task: b.task, version: r.rows[0].version });
    return r.rows[0];
  }

  @HttpCode(200) @Post('prompts/:id/activate')
  async activatePrompt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.tx(dbCtx(u), async (c) => {
      const p = await c.query('SELECT task FROM prompt_templates WHERE id = $1', [id]);
      if (!p.rows[0]) throw new NotFoundException();
      await c.query('UPDATE prompt_templates SET active = false WHERE task = $1 AND active', [p.rows[0].task]);
      await c.query('UPDATE prompt_templates SET active = true WHERE id = $1', [id]);
    });
    await this.audit.log(dbCtx(u), 'admin.prompt.activate', id);
    return { id };
  }

  // ---- quotas, usage, audit ----
  @Get('quotas')
  async quotas(@CurrentUser() u: AuthUser) {
    return (await this.db.tx(dbCtx(u), (c) => c.query('SELECT * FROM quotas ORDER BY scope'))).rows;
  }

  @Put('quotas')
  async putQuota(@CurrentUser() u: AuthUser, @Body(new ZodPipe(quotaPut)) b: z.infer<typeof quotaPut>) {
    if (b.scope !== 'global' && !b.scopeId) throw new BadRequestException('scopeId is required for tenant and user quotas');
    await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `INSERT INTO quotas(scope, scope_id, tokens_per_day, requests_per_min) VALUES ($1,$2,$3,$4)
         ON CONFLICT (scope, scope_id) DO UPDATE SET tokens_per_day = EXCLUDED.tokens_per_day, requests_per_min = EXCLUDED.requests_per_min`,
        [b.scope, b.scopeId ?? NIL, b.tokensPerDay ?? null, b.requestsPerMin ?? null],
      ),
    );
    await this.audit.log(dbCtx(u), 'admin.quota.put', b.scopeId ?? 'global', { scope: b.scope, tokensPerDay: b.tokensPerDay });
    return { ok: true };
  }

  @Get('usage')
  async usage(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `SELECT date_trunc('day', at) AS day, task, model, count(*)::int AS calls, sum(tokens_in)::bigint AS tokens_in,
                sum(tokens_out)::bigint AS tokens_out, sum(cost) AS cost, count(*) FILTER (WHERE NOT ok)::int AS failures
         FROM usage_ledger WHERE at > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2`,
      ),
    );
    return r.rows;
  }

  @Get('audit')
  async auditLog(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return (await this.db.tx(dbCtx(u), (c) => c.query('SELECT id, actor_id, action, target, meta, at FROM audit_log ORDER BY id DESC LIMIT $1', [n]))).rows;
  }
}
