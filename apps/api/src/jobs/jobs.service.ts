import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { AiPipelineService } from '../ai/pipeline.service';
import { DigestService } from '../ai/digest.service';
import { localDate, localHour } from '../ai/helpers';
import { ENV, Env } from '../config/env';
import { Db, DbCtx } from '../db/db.service';
import { SubscriptionService } from '../ingestion/subscription.service';
import { MetricsService } from '../observability/metrics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrivacyService } from '../privacy/privacy.service';
import { SyncService } from '../ingestion/sync.service';

const POLL_EVERY_MS = 60_000;
const STALE_AFTER_MS = 120_000;
const RENEW_WINDOW_MS = 12 * 3_600_000;

export type JobName = 'sync' | 'renew' | 'ai' | 'digest';
const SWEEP_EVERY_MS = 3_600_000;
interface JobData {
  accountId?: string;
  userId?: string;
}

/**
 * Background work: per-account sync, push-subscription renewal, AI enrichment (embeddings, topics, priority) and
 * daily digests, plus a minute tick that polls idle accounts (the backstop for missed webhooks) and queues pending
 * AI work. Uses BullMQ when REDIS_URL is set, otherwise an in-process queue that runs one job at a time.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private timer?: NodeJS.Timeout;
  private readonly pending = new Set<string>();
  private readonly digestQueuedFor = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private lastSweep = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: Db,
    private readonly sync: SyncService,
    private readonly subs: SubscriptionService,
    private readonly ai: AiPipelineService,
    private readonly digests: DigestService,
    private readonly notifications: NotificationsService,
    private readonly privacy: PrivacyService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.WORKERS_ENABLED !== 'true' || this.env.NODE_ENV === 'test') return;
    if (this.env.REDIS_URL) {
      const u = new URL(this.env.REDIS_URL);
      const connection = { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined, maxRetriesPerRequest: null as null };
      this.queue = new Queue('inbox', { connection });
      await this.queue.upsertJobScheduler('tick', { every: POLL_EVERY_MS }, { name: 'tick' });
      this.worker = new Worker('inbox', async (job) => (job.name === 'tick' ? this.tick() : this.handle(job.name as JobName, job.data as JobData)), { connection, concurrency: 4 });
      this.worker.on('failed', (job, err) => this.log.warn(`Job ${job?.name} failed (attempt ${job?.attemptsMade}): ${err.message}`));
      this.log.log('Workers started (BullMQ)');
    } else {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`Tick failed: ${e.message}`)), POLL_EVERY_MS);
      this.log.warn('REDIS_URL not set: running jobs in-process (development only)');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }

  enqueueSync(accountId: string): Promise<void> {
    return this.enqueue('sync', accountId, { accountId });
  }
  enqueueRenew(accountId: string): Promise<void> {
    return this.enqueue('renew', accountId, { accountId });
  }
  enqueueAi(accountId: string): Promise<void> {
    return this.enqueue('ai', accountId, { accountId });
  }
  enqueueDigest(userId: string, date: string): Promise<void> {
    return this.enqueue('digest', `${userId}-${date}`, { userId });
  }

  /** `key` becomes the BullMQ job id (BullMQ forbids ":" in custom ids), so a burst of triggers collapses into one job. */
  private async enqueue(name: JobName, key: string, data: JobData): Promise<void> {
    if (this.queue) {
      await this.queue.add(name, data, { jobId: `${name}-${key}`, attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: { count: 1000 } });
      return;
    }
    if (this.env.WORKERS_ENABLED !== 'true' || this.env.NODE_ENV === 'test') return;
    const id = `${name}-${key}`;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.chain = this.chain
      .then(() => this.handle(name, data))
      .catch((e) => this.log.warn(`${name} failed (${key}): ${(e as Error).message}`))
      .finally(() => this.pending.delete(id));
  }

  async handle(name: JobName, data: JobData): Promise<void> {
    const end = this.metrics.jobSeconds.startTimer({ job: name });
    try {
      await this.run(name, data);
      this.metrics.jobs.inc({ job: name, result: 'ok' });
    } catch (e) {
      this.metrics.jobs.inc({ job: name, result: 'error' });
      throw e;
    } finally {
      end();
    }
  }

  private async run(name: JobName, data: JobData): Promise<void> {
    if (name === 'sync') {
      // New mail is enriched right after it lands; the tick also picks up anything missed.
      if (await this.sync.syncAccount(data.accountId!)) await this.enqueueAi(data.accountId!);
    } else if (name === 'renew') await this.subs.ensure(data.accountId!);
    else if (name === 'ai') {
      await this.ai.runForAccount(data.accountId!);
      // Notifications read the freshly assigned priorities; a failure here must not make the AI job retry.
      await this.notifications.scan(data.accountId!).catch((e) => this.log.warn(`Notification scan failed: ${(e as Error).message}`));
    }
    else if (name === 'digest') {
      const r = await this.db.system((c) => c.query('SELECT * FROM sys_user_ctx($1)', [data.userId]));
      const row = r.rows[0];
      if (!row) return;
      const ctx: DbCtx = { userId: row.user_id, tenantId: row.tenant_id, role: row.role, tenantRole: row.tenant_role };
      if (await this.digests.isDue(ctx, await this.digests.schedule(ctx))) await this.digests.generate(ctx);
    }
  }

  async tick(): Promise<void> {
    await this.sweepIfDue();
    if (this.queue) {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => ({}) as Record<string, number>);
      for (const [state, n] of Object.entries(counts)) this.metrics.queueDepth.set({ state }, n);
    }
    const stale = await this.db.system((c) => c.query('SELECT sys_accounts_to_poll($1) AS id', [new Date(Date.now() - STALE_AFTER_MS)]));
    for (const r of stale.rows) await this.enqueueSync(r.id);
    const renew = await this.db.system((c) => c.query('SELECT sys_accounts_to_renew($1) AS id', [new Date(Date.now() + RENEW_WINDOW_MS)]));
    for (const r of renew.rows) await this.enqueueRenew(r.id);
    const ai = await this.db.system((c) => c.query('SELECT sys_accounts_pending_ai() AS id'));
    for (const r of ai.rows) await this.enqueueAi(r.id);

    const now = new Date();
    const cands = await this.db.system((c) => c.query('SELECT * FROM sys_digest_candidates()'));
    for (const r of cands.rows) {
      const tz = r.schedule?.timezone ?? 'UTC';
      const key = `${r.user_id}-${localDate(tz, now)}`;
      if (localHour(tz, now) < (r.schedule?.hour ?? 8) || this.digestQueuedFor.has(key)) continue;
      this.digestQueuedFor.add(key);
      await this.enqueueDigest(r.user_id, localDate(tz, now));
    }
    if (this.digestQueuedFor.size > 5000) this.digestQueuedFor.clear();
  }

  /** Hourly retention sweep. With several instances every one may run it; the deletes are idempotent. */
  private async sweepIfDue(): Promise<void> {
    if (Date.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = Date.now();
    try {
      const e = this.env;
      const counts = await this.privacy.purge({
        sessionsDays: e.RETAIN_SESSIONS_DAYS, notificationsDays: e.RETAIN_NOTIFICATIONS_DAYS, webhookDays: e.RETAIN_WEBHOOK_INBOX_DAYS,
        draftsDays: e.RETAIN_DRAFTS_DAYS, auditDays: e.RETAIN_AUDIT_DAYS, usageDays: e.RETAIN_USAGE_DAYS,
      });
      for (const [kind, n] of Object.entries(counts)) if (n > 0) this.metrics.purged.inc({ kind }, n);
    } catch (err) {
      this.log.warn(`Retention sweep failed: ${(err as Error).message}`);
    }
  }
}
