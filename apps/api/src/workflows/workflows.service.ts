import { Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../common/activity.service';
import { Db, DbCtx } from '../db/db.service';
import { WorkflowInput } from './workflow.schema';

const COLS = 'id, name, description, enabled, autonomy, trigger, conditions, actions, policy, template_id, scan_from, last_run_at, created_at, updated_at';

@Injectable()
export class WorkflowsService {
  constructor(private readonly db: Db, private readonly activity: ActivityService) {}

  async list(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query(`SELECT ${COLS} FROM workflows ORDER BY created_at DESC`))).rows;
  }

  async get(ctx: DbCtx, id: string) {
    const r = (await this.db.tx(ctx, (c) => c.query(`SELECT ${COLS} FROM workflows WHERE id = $1`, [id]))).rows[0];
    if (!r) throw new NotFoundException('Workflow not found');
    return r;
  }

  async create(ctx: DbCtx, w: WorkflowInput, templateId: string | null = null) {
    const r = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO workflows(tenant_id, user_id, name, description, enabled, autonomy, trigger, conditions, actions, policy, template_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
          [ctx.tenantId, ctx.userId, w.name, w.description, w.enabled, w.autonomy, JSON.stringify(w.trigger), JSON.stringify(w.conditions), JSON.stringify(w.actions), JSON.stringify(w.policy), templateId],
        ),
      )
    ).rows[0];
    await this.activity.log(ctx, { actor: 'user', kind: 'workflow.create', summary: `Created workflow "${w.name}" (${w.autonomy})`, workflowId: r.id });
    return r;
  }

  /** Re-enabling resets the scan point, so a workflow never acts on mail that arrived while it was off. */
  async update(ctx: DbCtx, id: string, w: WorkflowInput) {
    const before = await this.get(ctx, id);
    const r = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `UPDATE workflows SET name = $2, description = $3, enabled = $4, autonomy = $5, trigger = $6, conditions = $7, actions = $8, policy = $9,
                  scan_from = CASE WHEN $4 AND NOT enabled THEN now() ELSE scan_from END, updated_at = now()
           WHERE id = $1 RETURNING ${COLS}`,
          [id, w.name, w.description, w.enabled, w.autonomy, JSON.stringify(w.trigger), JSON.stringify(w.conditions), JSON.stringify(w.actions), JSON.stringify(w.policy)],
        ),
      )
    ).rows[0];
    const flipped = before.enabled !== w.enabled ? (w.enabled ? ' and turned it on' : ' and turned it off') : '';
    await this.activity.log(ctx, { actor: 'user', kind: 'workflow.update', summary: `Updated workflow "${w.name}"${flipped}${before.autonomy !== w.autonomy ? `, now ${w.autonomy}` : ''}`, workflowId: id });
    return r;
  }

  async setEnabled(ctx: DbCtx, id: string, enabled: boolean) {
    const r = (
      await this.db.tx(ctx, (c) =>
        c.query(`UPDATE workflows SET enabled = $2, scan_from = CASE WHEN $2 AND NOT enabled THEN now() ELSE scan_from END, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, enabled]),
      )
    ).rows[0];
    if (!r) throw new NotFoundException('Workflow not found');
    await this.activity.log(ctx, { actor: 'user', kind: enabled ? 'workflow.enable' : 'workflow.disable', summary: `${enabled ? 'Turned on' : 'Turned off'} workflow "${r.name}"`, workflowId: id });
    return r;
  }

  async remove(ctx: DbCtx, id: string): Promise<void> {
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM workflows WHERE id = $1 RETURNING name', [id]));
    if (!r.rowCount) throw new NotFoundException('Workflow not found');
    await this.activity.log(ctx, { actor: 'user', kind: 'workflow.delete', summary: `Deleted workflow "${r.rows[0].name}"` });
  }

  async runs(ctx: DbCtx, workflowId: string, limit = 20) {
    return (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT id, trigger_type, thread_id, status, steps, error, manual, started_at, finished_at FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT $2`,
          [workflowId, limit],
        ),
      )
    ).rows;
  }
}
