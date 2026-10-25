import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../common/activity.service';
import { AuditService } from '../common/audit.service';
import { ConnectorRegistry } from '../connectors/registry';
import { hasScope } from '../connectors/send';
import { ConnectorAccount, NormalizedEvent, ProviderAuthError, ProviderError, RsvpRequest } from '../connectors/types';
import { Db, DbCtx } from '../db/db.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { SyncService } from '../ingestion/sync.service';

export interface Slot {
  start: Date;
  end: Date;
}
export interface SlotOptions {
  from: Date;
  days: number;
  durationMin: number;
  timezone: string;
  /** Local working hours, e.g. 9 to 17. */
  dayStartHour: number;
  dayEndHour: number;
  includeWeekends: boolean;
  /** Gap kept before and after existing events. */
  bufferMin: number;
  limit: number;
  maxPerDay: number;
}

/** Offset of `tz` from UTC at the given instant, in ms. */
function tzOffsetMs(at: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads y-m-d h:min. Handles daylight-saving changes. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

/**
 * Free time for proposing meetings: working hours in the user's time zone, minus every confirmed or tentative event
 * (and a buffer around it), on half-hour starts, spread across days. Pure function: it reads only what it is given.
 */
export function findFreeSlots(busy: Slot[], o: SlotOptions): Slot[] {
  const buf = o.bufferMin * 60_000;
  const blocks = busy.map((b) => ({ s: b.start.getTime() - buf, e: b.end.getTime() + buf })).sort((a, b) => a.s - b.s);
  const dur = o.durationMin * 60_000;
  const earliest = Math.max(o.from.getTime(), Date.now()) + 30 * 60_000;
  const out: Slot[] = [];
  const day = new Date(o.from);
  const dateParts = (dt: Date) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: o.timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(dt).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, wd: p.weekday };
  };
  for (let i = 0; i <= o.days && out.length < o.limit; i++) {
    const { y, m, d, wd } = dateParts(new Date(day.getTime() + i * 86_400_000));
    if (!o.includeWeekends && (wd === 'Sat' || wd === 'Sun')) continue;
    const open = zonedToUtc(y, m, d, o.dayStartHour, 0, o.timezone).getTime();
    const close = zonedToUtc(y, m, d, o.dayEndHour, 0, o.timezone).getTime();
    let perDay = 0;
    for (let s = Math.max(open, Math.ceil(earliest / 1_800_000) * 1_800_000); s + dur <= close && perDay < o.maxPerDay && out.length < o.limit; s += 1_800_000) {
      if (blocks.some((b) => s < b.e && s + dur > b.s)) continue;
      out.push({ start: new Date(s), end: new Date(s + dur) });
      perDay++;
      s += 2 * 3_600_000 - 1_800_000; // leave room between suggestions on the same day
    }
  }
  return out;
}

