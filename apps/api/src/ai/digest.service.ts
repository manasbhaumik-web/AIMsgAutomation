import { Injectable } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { ConsentService } from './consent.service';
import { isValidTimeZone, localDate, localHour, neutralize, startOfLocalDay, truncate } from './helpers';

export interface DigestSchedule {
  enabled: boolean;
  hour: number;
  timezone: string;
}

const DEFAULT_SCHEDULE: DigestSchedule = { enabled: false, hour: 8, timezone: 'UTC' };

@Injectable()
export class DigestService {
  constructor(private readonly db: Db, private readonly gateway: LlmGateway, private readonly consent: ConsentService) {}

  async schedule(ctx: DbCtx): Promise<DigestSchedule> {
    const r = await this.db.tx(ctx, (c) => c.query(`SELECT settings -> 'digest' AS d FROM users WHERE id = $1`, [ctx.userId]));
    return { ...DEFAULT_SCHEDULE, ...(r.rows[0]?.d ?? {}) };
  }

  async setSchedule(ctx: DbCtx, s: DigestSchedule): Promise<DigestSchedule> {
    const clean = { enabled: s.enabled, hour: Math.min(23, Math.max(0, Math.trunc(s.hour))), timezone: isValidTimeZone(s.timezone) ? s.timezone : 'UTC' };
    await this.db.tx(ctx, (c) => c.query(`UPDATE users SET settings = jsonb_set(settings, '{digest}', $2::jsonb, true) WHERE id = $1`, [ctx.userId, JSON.stringify(clean)]));
    return clean;
  }

  async latest(ctx: DbCtx) {
    const r = await this.db.tx(ctx, (c) => c.query('SELECT digest_date, text, model, created_at FROM digests WHERE user_id = $1 ORDER BY digest_date DESC LIMIT 1', [ctx.userId]));
    return r.rows[0] ?? null;
  }

  /** True when the user's digest hour has passed today and today's digest does not exist yet. */
  async isDue(ctx: DbCtx, sched: DigestSchedule, now = new Date()): Promise<boolean> {
    if (!sched.enabled || localHour(sched.timezone, now) < sched.hour) return false;
    const r = await this.db.tx(ctx, (c) => c.query('SELECT 1 FROM digests WHERE user_id = $1 AND digest_date = $2::date', [ctx.userId, localDate(sched.timezone, now)]));
    return r.rowCount === 0;
  }

  /** Builds the digest from the last 24h of activity, today and tomorrow's calendar, and open action items. */
  async generate(ctx: DbCtx, now = new Date()) {
    await this.consent.require(ctx);
    const sched = await this.schedule(ctx);
    const tz = sched.timezone;
    const date = localDate(tz, now);
    const dayStart = startOfLocalDay(tz, now);
    // Start of the day after tomorrow: noon of that day is safely inside it even across a DST change.
    const dayAfterTomorrow = startOfLocalDay(tz, new Date(dayStart.getTime() + 60 * 3_600_000));

    const [activity, events, actions] = await Promise.all([
      this.db.tx(ctx, (c) =>
        c.query(
          `SELECT th.channel, th.subject, th.last_message_at, ta.priority,
                  (SELECT string_agg(tp.name::text, ', ') FROM thread_topics tt JOIN topics tp ON tp.id = tt.topic_id WHERE tt.thread_id = th.id) AS topics,
                  (SELECT m.sender FROM messages m WHERE m.thread_id = th.id AND m.direction = 'inbound' ORDER BY m."timestamp" DESC LIMIT 1) AS sender
           FROM threads th JOIN connected_accounts a ON a.id = th.account_id LEFT JOIN thread_analysis ta ON ta.thread_id = th.id
           WHERE a.ai_enabled AND th.last_message_at > $1::timestamptz - interval '24 hours'
           ORDER BY (ta.priority = 'urgent') DESC NULLS LAST, (ta.priority = 'needs_reply') DESC NULLS LAST, th.last_message_at DESC LIMIT 60`,
          [now],
        ),
      ),
      this.db.tx(ctx, (c) =>
        c.query(
          `SELECT e.title, e.start_at, e.end_at, e.all_day, e.location FROM calendar_events e JOIN connected_accounts a ON a.id = e.account_id
           WHERE a.ai_enabled AND e.status <> 'cancelled' AND e.end_at >= $1 AND e.start_at < $2 ORDER BY e.start_at LIMIT 40`,
          [dayStart, dayAfterTomorrow],
        ),
      ),
      this.db.tx(ctx, (c) =>
        c.query(
          `SELECT ai.text, ai.due_at FROM action_items ai JOIN threads th ON th.id = ai.thread_id JOIN connected_accounts a ON a.id = th.account_id
           WHERE a.ai_enabled AND ai.status = 'open' AND (ai.due_at IS NULL OR ai.due_at < $1::timestamptz + interval '3 days')
           ORDER BY ai.due_at NULLS LAST LIMIT 20`,
          [now],
        ),
      ),
    ]);

    const fmt = (d: Date) => new Date(d).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const res = await this.gateway.run(ctx, 'digest', {
      date,
      activity: neutralize(activity.rows.map((r) => `- ${r.channel} · ${r.priority ?? 'unrated'} · from ${r.sender?.name ?? r.sender?.email ?? r.sender?.handle ?? 'unknown'} · ${truncate(r.subject, 120)}${r.topics ? ` · ${r.topics}` : ''}`).join('\n') || '(nothing new)'),
      calendar: neutralize(events.rows.map((e) => `- ${e.all_day ? `${fmt(e.start_at).slice(0, 6)} all day` : `${fmt(e.start_at)} to ${fmt(e.end_at).slice(-5)}`}: ${truncate(e.title, 100)}${e.location ? ` @ ${truncate(e.location, 60)}` : ''}`).join('\n') || '(no events)'),
      actions: neutralize(actions.rows.map((a) => `- ${truncate(a.text, 160)}${a.due_at ? ` (due ${new Date(a.due_at).toISOString().slice(0, 10)})` : ''}`).join('\n') || '(none)'),
    });
    const text = res.text.trim();
    await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO digests(tenant_id, user_id, digest_date, text, model) VALUES ($1,$2,$3::date,$4,$5)
         ON CONFLICT (user_id, digest_date) DO UPDATE SET text = EXCLUDED.text, model = EXCLUDED.model, created_at = now()`,
        [ctx.tenantId, ctx.userId, date, text, res.model],
      ),
    );
    return { digest_date: date, text, model: res.model };
  }
}
