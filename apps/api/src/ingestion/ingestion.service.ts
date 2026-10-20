import { Injectable } from '@nestjs/common';
import { sanitizeMailHtml } from '../connectors/text';
import { SyncResult } from '../connectors/types';
import { Db, DbCtx } from '../db/db.service';

const MAX_TEXT = 200_000;
const MAX_HTML = 500_000;

export interface AccountRow {
  id: string;
  tenant_id: string;
  user_id: string;
  channel: string;
}

/** Writes normalized provider data. Idempotent: re-applying the same result changes nothing. */
@Injectable()
export class IngestionService {
  constructor(private readonly db: Db) {}

  async apply(ctx: DbCtx, acct: AccountRow, r: SyncResult): Promise<void> {
    await this.db.tx(ctx, async (c) => {
      for (const m of r.messages) {
        const t = await c.query(
          `INSERT INTO threads(tenant_id, user_id, account_id, channel, external_id, subject, last_message_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (account_id, external_id) DO UPDATE
             SET last_message_at = GREATEST(threads.last_message_at, EXCLUDED.last_message_at),
                 subject = coalesce(threads.subject, EXCLUDED.subject)
           RETURNING id`,
          [acct.tenant_id, acct.user_id, acct.id, acct.channel, m.threadExternalId, m.subject, m.timestamp],
        );
        await c.query(
          `INSERT INTO messages(tenant_id, user_id, account_id, thread_id, channel, external_id, sender, recipients, subject,
                                body_text, body_html_sanitized, attachments_meta, "timestamp", direction, is_read, raw_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (account_id, external_id) DO UPDATE
             SET sender = EXCLUDED.sender, recipients = EXCLUDED.recipients, subject = EXCLUDED.subject, body_text = EXCLUDED.body_text,
                 body_html_sanitized = EXCLUDED.body_html_sanitized, attachments_meta = EXCLUDED.attachments_meta,
                 is_read = EXCLUDED.is_read, thread_id = EXCLUDED.thread_id`,
          [
            acct.tenant_id, acct.user_id, acct.id, t.rows[0].id, acct.channel, m.externalId,
            JSON.stringify(m.sender), JSON.stringify(m.recipients), m.subject,
            m.bodyText.slice(0, MAX_TEXT), m.bodyHtml ? sanitizeMailHtml(m.bodyHtml).slice(0, MAX_HTML) : null,
            JSON.stringify(m.attachments), m.timestamp, m.direction, m.isRead, m.rawRef,
          ],
        );
      }
      for (const e of r.events) {
        await c.query(
          `INSERT INTO calendar_events(tenant_id, user_id, account_id, channel, external_id, title, start_at, end_at, all_day,
                                       timezone, organizer, attendees, location, meeting_link, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (account_id, external_id) DO UPDATE
             SET title = EXCLUDED.title, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, all_day = EXCLUDED.all_day,
                 timezone = EXCLUDED.timezone, organizer = EXCLUDED.organizer, attendees = EXCLUDED.attendees,
                 location = EXCLUDED.location, meeting_link = EXCLUDED.meeting_link, status = EXCLUDED.status`,
          [
            acct.tenant_id, acct.user_id, acct.id, acct.channel, e.externalId, e.title, e.start, e.end, e.allDay,
            e.timezone, JSON.stringify(e.organizer), JSON.stringify(e.attendees), e.location, e.meetingLink, e.status,
          ],
        );
      }
      if (r.deletedExternalIds.length) {
        await c.query('DELETE FROM messages WHERE account_id = $1 AND external_id = ANY($2::text[])', [acct.id, r.deletedExternalIds]);
        await c.query('DELETE FROM calendar_events WHERE account_id = $1 AND external_id = ANY($2::text[])', [acct.id, r.deletedExternalIds]);
        await c.query('DELETE FROM threads t WHERE t.account_id = $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)', [acct.id]);
      }
      await c.query(`UPDATE connected_accounts SET sync_cursor = $2, last_sync_at = now(), last_error = NULL WHERE id = $1`, [acct.id, r.cursor]);
    });
  }
}
