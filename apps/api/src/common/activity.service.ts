import { Injectable } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';

export interface ActivityEntry {
  actor: 'user' | 'workflow' | 'system';
  kind: string;
  summary: string;
  workflowId?: string | null;
  runId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * The user-readable record of everything done for them: drafts, sends, approvals, calendar changes and reports.
 * (AuditService is the operator-facing log; this is what the person sees about their own account.)
 * Summaries are short sentences and never contain message text, tokens or file contents.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly db: Db) {}

  async log(ctx: DbCtx, e: ActivityEntry): Promise<void> {
    await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO activity_log(tenant_id, user_id, workflow_id, run_id, actor, kind, summary, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.tenantId, ctx.userId, e.workflowId ?? null, e.runId ?? null, e.actor, e.kind, e.summary.slice(0, 300), JSON.stringify(e.meta ?? {})],
      ),
    );
  }

  async list(ctx: DbCtx, o: { limit: number; before?: number; kind?: string }) {
    const r = await this.db.tx(ctx, (c) =>
      c.query(
        `SELECT id, workflow_id, run_id, actor, kind, summary, meta, at FROM activity_log
         WHERE ($1::bigint IS NULL OR id < $1) AND ($3::text IS NULL OR kind LIKE $3 || '%') ORDER BY id DESC LIMIT $2`,
        [o.before ?? null, o.limit, o.kind ?? null],
      ),
    );
    return r.rows;
  }
}
