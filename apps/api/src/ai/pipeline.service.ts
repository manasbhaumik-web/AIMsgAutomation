import { Injectable, Logger } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { GatewayError } from '../llm/types';
import { ConsentService } from './consent.service';
import { Analysis, localDate, neutralize, parseAnalysis, truncate, vectorLiteral } from './helpers';

const EMBED_TEXT_CHARS = 6000;
const EMBED_BATCH_ROWS = 100;
const ANALYZE_THREADS_PER_RUN = 25;
const THREAD_MESSAGES = 12;
const THREAD_CHARS = 12_000;

/** Gateway failures that mean "not set up" or "over quota": stop quietly and let the next tick retry. */
const SOFT_CODES = new Set(['route_not_configured', 'prompt_not_configured', 'quota_exceeded', 'ai_disabled', 'embed_unsupported', 'dimension_mismatch']);

/** Background AI work for one account: embed new messages, then tag/prioritize changed threads. */
@Injectable()
export class AiPipelineService {
  private readonly log = new Logger(AiPipelineService.name);

  constructor(private readonly db: Db, private readonly gateway: LlmGateway, private readonly consent: ConsentService) {}

  async ctxForAccount(accountId: string): Promise<DbCtx | null> {
    const r = await this.db.system((c) => c.query('SELECT * FROM sys_account_ctx($1)', [accountId]));
    const row = r.rows[0];
    return row ? { userId: row.user_id, tenantId: row.tenant_id, role: row.role, tenantRole: row.tenant_role } : null;
  }

  async runForAccount(accountId: string): Promise<{ embedded: number; analyzed: number }> {
    const ctx = await this.ctxForAccount(accountId);
    if (!ctx || !(await this.consent.has(ctx))) return { embedded: 0, analyzed: 0 };
    let embedded = 0;
    let analyzed = 0;
    try {
      embedded = await this.embedPending(ctx, accountId);
      analyzed = await this.analyzePending(ctx, accountId);
    } catch (e) {
      if (e instanceof GatewayError && SOFT_CODES.has(e.code)) {
        this.log.debug(`AI pipeline paused for account ${accountId}: ${e.code}`);
      } else throw e;
    }
    return { embedded, analyzed };
  }

  // ---- embeddings ---------------------------------------------------------------------------------------------

