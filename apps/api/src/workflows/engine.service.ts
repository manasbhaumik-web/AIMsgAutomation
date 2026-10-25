import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DraftService } from '../ai/draft.service';
import { localDate, localHour } from '../ai/helpers';
import { ActivityService } from '../common/activity.service';
import { AuditService } from '../common/audit.service';
import { ENV, Env } from '../config/env';
import { Party, partyLabel } from '../connectors/types';
import { Db, DbCtx } from '../db/db.service';
import { Profile, ProfileService } from '../profile/profile.service';
import { RepliesService } from '../replies/replies.service';
import { ReportService } from '../reports/report.service';
import { ApprovalsService, reasonOf } from './approvals.service';
import { Action, Condition, Policy, Trigger } from './workflow.schema';

export interface Facts {
  channel: string;
  sender: Party | null;
  subject: string;
  body: string;
  priority: string | null;
  topics: string[];
}
export interface Step {
  action: string;
  status: 'ok' | 'skipped' | 'waiting' | 'failed';
  message: string;
  ref?: Record<string, unknown>;
}
interface WorkflowRow {
  id: string;
  name: string;
  autonomy: 'suggest' | 'ask' | 'auto';
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  policy: Policy;
  scan_from: Date;
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** True when every condition holds. Pure, so the rules can be tested without a database. */
export function matchConditions(conds: Condition[], f: Facts): boolean {
  return conds.every((c) => {
    const v = c.value.trim();
    switch (c.field) {
      case 'channel': return c.op === 'is' ? f.channel === v : has(f.channel, v);
      case 'priority': return f.priority !== null && (c.op === 'is' ? f.priority === v : has(f.priority, v));
      case 'subject': return c.op === 'is' ? f.subject.trim().toLowerCase() === v.toLowerCase() : has(f.subject, v);
      case 'body': return c.op === 'is' ? f.body.trim().toLowerCase() === v.toLowerCase() : has(f.body, v);
      case 'topic': return f.topics.some((t) => (c.op === 'is' ? t.toLowerCase() === v.toLowerCase() : has(t, v)));
      case 'sender': {
        const parts = [f.sender?.name, f.sender?.email, f.sender?.handle].filter(Boolean) as string[];
        return c.op === 'is' ? parts.some((p) => p.toLowerCase() === v.toLowerCase()) : parts.some((p) => has(p, v));
      }
    }
  });
}

export interface GateInput {
  /** The operator switch (AUTO_SEND_ENABLED). */
  serverAllowsAuto: boolean;
  policy: Policy;
  profile: Profile;
  channel: string;
  priority: string | null;
  senderEmail?: string;
  draft: string;
  inWorkingHours: boolean;
  sentByWorkflow24h: number;
  sentOnChannel24h: number;
}

/**
 * Whether a reply may go out without a click. Returns the reason to hold it back, or null when every limit is met.
 * Both the person's profile and the workflow's own policy must allow it; either one saying no sends it to approval instead.
 */
export function autoSendHold(g: GateInput): string | null {
  if (!g.serverAllowsAuto) return 'Automatic sending is switched off on this server.';
  if (!g.profile.autoRepliesEnabled) return 'Automatic replies are switched off in your preferences.';
  if (!g.policy.allowedChannels.includes(g.channel as never)) return `This workflow may not send on ${g.channel} by itself.`;
  const channelPolicy = g.profile.responsePolicies[g.channel as keyof Profile['responsePolicies']];
  if (!channelPolicy?.allowAuto) return `Your preferences do not allow automatic replies on ${g.channel}.`;
  if (g.priority && g.policy.blockPriorities.includes(g.priority as never)) return `${g.priority === 'urgent' ? 'Urgent' : 'This kind of'} conversation always waits for you.`;
  if (g.policy.onlyInWorkingHours && !g.inWorkingHours) return 'It is outside your working hours.';
  if (g.policy.allowedSenderDomains.length) {
    const domain = g.senderEmail?.split('@')[1]?.toLowerCase();
    if (!domain || !g.policy.allowedSenderDomains.some((d) => d.toLowerCase() === domain)) return 'The sender is not on the allowed domain list.';
  }
  if (/\[[^\]\n]{1,60}\]/.test(g.draft)) return 'The draft still has a [placeholder] to fill in.';
  if (g.draft.length > 1500) return 'The draft is long for an automatic reply.';
  if (g.sentByWorkflow24h >= g.policy.dailyCap) return 'This workflow reached its limit for the last 24 hours.';
  if (g.sentOnChannel24h >= channelPolicy.maxPerDay) return `Your limit for automatic replies on ${g.channel} was reached.`;
  return null;
}

