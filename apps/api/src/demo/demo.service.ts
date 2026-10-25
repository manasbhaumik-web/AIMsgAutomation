import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DEMO_WRITE_SCOPE } from '../connectors/demo.connector';
import { NormalizedEvent, NormalizedMessage, Party } from '../connectors/types';
import { ENV, Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { WorkflowEngine } from '../workflows/engine.service';

const MAIL = 'demo@example.com';
const CAL = 'demo-calendar@example.com';
const HOUR = 3_600_000;

interface SeedThread { from: Party; subject: string; body: string; ago: number; priority: 'urgent' | 'needs_reply' | 'fyi' | 'low'; topic: string; unread: boolean; action?: { text: string; inDays: number } }

const THREADS: SeedThread[] = [
  { from: { name: 'Dana Whitfield', email: 'dana@northwind.example' }, subject: 'Invoice 2417 is due Friday', body: 'Hi,\n\nA reminder that invoice 2417 for October services is due on Friday. Could you confirm the purchase order number so we can match the payment?\n\nThanks,\nDana', ago: 2 * HOUR, priority: 'needs_reply', topic: 'Invoices', unread: true, action: { text: 'Confirm the purchase order number with Dana', inDays: 5 } },
  { from: { name: 'Marcus Lee', email: 'marcus@contoso.example' }, subject: "Can we move Thursday's call?", body: "Something came up on my side. Would it work to move our Thursday call back by an hour? Let me know today if you can.\n\nMarcus", ago: 0.5 * HOUR, priority: 'urgent', topic: 'Meetings', unread: true },
  { from: { name: 'Priya Nair', email: 'priya@fabrikam.example' }, subject: 'Design review notes', body: 'Thanks for the walkthrough. I added my comments to the shared file. Nothing blocking, just a few small suggestions on spacing.\n\nPriya', ago: 26 * HOUR, priority: 'fyi', topic: 'Design', unread: false },
  { from: { name: 'Ops alerts', email: 'alerts@ops.example' }, subject: 'Deployment finished', body: 'Release 4.12 was deployed to production without errors.', ago: 30 * HOUR, priority: 'low', topic: 'Operations', unread: false },
  { from: { name: 'Northwind Travel', email: 'bookings@travel.example' }, subject: 'Your itinerary for next month', body: 'Your booking is confirmed. The full itinerary is attached to this email.', ago: 50 * HOUR, priority: 'low', topic: 'Travel', unread: false },
];

/** Next occurrence (today or later) of a weekday, at the given UTC hour. 0 = Sunday. */
const nextOn = (dow: number, hour: number, now = new Date()): Date => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7 || 7));
  return d;
};

/**
 * Development-only sample data, available when DEMO_MODE=true. It creates a fake mailbox and calendar for the signed-in
 * user (connected with write access so every workflow, approval and calendar path can be tried) and can simulate a new
 * incoming message. It never touches a real provider, and the whole feature answers 404 when demo mode is off.
 */