  async embedPending(ctx: DbCtx, accountId: string): Promise<number> {
    const model = await this.gateway.embedModel(ctx);
    if (!model) return 0;
    let total = 0;
    for (;;) {
      const rows = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT m.id, m.subject, m.body_text, m.tenant_id FROM messages m
             JOIN connected_accounts a ON a.id = m.account_id
             LEFT JOIN message_embeddings e ON e.message_id = m.id
             WHERE m.account_id = $1 AND a.ai_enabled AND (e.message_id IS NULL OR e.model <> $2)
             ORDER BY m."timestamp" DESC LIMIT $3`,
            [accountId, model, EMBED_BATCH_ROWS],
          ),
        )
      ).rows;
      if (!rows.length) return total;
      const { vectors, model: used } = await this.gateway.embed(ctx, rows.map((r) => truncate(`${r.subject ?? ''}\n${r.body_text}`, EMBED_TEXT_CHARS) || '(empty)'));
      await this.db.tx(ctx, async (c) => {
        for (let i = 0; i < rows.length; i++) {
          await c.query(
            `INSERT INTO message_embeddings(message_id, tenant_id, user_id, model, embedding) VALUES ($1,$2,$3,$4,$5::vector)
             ON CONFLICT (message_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()`,
            [rows[i].id, rows[i].tenant_id, ctx.userId, used, vectorLiteral(vectors[i])],
          );
        }
      });
      total += rows.length;
      if (rows.length < EMBED_BATCH_ROWS) return total;
    }
  }

  // ---- topics, priority, action items -------------------------------------------------------------------------

  async analyzePending(ctx: DbCtx, accountId: string): Promise<number> {
    const threads = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT t.id, t.last_message_at FROM threads t
           JOIN connected_accounts a ON a.id = t.account_id
           LEFT JOIN thread_analysis ta ON ta.thread_id = t.id
           WHERE t.account_id = $1 AND a.ai_enabled AND (ta.thread_id IS NULL OR ta.analyzed_through < t.last_message_at)
           ORDER BY t.last_message_at DESC LIMIT $2`,
          [accountId, ANALYZE_THREADS_PER_RUN],
        ),
      )
    ).rows;
    for (const t of threads) await this.analyzeThread(ctx, t.id, t.last_message_at);
    return threads.length;
  }

  async analyzeThread(ctx: DbCtx, threadId: string, lastMessageAt: Date): Promise<void> {
    const msgs = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT * FROM (SELECT sender, subject, body_text, "timestamp", direction FROM messages WHERE thread_id = $1 ORDER BY "timestamp" DESC LIMIT $2) x ORDER BY "timestamp"`,
          [threadId, THREAD_MESSAGES],
        ),
      )
    ).rows;
    if (!msgs.length) return;
    const perMessage = Math.max(400, Math.floor(THREAD_CHARS / msgs.length));
    const thread = msgs
      .map((m) => `[${new Date(m.timestamp).toISOString().slice(0, 16)}] ${m.direction === 'outbound' ? 'You' : (m.sender?.name ?? m.sender?.email ?? m.sender?.handle ?? 'Unknown')}\nSubject: ${m.subject ?? ''}\n${truncate(m.body_text, perMessage)}`)
      .join('\n\n');
    const topics = (await this.db.tx(ctx, (c) => c.query('SELECT name FROM topics WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [ctx.userId]))).rows.map((r) => r.name);

    const res = await this.gateway.run(ctx, 'topic-tag', { thread: neutralize(thread), topics: topics.join(', ') || '(none yet)', today: localDate('UTC', new Date()) });
    const parsed = parseAnalysis(res.text);
    await this.db.tx(ctx, async (c) => {
      const tenant = (await c.query('SELECT tenant_id FROM threads WHERE id = $1', [threadId])).rows[0]?.tenant_id;
      if (!tenant) return;
      if (!parsed) {
        // Unusable output is recorded as failed so it is not retried until the thread changes; provider errors never reach here.
        await this.saveAnalysis(c, ctx, tenant, threadId, lastMessageAt, null, res.model, res.promptVersion);
        return;
      }
      await this.saveAnalysis(c, ctx, tenant, threadId, lastMessageAt, parsed, res.model, res.promptVersion);
    });
  }

  private async saveAnalysis(
    c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }, ctx: DbCtx, tenant: string, threadId: string, through: Date,
    a: Analysis | null, model: string, promptVersion: number,
  ): Promise<void> {
    await c.query(
      `INSERT INTO thread_analysis(thread_id, tenant_id, user_id, priority, status, analyzed_through, model, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (thread_id) DO UPDATE SET priority = EXCLUDED.priority, status = EXCLUDED.status, analyzed_through = EXCLUDED.analyzed_through,
         model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, analyzed_at = now()`,
      [threadId, tenant, ctx.userId, a?.priority ?? null, a ? 'done' : 'failed', through, model, promptVersion],
    );
    await c.query('DELETE FROM thread_topics WHERE thread_id = $1', [threadId]);
    // Open items are regenerated from the latest thread state; completed ones are kept and not duplicated.
    await c.query(`DELETE FROM action_items WHERE thread_id = $1 AND status = 'open'`, [threadId]);
    if (!a) return;
    for (const name of a.topics) {
      const t = await c.query(
        `INSERT INTO topics(tenant_id, user_id, name) VALUES ($1,$2,$3) ON CONFLICT (user_id, name) DO UPDATE SET name = topics.name RETURNING id`,
        [tenant, ctx.userId, name],
      );
      await c.query('INSERT INTO thread_topics(thread_id, topic_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [threadId, t.rows[0].id, ctx.userId]);
    }
    for (const item of a.actionItems) {
      await c.query(
        `INSERT INTO action_items(tenant_id, user_id, thread_id, text, due_at)
         SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM action_items WHERE thread_id = $3 AND lower(text) = lower($4))`,
        [tenant, ctx.userId, threadId, item.text, item.due],
      );
    }
  }
}
