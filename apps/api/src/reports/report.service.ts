import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ActivityService } from '../common/activity.service';
import { AuditService } from '../common/audit.service';
import { partyLabel } from '../connectors/types';
import { ENV, Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { CONTENT_TYPE, ReportData, ReportFormat, Section, render } from './render';

export type ReportKind = 'inbox' | 'actions' | 'calendar' | 'weekly';
export interface ReportRequest {
  kind: ReportKind;
  format: ReportFormat;
  rangeDays: number;
  title?: string;
  workflowId?: string;
  runId?: string;
}

const fmtDate = (d: Date | string, tz = 'UTC') => new Date(d).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
const count = <T>(items: T[], key: (t: T) => string): [string, number][] => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', needs_reply: 'Needs reply', fyi: 'FYI', low: 'Low' };

/** Pairs of events that overlap in time. Pure, so it can be tested without a database. */
export function overlappingPairs(events: { title: string; start_at: Date | string; end_at: Date | string }[]): [string, string][] {
  const e = events.map((x) => ({ t: x.title, s: +new Date(x.start_at), e: +new Date(x.end_at) })).sort((a, b) => a.s - b.s);
  const out: [string, string][] = [];
  for (let i = 0; i < e.length; i++) for (let j = i + 1; j < e.length && e[j].s < e[i].e; j++) out.push([e[i].t, e[j].t]);
  return out;
}

/**
 * Builds PDF, Word and Excel reports from the user's own synced data and stores them encrypted. Reports contain
 * subjects, senders, dates and counts, never message bodies, and nothing here calls an AI model or leaves the system.
 * Delivering a report anywhere else is a separate, confirmed action; this service only produces the file.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async timezone(ctx: DbCtx): Promise<string> {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT timezone FROM user_profiles WHERE user_id = $1', [ctx.userId]))).rows[0];
    return r?.timezone ?? 'UTC';
  }

  private async inbox(ctx: DbCtx, days: number, tz: string): Promise<Section[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT t.channel, t.subject, t.last_message_at, a.priority,
                  (SELECT m.sender FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m."timestamp" DESC LIMIT 1) AS sender,
                  (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' AND NOT m.is_read) AS unread
           FROM threads t LEFT JOIN thread_analysis a ON a.thread_id = t.id WHERE t.last_message_at >= $1 ORDER BY t.last_message_at DESC LIMIT 200`,
          [since],
        ),
      )
    ).rows;
    const unread = rows.reduce((n, r) => n + r.unread, 0);
    return [
      {
        heading: 'Inbox overview',
        note: `Conversations with activity in the last ${days} day${days === 1 ? '' : 's'}.`,
        bullets: [
          `${rows.length} conversations, ${unread} unread messages`,
          ...count(rows, (r) => r.channel).map(([k, n]) => `${n} on ${k}`),
          ...count(rows.filter((r) => r.priority), (r) => PRIORITY_LABEL[r.priority] ?? r.priority).map(([k, n]) => `${n} marked ${k}`),
        ],
      },
      {
        heading: 'Conversations',
        table: {
          columns: ['Last activity', 'Channel', 'From', 'Subject', 'Priority', 'Unread'],
          rows: rows.map((r) => [fmtDate(r.last_message_at, tz), r.channel, partyLabel(r.sender), r.subject || '(no subject)', PRIORITY_LABEL[r.priority] ?? '', String(r.unread)]),
        },
      },
    ];
  }

  private async actions(ctx: DbCtx, days: number, tz: string): Promise<Section[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT i.text, i.due_at, i.status, i.created_at, t.subject FROM action_items i LEFT JOIN threads t ON t.id = i.thread_id
           WHERE i.status = 'open' OR i.created_at >= $1 ORDER BY (i.status = 'open') DESC, i.due_at NULLS LAST, i.created_at DESC LIMIT 300`,
          [since],
        ),
      )
    ).rows;
    const open = rows.filter((r) => r.status === 'open');
    const overdue = open.filter((r) => r.due_at && new Date(r.due_at) < new Date());
    return [
      { heading: 'Action items', bullets: [`${open.length} open, ${overdue.length} overdue, ${rows.length - open.length} completed recently`] },
      {
        heading: 'Items',
        table: { columns: ['Status', 'Task', 'Due', 'From conversation'], rows: rows.map((r) => [r.status === 'done' ? 'Done' : r.due_at && new Date(r.due_at) < new Date() ? 'Overdue' : 'Open', r.text, r.due_at ? fmtDate(r.due_at, tz) : '', r.subject ?? '']) },
      },
    ];
  }

  private async calendar(ctx: DbCtx, days: number, tz: string): Promise<Section[]> {
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT title, start_at, end_at, location, attendees, status FROM calendar_events WHERE status <> 'cancelled' AND end_at >= $1 AND start_at < $2 ORDER BY start_at LIMIT 300`,
          [from, to],
        ),
      )
    ).rows;
    const clashes = overlappingPairs(rows);
    return [
      {
        heading: 'Calendar',
        note: `Events in the next ${days} day${days === 1 ? '' : 's'}.`,
        bullets: [`${rows.length} events`, clashes.length ? `${clashes.length} overlap${clashes.length === 1 ? '' : 's'} to resolve` : 'No overlapping events', ...clashes.slice(0, 10).map(([a, b]) => `"${a}" overlaps "${b}"`)],
      },
      {
        heading: 'Events',
        table: { columns: ['Start', 'End', 'Title', 'Where', 'People'], rows: rows.map((r) => [fmtDate(r.start_at, tz), fmtDate(r.end_at, tz), r.title, r.location ?? '', String((r.attendees ?? []).length)]) },
      },
    ];
  }

  async build(ctx: DbCtx, kind: ReportKind, days: number): Promise<ReportData> {
    const tz = await this.timezone(ctx);
    const sections =
      kind === 'inbox' ? await this.inbox(ctx, days, tz)
      : kind === 'actions' ? await this.actions(ctx, days, tz)
      : kind === 'calendar' ? await this.calendar(ctx, days, tz)
      : [...(await this.inbox(ctx, days, tz)), ...(await this.actions(ctx, days, tz)), ...(await this.calendar(ctx, days, tz))];
    const titles: Record<ReportKind, string> = { inbox: 'Inbox report', actions: 'Action items report', calendar: 'Calendar report', weekly: 'Weekly summary' };
    return { title: titles[kind], subtitle: `Generated ${fmtDate(new Date(), tz)} (${tz}) · covers ${days} day${days === 1 ? '' : 's'}`, sections };
  }

  async generate(ctx: DbCtx, r: ReportRequest) {
    const data = await this.build(ctx, r.kind, r.rangeDays);
    if (r.title) data.title = r.title;
    let file: Buffer;
    try {
      file = await render(r.format, data);
    } catch {
      throw new BadRequestException('The report could not be built. Try a shorter range.');
    }
    if (file.length > this.env.REPORT_MAX_MB * 1_048_576) throw new BadRequestException(`The report is larger than ${this.env.REPORT_MAX_MB} MB. Choose a shorter range.`);
    const sha = createHash('sha256').update(file).digest('hex');
    const row = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO reports(tenant_id, user_id, workflow_id, title, kind, format, params, size_bytes, sha256, enc_body)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, title, kind, format, size_bytes, sha256, created_at, expires_at`,
          [ctx.tenantId, ctx.userId, r.workflowId ?? null, data.title, r.kind, r.format, JSON.stringify({ rangeDays: r.rangeDays }), file.length, sha, this.crypto.encrypt(file.toString('base64'))],
        ),
      )
    ).rows[0];
    await this.audit.log(ctx, 'report.generate', row.id, { kind: r.kind, format: r.format });
    await this.activity.log(ctx, { actor: r.workflowId ? 'workflow' : 'user', kind: 'report.generate', summary: `Generated ${r.format.toUpperCase()} report "${data.title}"`, workflowId: r.workflowId, runId: r.runId, meta: { reportId: row.id } });
    return row;
  }

  async list(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query('SELECT id, title, kind, format, size_bytes, sha256, created_at, expires_at FROM reports ORDER BY created_at DESC LIMIT 100'))).rows;
  }

  async download(ctx: DbCtx, id: string): Promise<{ file: Buffer; format: ReportFormat; title: string; contentType: string }> {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT title, format, enc_body FROM reports WHERE id = $1', [id]))).rows[0];
    if (!r) throw new NotFoundException('Report not found');
    await this.audit.log(ctx, 'report.download', id);
    return { file: Buffer.from(this.crypto.decrypt(r.enc_body), 'base64'), format: r.format, title: r.title, contentType: CONTENT_TYPE[r.format as ReportFormat] };
  }

  async remove(ctx: DbCtx, id: string): Promise<void> {
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM reports WHERE id = $1 RETURNING title', [id]));
    if (!r.rowCount) throw new NotFoundException('Report not found');
    await this.activity.log(ctx, { actor: 'user', kind: 'report.delete', summary: `Deleted report "${r.rows[0].title}"` });
  }
}