@Injectable()
export class CalendarActionsService {
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly sync: SyncService,
    private readonly audit: AuditService,
    private readonly ingestion: IngestionService,
    private readonly activity: ActivityService,
  ) {}

  /** Suggestions come from the user's own synced calendars only. Nothing is sent or created. */
  async suggestTimes(ctx: DbCtx, o: Omit<SlotOptions, 'from'>): Promise<Slot[]> {
    const from = new Date();
    const to = new Date(from.getTime() + (o.days + 1) * 86_400_000);
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(`SELECT start_at, end_at FROM calendar_events WHERE status <> 'cancelled' AND end_at > $1 AND start_at < $2`, [from, to]),
      )
    ).rows;
    return findFreeSlots(rows.map((r) => ({ start: r.start_at, end: r.end_at })), { ...o, from });
  }

  /** Accept, decline or tentatively accept an invitation, after the user confirmed in the client. */
  async respond(ctx: DbCtx, eventId: string, r: Pick<RsvpRequest, 'response' | 'comment'>): Promise<void> {
    const ev = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT e.id, e.external_id, e.title, e.end_at, e.status, a.id AS account_id, a.channel, a.external_id AS account_external, a.status AS account_status, a.scopes,
                  a.enc_tokens, a.tenant_id, a.user_id, a.sync_cursor, a.backfill_days, a.settings
           FROM calendar_events e JOIN connected_accounts a ON a.id = e.account_id WHERE e.id = $1`,
          [eventId],
        ),
      )
    ).rows[0];
    if (!ev) throw new NotFoundException();
    const connector = this.registry.get(ev.channel);
    if (!connector?.respondToEvent) throw new ConflictException({ code: 'unsupported', message: 'Responding is not supported for this calendar.' });
    if (!hasScope(ev.scopes, connector.writeScope)) throw new ConflictException({ code: 'send_not_enabled', message: 'Responding is not enabled for this calendar. Reconnect it with "Allow replies and responses" turned on.' });
    if (ev.account_status !== 'active') throw new ConflictException({ code: 'reauth', message: 'Reconnect this calendar first.' });
    if (ev.status === 'cancelled' || new Date(ev.end_at) < new Date()) throw new ConflictException({ code: 'event_over', message: 'This event is cancelled or already over.' });

    try {
      const tokens = await this.sync.freshTokens(ctx, { id: ev.account_id, tenant_id: ev.tenant_id, user_id: ev.user_id, channel: ev.channel, external_id: ev.account_external, status: ev.account_status, enc_tokens: ev.enc_tokens, sync_cursor: ev.sync_cursor, backfill_days: ev.backfill_days, settings: ev.settings }, connector);
      const ca: ConnectorAccount = { id: ev.account_id, channel: ev.channel, externalId: ev.account_external, tokens, backfillDays: ev.backfill_days, settings: ev.settings ?? {} };
      await connector.respondToEvent(ca, { eventExternalId: ev.external_id, response: r.response, comment: r.comment?.slice(0, 500) });
    } catch (e) {
      await this.audit.log(ctx, 'event.respond_failed', eventId, { channel: ev.channel });
      if (e instanceof ProviderAuthError) {
        await this.db.tx(ctx, (c) => c.query(`UPDATE connected_accounts SET status = 'reauth', last_error = 'Reconnect required' WHERE id = $1`, [ev.account_id]));
        throw new ConflictException({ code: 'reauth', message: 'Reconnect this calendar, then try again.' });
      }
      if (e instanceof ProviderError && e.status === 422) throw new ConflictException({ code: 'not_attendee', message: e.message });
      throw new ConflictException({ code: 'respond_failed', message: 'The calendar did not accept the response. Nothing was changed; try again.' });
    }
    await this.audit.log(ctx, 'event.respond', eventId, { channel: ev.channel, response: r.response });
  }

  // ---------------------------------------------------------------- calendar writes
  // Only this class writes to a calendar. A direct call from the UI carries the user's confirmation; the workflow engine
  // calls it only after the user approved the exact event (see ApprovalsService). Nothing here retries on its own.

  /** Events that overlap [start, end). Cancelled events do not count. */
  async conflicts(ctx: DbCtx, start: Date, end: Date, excludeEventId?: string) {
    return (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT id, title, start_at, end_at FROM calendar_events
           WHERE status <> 'cancelled' AND start_at < $2 AND end_at > $1 AND ($3::uuid IS NULL OR id <> $3) ORDER BY start_at LIMIT 10`,
          [start, end, excludeEventId ?? null],
        ),
      )
    ).rows;
  }

  /** The calendar account to write to: the one named, or the first active calendar that was connected with write access. */
  private async writableAccount(ctx: DbCtx, accountId?: string) {
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT id, tenant_id, user_id, channel, external_id, status, scopes, enc_tokens, sync_cursor, backfill_days, settings
           FROM connected_accounts WHERE channel IN ('google_calendar','microsoft_calendar') AND ($1::uuid IS NULL OR id = $1) ORDER BY created_at`,
          [accountId ?? null],
        ),
      )
    ).rows;
    if (accountId && !rows.length) throw new NotFoundException('Calendar account not found');
    const usable = rows.find((a) => a.status === 'active' && hasScope(a.scopes, this.registry.get(a.channel)?.writeScope));
    if (!usable) {
      const any = rows[0];
      if (!any) throw new ConflictException({ code: 'no_calendar', message: 'Connect a calendar first.' });
      if (any.status !== 'active') throw new ConflictException({ code: 'reauth', message: 'Reconnect this calendar first.' });
      throw new ConflictException({ code: 'send_not_enabled', message: 'Calendar changes are not enabled for this account. Reconnect it with "Allow replies and responses" turned on.' });
    }
    return usable;
  }

  private async connected(ctx: DbCtx, acct: Record<string, any>) {
    const connector = this.registry.get(acct.channel)!;
    const tokens = await this.sync.freshTokens(ctx, acct as never, connector);
    const ca: ConnectorAccount = { id: acct.id, channel: acct.channel, externalId: acct.external_id, tokens, backfillDays: acct.backfill_days, settings: acct.settings ?? {} };
    return { connector, ca };
  }

  private async failed(ctx: DbCtx, e: unknown, accountId: string, what: string): Promise<never> {
    if (e instanceof ProviderAuthError) {
      await this.db.tx(ctx, (c) => c.query(`UPDATE connected_accounts SET status = 'reauth', last_error = 'Reconnect required' WHERE id = $1`, [accountId]));
      throw new ConflictException({ code: 'reauth', message: 'Reconnect this calendar, then try again.' });
    }
    if (e instanceof ProviderError && e.status === 403) throw new ConflictException({ code: 'forbidden', message: 'The calendar refused this change. You may only be an attendee of that event.' });
    throw new ConflictException({ code: 'event_write_failed', message: `The calendar did not accept the ${what}. Nothing was changed; try again.` });
  }

  /** Stores the provider's copy right away so it shows before the next sync. */
  private async store(ctx: DbCtx, acct: Record<string, any>, ev: NormalizedEvent | null) {
    if (ev && acct.sync_cursor) await this.ingestion.apply(ctx, acct as never, { messages: [], events: [ev], deletedExternalIds: [], cursor: acct.sync_cursor }).catch(() => undefined);
  }

  async createEvent(ctx: DbCtx, e: EventInput, o: WriteOpts = {}): Promise<{ id: string | null; externalId: string; conflicts: unknown[] }> {
    if (e.end <= e.start) throw new BadRequestException('The event must end after it starts');
    const conflicts = await this.conflicts(ctx, e.start, e.end);
    if (conflicts.length && !o.acceptConflicts) throw new ConflictException({ code: 'event_conflict', message: 'This overlaps another event.', conflicts });
    const acct = await this.writableAccount(ctx, e.accountId);
    let made;
    try {
      const { connector, ca } = await this.connected(ctx, acct);
      made = await connector.createEvent!(ca, { title: e.title, start: e.start, end: e.end, allDay: e.allDay, timezone: e.timezone, location: e.location, description: e.description, attendees: e.attendees });
    } catch (err) {
      await this.audit.log(ctx, 'event.create_failed', acct.id, { channel: acct.channel });
      return this.failed(ctx, err, acct.id, 'new event');
    }
    await this.store(ctx, acct, made.event);
    const local = (await this.db.tx(ctx, (c) => c.query('SELECT id FROM calendar_events WHERE account_id = $1 AND external_id = $2', [acct.id, made.externalId]))).rows[0];
    await this.audit.log(ctx, 'event.create', local?.id ?? acct.id, { channel: acct.channel, attendees: e.attendees?.length ?? 0, by: o.actor ?? 'user' });
    await this.activity.log(ctx, { actor: o.actor ?? 'user', kind: 'calendar.create', summary: `Created event "${e.title.slice(0, 80)}"`, workflowId: o.workflowId, runId: o.runId, meta: { eventId: local?.id ?? null, conflicts: conflicts.length } });
    return { id: local?.id ?? null, externalId: made.externalId, conflicts };
  }

  private async eventRow(ctx: DbCtx, eventId: string) {
    const ev = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT e.id, e.external_id, e.title, e.start_at, e.end_at, e.status, a.id AS account_id, a.channel, a.external_id AS account_external, a.status AS account_status, a.scopes,
                  a.enc_tokens, a.tenant_id, a.user_id, a.sync_cursor, a.backfill_days, a.settings
           FROM calendar_events e JOIN connected_accounts a ON a.id = e.account_id WHERE e.id = $1`,
          [eventId],
        ),
      )
    ).rows[0];
    if (!ev) throw new NotFoundException('Event not found');
    const connector = this.registry.get(ev.channel);
    if (!connector?.updateEvent) throw new ConflictException({ code: 'unsupported', message: 'Changing events is not supported for this calendar.' });
    if (!hasScope(ev.scopes, connector.writeScope)) throw new ConflictException({ code: 'send_not_enabled', message: 'Calendar changes are not enabled for this account. Reconnect it with "Allow replies and responses" turned on.' });
    if (ev.account_status !== 'active') throw new ConflictException({ code: 'reauth', message: 'Reconnect this calendar first.' });
    return { ev, acct: { id: ev.account_id, tenant_id: ev.tenant_id, user_id: ev.user_id, channel: ev.channel, external_id: ev.account_external, status: ev.account_status, enc_tokens: ev.enc_tokens, sync_cursor: ev.sync_cursor, backfill_days: ev.backfill_days, settings: ev.settings } };
  }

  /** Reschedules or edits an event. `start` and `end` must be given together. */
  async updateEvent(ctx: DbCtx, eventId: string, p: EventPatch, o: WriteOpts = {}): Promise<{ conflicts: unknown[] }> {
    if ((p.start && !p.end) || (!p.start && p.end)) throw new BadRequestException('Give both the new start and the new end');
    if (p.start && p.end && p.end <= p.start) throw new BadRequestException('The event must end after it starts');
    const { ev, acct } = await this.eventRow(ctx, eventId);
    if (ev.status === 'cancelled') throw new ConflictException({ code: 'event_over', message: 'This event is cancelled.' });
    const conflicts = p.start && p.end ? await this.conflicts(ctx, p.start, p.end, eventId) : [];
    if (conflicts.length && !o.acceptConflicts) throw new ConflictException({ code: 'event_conflict', message: 'The new time overlaps another event.', conflicts });
    let made;
    try {
      const { connector, ca } = await this.connected(ctx, acct);
      made = await connector.updateEvent!(ca, ev.external_id, p);
    } catch (err) {
      await this.audit.log(ctx, 'event.update_failed', eventId, { channel: ev.channel });
      return this.failed(ctx, err, ev.account_id, 'change');
    }
    if (made.event) await this.store(ctx, acct, made.event);
    else {
      await this.db.tx(ctx, (c) =>
        c.query(
          `UPDATE calendar_events SET title = coalesce($2, title), start_at = coalesce($3, start_at), end_at = coalesce($4, end_at), location = coalesce($5, location) WHERE id = $1`,
          [eventId, p.title ?? null, p.start ?? null, p.end ?? null, p.location ?? null],
        ),
      );
    }
    await this.audit.log(ctx, 'event.update', eventId, { channel: ev.channel, rescheduled: !!p.start, by: o.actor ?? 'user' });
    await this.activity.log(ctx, { actor: o.actor ?? 'user', kind: p.start ? 'calendar.reschedule' : 'calendar.update', summary: `${p.start ? 'Rescheduled' : 'Edited'} event "${(p.title ?? ev.title).slice(0, 80)}"`, workflowId: o.workflowId, runId: o.runId, meta: { eventId } });
    return { conflicts };
  }

  async cancelEvent(ctx: DbCtx, eventId: string, o: WriteOpts = {}): Promise<void> {
    const { ev, acct } = await this.eventRow(ctx, eventId);
    const connector = this.registry.get(ev.channel)!;
    if (!connector.cancelEvent) throw new ConflictException({ code: 'unsupported', message: 'Cancelling events is not supported for this calendar.' });
    try {
      const { ca } = await this.connected(ctx, acct);
      await connector.cancelEvent(ca, ev.external_id);
    } catch (err) {
      await this.audit.log(ctx, 'event.cancel_failed', eventId, { channel: ev.channel });
      return this.failed(ctx, err, ev.account_id, 'cancellation');
    }
    await this.db.tx(ctx, (c) => c.query('DELETE FROM calendar_events WHERE id = $1', [eventId]));
    await this.audit.log(ctx, 'event.cancel', eventId, { channel: ev.channel, by: o.actor ?? 'user' });
    await this.activity.log(ctx, { actor: o.actor ?? 'user', kind: 'calendar.cancel', summary: `Cancelled event "${ev.title.slice(0, 80)}"`, workflowId: o.workflowId, runId: o.runId });
  }
}

export interface EventInput {
  accountId?: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  description?: string | null;
  attendees?: string[];
}
export type EventPatch = Partial<Omit<EventInput, 'accountId'>>;
export interface WriteOpts {
  acceptConflicts?: boolean;
  actor?: 'user' | 'workflow';
  workflowId?: string;
  runId?: string;
}