@Injectable()
export class DemoService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly ingestion: IngestionService,
    private readonly engine: WorkflowEngine,
  ) {}

  private on(): void {
    if (this.env.DEMO_MODE !== 'true') throw new NotFoundException();
  }

  status() {
    return { enabled: this.env.DEMO_MODE === 'true' };
  }

  private async account(ctx: DbCtx, channel: 'gmail' | 'google_calendar', externalId: string): Promise<string> {
    const tokens = this.crypto.encrypt(JSON.stringify({ accessToken: 'demo', refreshToken: null, expiresAt: Date.now() + 365 * 86_400_000 }));
    return (
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO connected_accounts(tenant_id, user_id, channel, external_id, display_name, status, enc_tokens, scopes, sync_cursor)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,'demo') RETURNING id`,
          [ctx.tenantId, ctx.userId, channel, externalId, `${channel === 'gmail' ? 'Demo mailbox' : 'Demo calendar'}`, tokens, ['demo.read', DEMO_WRITE_SCOPE]],
        ),
      )
    ).rows[0].id as string;
  }

  private message(t: SeedThread, threadId: string, at: Date): NormalizedMessage {
    const id = `demo-${randomUUID()}`;
    return {
      externalId: id, threadExternalId: threadId, subject: t.subject, sender: t.from, recipients: { to: [{ name: 'You', email: MAIL }], cc: [] }, bodyText: t.body, bodyHtml: null,
      attachments: [], timestamp: at, direction: 'inbound', isRead: !t.unread, rawRef: id,
    };
  }

  /** Replaces any earlier demo data with a fresh set. */
  async seed(ctx: DbCtx) {
    this.on();
    await this.clear(ctx);
    const mail = await this.account(ctx, 'gmail', MAIL);
    const cal = await this.account(ctx, 'google_calendar', CAL);
    const now = new Date();
    for (const t of THREADS) {
      const at = new Date(now.getTime() - t.ago);
      const threadExt = `demo-thread-${randomUUID()}`;
      await this.ingestion.apply(ctx, { id: mail, tenant_id: ctx.tenantId!, user_id: ctx.userId!, channel: 'gmail' }, { messages: [this.message(t, threadExt, at)], events: [], deletedExternalIds: [], cursor: 'demo' });
      await this.db.tx(ctx, async (c) => {
        const th = (await c.query('SELECT id FROM threads WHERE account_id = $1 AND external_id = $2', [mail, threadExt])).rows[0].id;
        await c.query(`INSERT INTO thread_analysis(thread_id, tenant_id, user_id, priority, status, analyzed_through) VALUES ($1,$2,$3,$4,'done',$5)`, [th, ctx.tenantId, ctx.userId, t.priority, at]);
        const topic = (await c.query(`INSERT INTO topics(tenant_id, user_id, name) VALUES ($1,$2,$3) ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [ctx.tenantId, ctx.userId, t.topic])).rows[0].id;
        await c.query('INSERT INTO thread_topics(thread_id, topic_id, user_id) VALUES ($1,$2,$3)', [th, topic, ctx.userId]);
        if (t.action) await c.query(`INSERT INTO action_items(tenant_id, user_id, thread_id, text, due_at) VALUES ($1,$2,$3,$4,$5)`, [ctx.tenantId, ctx.userId, th, t.action.text, new Date(now.getTime() + t.action.inDays * 24 * HOUR)]);
      });
    }
    const ev = (title: string, start: Date, mins: number, attendees: string[] = []): NormalizedEvent => ({
      externalId: `demo-event-${randomUUID()}`, title, start, end: new Date(start.getTime() + mins * 60_000), allDay: false, timezone: 'UTC',
      organizer: { email: CAL, name: 'You' }, attendees: attendees.map((email) => ({ email, response: 'accepted' })), location: null, meetingLink: null, status: 'confirmed',
    });
    const thu = nextOn(4, 15);
    await this.ingestion.apply(ctx, { id: cal, tenant_id: ctx.tenantId!, user_id: ctx.userId!, channel: 'google_calendar' }, {
      messages: [], deletedExternalIds: [], cursor: 'demo',
      events: [
        ev('Weekly planning', nextOn(1, 10), 30),
        ev('Design review', nextOn(3, 13), 60, ['priya@fabrikam.example']),
        ev('Call with Marcus', thu, 45, ['marcus@contoso.example']),
        ev('Dentist', new Date(thu.getTime() + 30 * 60_000), 60), // overlaps the call, to show conflict handling
      ],
    });
    return { ok: true, threads: THREADS.length, events: 4 };
  }

  /**
   * Simulates a new message arriving, then runs the account's workflows on it right away (instead of waiting for the
   * background tick), so a workflow can be tried and watched from the UI.
   */
  async inbound(ctx: DbCtx, b: { threadId?: string; fromName: string; fromEmail: string; subject: string; body: string; priority: 'urgent' | 'needs_reply' | 'fyi' | 'low' | null }) {
    this.on();
    const acct = (await this.db.tx(ctx, (c) => c.query(`SELECT id FROM connected_accounts WHERE channel = 'gmail' AND external_id = $1`, [MAIL]))).rows[0];
    if (!acct) throw new NotFoundException('Load the demo data first.');
    const at = new Date();
    let threadExt = `demo-thread-${randomUUID()}`;
    if (b.threadId) {
      const t = (await this.db.tx(ctx, (c) => c.query('SELECT external_id FROM threads WHERE id = $1 AND account_id = $2', [b.threadId, acct.id]))).rows[0];
      if (!t) throw new NotFoundException('That conversation is not part of the demo mailbox.');
      threadExt = t.external_id;
    }
    const seed: SeedThread = { from: { name: b.fromName, email: b.fromEmail }, subject: b.subject, body: b.body, ago: 0, priority: b.priority ?? 'fyi', topic: '', unread: true };
    await this.ingestion.apply(ctx, { id: acct.id, tenant_id: ctx.tenantId!, user_id: ctx.userId!, channel: 'gmail' }, { messages: [this.message(seed, threadExt, at)], events: [], deletedExternalIds: [], cursor: 'demo' });
    const th = (await this.db.tx(ctx, (c) => c.query('SELECT id FROM threads WHERE account_id = $1 AND external_id = $2', [acct.id, threadExt]))).rows[0].id as string;
    if (b.priority) {
      await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO thread_analysis(thread_id, tenant_id, user_id, priority, status, analyzed_through) VALUES ($1,$2,$3,$4,'done',$5)
           ON CONFLICT (thread_id) DO UPDATE SET priority = EXCLUDED.priority, status = 'done', analyzed_through = EXCLUDED.analyzed_through`,
          [th, ctx.tenantId, ctx.userId, b.priority, at],
        ),
      );
    }
    await this.engine.scanAccount(acct.id);
    return { threadId: th };
  }

  async clear(ctx: DbCtx) {
    this.on();
    await this.db.tx(ctx, (c) => c.query(`DELETE FROM connected_accounts WHERE external_id IN ($1,$2)`, [MAIL, CAL]));
    return { ok: true };
  }
}
