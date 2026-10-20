import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { ConnectorRegistry } from '../connectors/registry';
import { hasScope } from '../connectors/send';
import { ConnectorAccount, ProviderAuthError, ProviderError, RsvpRequest } from '../connectors/types';
import { Db, DbCtx } from '../db/db.service';
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
  constructor(private readonly db: Db, private readonly registry: ConnectorRegistry, private readonly sync: SyncService, private readonly audit: AuditService) {}

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
}
