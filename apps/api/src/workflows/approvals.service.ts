import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { CalendarActionsService } from '../calendar/calendar-actions.service';
import { ActivityService } from '../common/activity.service';
import { AuditService } from '../common/audit.service';
import { Db, DbCtx } from '../db/db.service';
import { RepliesService } from '../replies/replies.service';

export type ApprovalKind = 'send_reply' | 'create_event';

/** JSON with sorted keys, so the same payload always hashes to the same value. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
export const payloadHash = (p: unknown): string => createHash('sha256').update(stableStringify(p), 'utf8').digest('hex');

/** Why a service call failed, in words that are safe to show and to store in a run log. */
export function reasonOf(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    const m = typeof r === 'string' ? r : (r as { message?: unknown }).message;
    return Array.isArray(m) ? m.join('; ') : String(m ?? e.message);
  }
  return 'An unexpected error stopped this step.';
}
const codeOf = (e: unknown): string | undefined => (e instanceof HttpException ? ((e.getResponse() as { code?: string })?.code) : undefined);

/** Failures that mean "look again and confirm", not "this request is dead": the approval stays open. */
const RECOVERABLE = new Set(['thread_changed', 'event_conflict']);

/**
 * The approval queue. A workflow that wants to send a message or change a calendar does not do it: it files an approval
 * holding the exact content and a hash of it. A person approves by presenting that hash (as the screen showed it), which
 * then runs the same confirmed-send or calendar path a manual action uses. Approvals expire after 48 hours.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: Db,
    private readonly replies: RepliesService,
    private readonly calendar: CalendarActionsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: DbCtx, a: { workflowId: string | null; runId: string | null; kind: ApprovalKind; summary: string; payload: Record<string, unknown> }) {
    const row = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO approvals(tenant_id, user_id, workflow_id, run_id, kind, summary, payload, payload_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, kind, summary, payload, payload_hash, status, expires_at, created_at`,
          [ctx.tenantId, ctx.userId, a.workflowId, a.runId, a.kind, a.summary.slice(0, 300), JSON.stringify(a.payload), payloadHash(a.payload)],
        ),
      )
    ).rows[0];
    await this.activity.log(ctx, { actor: 'workflow', kind: 'approval.request', summary: `Waiting for your approval: ${a.summary.slice(0, 200)}`, workflowId: a.workflowId, runId: a.runId, meta: { approvalId: row.id } });
    return row;
  }

  async list(ctx: DbCtx, status?: string) {
    return (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT a.id, a.workflow_id, w.name AS workflow_name, a.kind, a.summary, a.payload, a.payload_hash, a.status, a.error, a.expires_at, a.decided_at, a.created_at
           FROM approvals a LEFT JOIN workflows w ON w.id = a.workflow_id WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.created_at DESC LIMIT 100`,
          [status ?? null],
        ),
      )
    ).rows;
  }

  private async row(ctx: DbCtx, id: string) {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT * FROM approvals WHERE id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundException('Approval not found');
    return r;
  }

  /** What the review screen shows for a send: the live draft and whether it can still be sent. */
  async view(ctx: DbCtx, id: string) {
    const a = await this.row(ctx, id);
    const extra = a.kind === 'send_reply' ? await this.replies.preview(ctx, a.payload.draftId).catch(() => null) : null;
    return { id: a.id, kind: a.kind, summary: a.summary, payload: a.payload, payloadHash: a.payload_hash, status: a.status, error: a.error, expiresAt: a.expires_at, draft: extra };
  }

  async approve(ctx: DbCtx, id: string, o: { payloadHash: string; acceptNewMessages?: boolean; acceptConflicts?: boolean }) {
    const a = await this.row(ctx, id);
    if (a.status !== 'pending') throw new ConflictException({ code: 'not_pending', message: a.status === 'executed' ? 'This was already approved and carried out.' : `This request is ${a.status}.` });
    if (new Date(a.expires_at) < new Date()) {
      await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'`, [id]));
      throw new ConflictException({ code: 'expired', message: 'This request expired. Run the workflow again if you still want it.' });
    }
    if (a.payload_hash !== o.payloadHash) throw new ConflictException({ code: 'approval_changed', message: 'This request changed after you reviewed it. Review it again.' });

    // Claim it: a double click or a second device cannot carry it out twice.
    const claimed = await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET decided_at = now() WHERE id = $1 AND status = 'pending' AND decided_at IS NULL RETURNING id`, [id]));
    if (!claimed.rowCount) throw new ConflictException({ code: 'in_progress', message: 'This request is already being handled.' });

    try {
      if (a.kind === 'send_reply') {
        await this.replies.send(ctx, a.payload.draftId, { bodyHash: a.payload.bodyHash, acceptNewMessages: !!o.acceptNewMessages });
      } else {
        const p = a.payload;
        await this.calendar.createEvent(
          ctx,
          { title: p.title, start: new Date(p.start), end: new Date(p.end), timezone: p.timezone, location: p.location ?? null, attendees: p.attendees ?? [] },
          { acceptConflicts: !!o.acceptConflicts, actor: 'workflow', workflowId: a.workflow_id ?? undefined, runId: a.run_id ?? undefined },
        );
      }
    } catch (e) {
      if (RECOVERABLE.has(codeOf(e) ?? '')) {
        await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET decided_at = NULL WHERE id = $1`, [id])); // let the person look again and confirm
        throw e;
      }
      const msg = reasonOf(e);
      await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET status = 'failed', error = $2 WHERE id = $1`, [id, msg]));
      await this.activity.log(ctx, { actor: 'user', kind: 'approval.failed', summary: `Approved, but it could not be carried out: ${msg}`.slice(0, 280), workflowId: a.workflow_id, runId: a.run_id, meta: { approvalId: id } });
      await this.finishRun(ctx, a.run_id);
      throw e;
    }
    await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET status = 'executed', error = NULL WHERE id = $1`, [id]));
    await this.audit.log(ctx, 'approval.approve', id, { kind: a.kind });
    await this.activity.log(ctx, { actor: 'user', kind: 'approval.approve', summary: `Approved and carried out: ${a.summary}`.slice(0, 280), workflowId: a.workflow_id, runId: a.run_id, meta: { approvalId: id } });
    await this.finishRun(ctx, a.run_id);
    return this.view(ctx, id);
  }

  async reject(ctx: DbCtx, id: string) {
    const a = await this.row(ctx, id);
    const r = await this.db.tx(ctx, (c) => c.query(`UPDATE approvals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending' AND decided_at IS NULL`, [id]));
    if (!r.rowCount) throw new ConflictException({ code: 'not_pending', message: `This request is ${a.status}.` });
    await this.audit.log(ctx, 'approval.reject', id, { kind: a.kind });
    await this.activity.log(ctx, { actor: 'user', kind: 'approval.reject', summary: `Declined: ${a.summary}`.slice(0, 280), workflowId: a.workflow_id, runId: a.run_id, meta: { approvalId: id } });
    await this.finishRun(ctx, a.run_id);
    return this.view(ctx, id);
  }

  /** A run waiting on approvals is finished once none of its approvals is still pending. */
  private async finishRun(ctx: DbCtx, runId: string | null): Promise<void> {
    if (!runId) return;
    await this.db.tx(ctx, (c) =>
      c.query(
        `UPDATE workflow_runs SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'waiting_approval'
           AND NOT EXISTS (SELECT 1 FROM approvals WHERE run_id = $1 AND status = 'pending')`,
        [runId],
      ),
    );
  }
}