/** Next half hour at least `hours` from now. */
const startAt = (hours: number, now = new Date()): Date => new Date(Math.ceil((now.getTime() + hours * 3_600_000) / 1_800_000) * 1_800_000);
const fill = (tpl: string, f: Facts | null): string => tpl.replace(/\{\{subject\}\}/g, f?.subject || '(no subject)').replace(/\{\{sender\}\}/g, f ? partyLabel(f.sender) : '').slice(0, 200);

/**
 * Runs workflows. It is the one piece of automation in the system, so it has three hard limits:
 *  - it acts only as the workflow's owner, on their own data (workers impersonate the owner through sys_*_ctx);
 *  - a send or calendar change goes through the same confirmed paths as a manual one: approvals for "ask", and for
 *    "auto" only when the profile, the policy and the per-channel limits all agree (otherwise it falls back to an approval);
 *  - every step is logged to the run and to the user's activity log.
 * It depends on RepliesService, which AI code never may; DraftService does not depend on this class.
 */
@Injectable()
export class WorkflowEngine {
  private readonly log = new Logger(WorkflowEngine.name);

  constructor(
    private readonly db: Db,
    private readonly drafts: DraftService,
    private readonly replies: RepliesService,
    private readonly approvals: ApprovalsService,
    private readonly reports: ReportService,
    private readonly profiles: ProfileService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- triggers
  /** After new mail has been analysed: run this account's message workflows on mail that arrived since they were enabled. */
  async scanAccount(accountId: string): Promise<void> {
    const c = (await this.db.system((q) => q.query('SELECT * FROM sys_account_ctx($1)', [accountId]))).rows[0];
    if (!c) return;
    const ctx: DbCtx = { userId: c.user_id, tenantId: c.tenant_id, role: c.role, tenantRole: c.tenant_role };
    const wfs = (await this.db.tx(ctx, (q) => q.query(`SELECT id, name, autonomy, trigger, conditions, actions, policy, scan_from FROM workflows WHERE enabled AND trigger ->> 'type' = 'message_received'`))).rows as WorkflowRow[];
    for (const wf of wfs) await this.scanWorkflow(ctx, wf, accountId).catch((e) => this.log.warn(`Workflow ${wf.id} scan failed: ${(e as Error).message}`));
  }

  private async scanWorkflow(ctx: DbCtx, wf: WorkflowRow, accountId: string): Promise<void> {
    const repliesToo = wf.actions.some((a) => a.type === 'draft_reply' || a.type === 'send_reply');
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT t.id AS thread_id, t.channel, t.subject, m.id AS message_id, m.sender, m.body_text, m."timestamp", a.priority
           FROM threads t
           JOIN LATERAL (SELECT * FROM messages x WHERE x.thread_id = t.id AND x.direction = 'inbound' ORDER BY x."timestamp" DESC LIMIT 1) m ON true
           LEFT JOIN thread_analysis a ON a.thread_id = t.id
           WHERE t.account_id = $1 AND m."timestamp" > $2
             AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_id = $3 AND r.dedupe_key = 'msg-' || m.id::text)
             AND (NOT $4::boolean OR NOT EXISTS (SELECT 1 FROM messages o WHERE o.thread_id = t.id AND o.direction = 'outbound' AND o."timestamp" > m."timestamp"))
           ORDER BY m."timestamp" LIMIT 50`,
          [accountId, wf.scan_from, wf.id, repliesToo],
        ),
      )
    ).rows;
    const needsAnalysis = wf.conditions.some((c) => c.field === 'priority' || c.field === 'topic');
    let advanceTo: Date | null = null;
    let blocked = false;
    for (const r of rows) {
      if (needsAnalysis && r.priority === null) { blocked = true; continue; } // analysis has not run yet: look again next time
      const topics = wf.conditions.some((c) => c.field === 'topic') ? await this.topics(ctx, r.thread_id) : [];
      const facts: Facts = { channel: r.channel, sender: r.sender, subject: r.subject ?? '', body: r.body_text ?? '', priority: r.priority, topics };
      if (matchConditions(wf.conditions, facts)) await this.execute(ctx, wf, { threadId: r.thread_id, facts, dedupeKey: `msg-${r.message_id}`, manual: false });
      if (!blocked) advanceTo = r.timestamp;
    }
    if (advanceTo) await this.db.tx(ctx, (c) => c.query('UPDATE workflows SET scan_from = $2 WHERE id = $1 AND $2 > scan_from', [wf.id, advanceTo]));
  }

  private async topics(ctx: DbCtx, threadId: string): Promise<string[]> {
    return (await this.db.tx(ctx, (c) => c.query('SELECT t.name FROM thread_topics tt JOIN topics t ON t.id = tt.topic_id WHERE tt.thread_id = $1', [threadId]))).rows.map((r) => String(r.name));
  }

  /** Once a minute: closes stale approvals, deletes expired reports and starts scheduled workflows that are due. */
  async tick(now = new Date()): Promise<void> {
    await this.db.system((c) => c.query('SELECT sys_expire_approvals()')).catch(() => undefined);
    await this.db.system((c) => c.query('SELECT sys_purge_reports()')).catch(() => undefined);
    const users = (await this.db.system((c) => c.query('SELECT sys_users_with_schedules() AS id'))).rows.map((r) => r.id as string);
    for (const id of users) {
      const c = (await this.db.system((q) => q.query('SELECT * FROM sys_user_ctx($1)', [id]))).rows[0];
      if (!c) continue;
      const ctx: DbCtx = { userId: c.user_id, tenantId: c.tenant_id, role: c.role, tenantRole: c.tenant_role };
      const wfs = (await this.db.tx(ctx, (q) => q.query(`SELECT id, name, autonomy, trigger, conditions, actions, policy, scan_from FROM workflows WHERE enabled AND trigger ->> 'type' = 'schedule'`))).rows as WorkflowRow[];
      for (const wf of wfs) {
        const key = this.scheduleKey(wf.trigger, now);
        if (key) await this.execute(ctx, wf, { threadId: null, facts: null, dedupeKey: key, manual: false }).catch((e) => this.log.warn(`Scheduled workflow ${wf.id} failed: ${(e as Error).message}`));
      }
    }
  }

  /** The dedupe key for this slot when the schedule is due, else null. A missed minute still runs later the same day. */
  scheduleKey(t: Trigger, now: Date): string | null {
    if (t.type !== 'schedule') return null;
    if (localHour(t.timezone, now) < t.hour) return null;
    if (t.every === 'week') {
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: t.timezone, weekday: 'short' }).format(now));
      if (wd !== t.weekday) return null;
    }
    return `sched-${localDate(t.timezone, now)}`;
  }

  /** "Run now" from the UI. Skips the conditions (the person chose this run) and works on a workflow that is switched off. */
  async runManual(ctx: DbCtx, workflowId: string, threadId?: string) {
    const wf = (await this.db.tx(ctx, (c) => c.query('SELECT id, name, autonomy, trigger, conditions, actions, policy, scan_from FROM workflows WHERE id = $1', [workflowId]))).rows[0] as WorkflowRow | undefined;
    if (!wf) throw new NotFoundException('Workflow not found');
    const needsThread = wf.actions.some((a) => a.type === 'draft_reply' || a.type === 'send_reply');
    if (needsThread && !threadId) throw new BadRequestException('Choose the conversation to run this workflow on.');
    let facts: Facts | null = null;
    if (threadId) {
      const r = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT t.channel, t.subject, a.priority,
                    (SELECT m.sender FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m."timestamp" DESC LIMIT 1) AS sender,
                    (SELECT m.body_text FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m."timestamp" DESC LIMIT 1) AS body
             FROM threads t LEFT JOIN thread_analysis a ON a.thread_id = t.id WHERE t.id = $1`,
            [threadId],
          ),
        )
      ).rows[0];
      if (!r) throw new NotFoundException('Conversation not found');
      facts = { channel: r.channel, sender: r.sender, subject: r.subject ?? '', body: r.body ?? '', priority: r.priority, topics: await this.topics(ctx, threadId) };
    }
    const run = await this.execute(ctx, wf, { threadId: threadId ?? null, facts, dedupeKey: `manual-${randomUUID()}`, manual: true });
    return run;
  }

  // ---------------------------------------------------------------- one run
  private async execute(ctx: DbCtx, wf: WorkflowRow, t: { threadId: string | null; facts: Facts | null; dedupeKey: string; manual: boolean }) {
    const inserted = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO workflow_runs(tenant_id, user_id, workflow_id, trigger_type, dedupe_key, thread_id, manual) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (workflow_id, dedupe_key) DO NOTHING RETURNING id`,
          [ctx.tenantId, ctx.userId, wf.id, wf.trigger.type, t.dedupeKey, t.threadId, t.manual],
        ),
      )
    ).rows[0];
    if (!inserted) return null; // this message or slot already ran
    const runId = inserted.id as string;
    const steps: Step[] = [];
    let waiting = false;
    let failed = false;
    const state: { draft?: { id: string; body: string; body_hash: string } } = {};

    for (const a of wf.actions) {
      let s: Step;
      try {
        s = await this.step(ctx, wf, runId, a, t, state);
      } catch (e) {
        s = { action: a.type, status: 'failed', message: reasonOf(e) };
      }
      steps.push(s);
      if (s.status === 'waiting') waiting = true;
      if (s.status === 'failed') { failed = true; break; }
    }
    const status = failed ? 'failed' : waiting ? 'waiting_approval' : 'done';
    await this.db.tx(ctx, (c) =>
      c.query(
        `UPDATE workflow_runs SET steps = $2, status = $3, error = $4, finished_at = CASE WHEN $3 = 'waiting_approval' THEN NULL ELSE now() END WHERE id = $1`,
        [runId, JSON.stringify(steps), status, failed ? steps[steps.length - 1].message.slice(0, 300) : null],
      ),
    );
    await this.db.tx(ctx, (c) => c.query('UPDATE workflows SET last_run_at = now() WHERE id = $1', [wf.id]));
    await this.activity.log(ctx, {
      actor: 'workflow', kind: 'workflow.run', summary: `Workflow "${wf.name}" ${failed ? 'stopped with a problem' : waiting ? 'is waiting for your approval' : 'finished'}`, workflowId: wf.id, runId, meta: { status, manual: t.manual },
    });
    return (await this.db.tx(ctx, (c) => c.query('SELECT id, workflow_id, trigger_type, thread_id, status, steps, error, manual, started_at, finished_at FROM workflow_runs WHERE id = $1', [runId]))).rows[0];
  }

  private async step(ctx: DbCtx, wf: WorkflowRow, runId: string, a: Action, t: { threadId: string | null; facts: Facts | null }, state: { draft?: { id: string; body: string; body_hash: string } }): Promise<Step> {
    switch (a.type) {
      case 'draft_reply': {
        if (!t.threadId) return { action: a.type, status: 'failed', message: 'There is no conversation to reply to.' };
        const open = (await this.db.tx(ctx, (c) => c.query(`SELECT id, source, status FROM reply_drafts WHERE thread_id = $1 AND status IN ('draft','sending','failed')`, [t.threadId]))).rows[0];
        if (open?.source === 'user') return { action: a.type, status: 'skipped', message: 'You already have a draft in this conversation, so it was left alone.' };
        const d = (await this.drafts.draftReply(ctx, t.threadId, a.instructions)) as { id: string; body: string; body_hash: string };
        state.draft = d;
        return { action: a.type, status: 'ok', message: `Wrote a draft (${d.body.length} characters).`, ref: { draftId: d.id } };
      }
      case 'send_reply': return this.sendStep(ctx, wf, runId, t, state);
      case 'create_event': {
        const start = startAt(a.startInHours);
        const end = new Date(start.getTime() + a.durationMin * 60_000);
        const profile = await this.profiles.get(ctx);
        const payload = { title: fill(a.title, t.facts), start: start.toISOString(), end: end.toISOString(), timezone: profile.timezone, location: a.location ?? null, attendees: a.attendees };
        const ap = await this.approvals.create(ctx, { workflowId: wf.id, runId, kind: 'create_event', summary: `Create the event "${payload.title}" on ${start.toLocaleString('en-GB', { timeZone: profile.timezone, dateStyle: 'medium', timeStyle: 'short' })}`, payload });
        return { action: a.type, status: 'waiting', message: 'Needs your approval before it is added to your calendar.', ref: { approvalId: ap.id } };
      }
      case 'generate_report': {
        const r = await this.reports.generate(ctx, { kind: a.kind, format: a.format, rangeDays: a.rangeDays, workflowId: wf.id, runId });
        return { action: a.type, status: 'ok', message: `Built the ${a.format.toUpperCase()} report "${r.title}".`, ref: { reportId: r.id } };
      }
    }
  }

  private async sendStep(ctx: DbCtx, wf: WorkflowRow, runId: string, t: { threadId: string | null; facts: Facts | null }, state: { draft?: { id: string; body: string; body_hash: string } }): Promise<Step> {
    if (!t.threadId || !t.facts) return { action: 'send_reply', status: 'failed', message: 'There is no conversation to reply to.' };
    // "auto" only ever sends a draft written by this same run. A draft the person started themselves is never sent on their behalf:
    // under "ask" it may be put in front of them for approval, under "auto" the run stops.
    let draft = state.draft;
    if (!draft && wf.autonomy !== 'auto') {
      draft = (await this.db.tx(ctx, (c) => c.query(`SELECT id, body, body_hash FROM reply_drafts WHERE thread_id = $1 AND status = 'draft'`, [t.threadId]))).rows[0] as typeof state.draft;
    }
    if (!draft) return { action: 'send_reply', status: 'failed', message: wf.autonomy === 'auto' ? 'There is no draft written by this workflow, so nothing was sent.' : 'There is no draft to send.' };
    if (wf.autonomy === 'suggest') return { action: 'send_reply', status: 'skipped', message: 'Suggest only: the draft is saved for you to review and send yourself.', ref: { draftId: draft.id } };

    const view = await this.replies.preview(ctx, draft.id);
    if (!view.canSend) return { action: 'send_reply', status: 'failed', message: view.blockedReason ?? 'This reply cannot be sent.' };

    let hold: string | null = 'This workflow asks before sending.';
    if (wf.autonomy === 'auto') {
      const profile = await this.profiles.get(ctx);
      const counts = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT count(*) FILTER (WHERE workflow_id = $1)::int AS by_workflow, count(*) FILTER (WHERE meta ->> 'channel' = $2)::int AS by_channel
             FROM activity_log WHERE kind = 'workflow.auto_send' AND at > now() - interval '24 hours'`,
            [wf.id, t.facts!.channel],
          ),
        )
      ).rows[0];
      hold = autoSendHold({
        serverAllowsAuto: this.env.AUTO_SEND_ENABLED === 'true', policy: wf.policy, profile, channel: t.facts.channel, priority: t.facts.priority, senderEmail: t.facts.sender?.email, draft: draft.body,
        inWorkingHours: this.profiles.inWorkingHours(profile, new Date()), sentByWorkflow24h: counts.by_workflow, sentOnChannel24h: counts.by_channel,
      });
    }

    if (hold === null) {
      // Every limit is met: send exactly this draft, through the same confirmed path a person uses.
      await this.replies.send(ctx, draft.id, { bodyHash: draft.body_hash, acceptNewMessages: false });
      await this.audit.log(ctx, 'workflow.auto_send', draft.id, { channel: t.facts.channel, workflowId: wf.id });
      await this.activity.log(ctx, { actor: 'workflow', kind: 'workflow.auto_send', summary: `Sent a reply automatically on ${t.facts.channel} (workflow "${wf.name}")`, workflowId: wf.id, runId, meta: { channel: t.facts.channel, draftId: draft.id } });
      return { action: 'send_reply', status: 'ok', message: 'Sent automatically: every limit in your policy was met.', ref: { draftId: draft.id } };
    }

    const to = view.to.map(partyLabel).join(', ');
    const ap = await this.approvals.create(ctx, {
      workflowId: wf.id, runId, kind: 'send_reply', summary: `Send a reply on ${view.channel} to ${to || 'the sender'}: "${view.subject ?? '(no subject)'}"`.slice(0, 280),
      payload: { draftId: draft.id, bodyHash: draft.body_hash, threadId: t.threadId, channel: view.channel, to, subject: view.subject },
    });
    return { action: 'send_reply', status: 'waiting', message: wf.autonomy === 'auto' ? `Needs your approval: ${hold}` : 'Needs your approval before it is sent.', ref: { approvalId: ap.id, draftId: draft.id } };
  }
}
