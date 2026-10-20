import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { AccountsService } from '../connectors/accounts.service';
import { Db } from '../db/db.service';

const threadsQuery = z.object({
  accountId: z.string().uuid().optional(),
  channel: z.enum(['gmail', 'outlook', 'slack', 'teams', 'whatsapp']).optional(),
  unreadOnly: z.enum(['true', 'false']).default('false'),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  priority: z.enum(['urgent', 'needs_reply', 'fyi', 'low']).optional(),
  topicId: z.string().uuid().optional(),
});
const eventsQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
const readBody = z.object({ read: z.boolean() });

/** Read APIs. Every query runs inside Db.tx, so Postgres RLS limits it to the caller's rows. */
@Controller()
export class InboxController {
  constructor(private readonly db: Db, private readonly accounts: AccountsService) {}

  /** Channels -> accounts, with unread counts. */
  @Get('inbox')
  async inbox(@CurrentUser() u: AuthUser) {
    const rows = await this.accounts.list(u);
    const byChannel = new Map<string, { channel: string; unread: number; accounts: any[] }>();
    for (const a of rows) {
      const g = byChannel.get(a.channel) ?? { channel: a.channel, unread: 0, accounts: [] as any[] };
      g.unread += a.unread;
      g.accounts.push(a);
      byChannel.set(a.channel, g);
    }
    return { channels: [...byChannel.values()] };
  }

  @Get('inbox/threads')
  async threads(@CurrentUser() u: AuthUser, @Query(new ZodPipe(threadsQuery)) q: z.infer<typeof threadsQuery>) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `SELECT t.id, t.account_id, t.channel, t.subject, t.last_message_at,
                count(m.id)::int AS message_count,
                count(m.id) FILTER (WHERE NOT m.is_read AND m.direction = 'inbound')::int AS unread,
                (array_agg(m.sender ORDER BY m."timestamp" DESC))[1] AS last_sender,
                (array_agg(left(m.body_text, 200) ORDER BY m."timestamp" DESC))[1] AS snippet,
                ta.priority,
                coalesce((SELECT json_agg(json_build_object('id', tp.id, 'name', tp.name::text) ORDER BY tp.name)
                          FROM thread_topics tt JOIN topics tp ON tp.id = tt.topic_id WHERE tt.thread_id = t.id), '[]'::json) AS topics
         FROM threads t JOIN messages m ON m.thread_id = t.id LEFT JOIN thread_analysis ta ON ta.thread_id = t.id
         WHERE ($1::uuid IS NULL OR t.account_id = $1) AND ($2::text IS NULL OR t.channel = $2)
           AND ($3::timestamptz IS NULL OR t.last_message_at < $3)
           AND ($6::text IS NULL OR ta.priority = $6)
           AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM thread_topics f WHERE f.thread_id = t.id AND f.topic_id = $7))
         GROUP BY t.id, ta.thread_id
         HAVING (NOT $4::boolean OR count(m.id) FILTER (WHERE NOT m.is_read AND m.direction = 'inbound') > 0)
         ORDER BY t.last_message_at DESC LIMIT $5`,
        [q.accountId ?? null, q.channel ?? null, q.before ?? null, q.unreadOnly === 'true', q.limit, q.priority ?? null, q.topicId ?? null],
      ),
    );
    return { threads: r.rows, nextBefore: r.rows.length === q.limit ? r.rows[r.rows.length - 1].last_message_at : null };
  }

  @Get('threads/:id')
  async thread(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const out = await this.db.tx(dbCtx(u), async (c) => {
      const t = await c.query(
        `SELECT t.id, t.account_id, t.channel, t.subject, t.last_message_at, ta.priority,
                coalesce((SELECT json_agg(json_build_object('id', tp.id, 'name', tp.name::text) ORDER BY tp.name)
                          FROM thread_topics tt JOIN topics tp ON tp.id = tt.topic_id WHERE tt.thread_id = t.id), '[]'::json) AS topics,
                coalesce((SELECT json_agg(json_build_object('id', ai.id, 'text', ai.text, 'due_at', ai.due_at, 'status', ai.status) ORDER BY ai.created_at)
                          FROM action_items ai WHERE ai.thread_id = t.id), '[]'::json) AS action_items
         FROM threads t LEFT JOIN thread_analysis ta ON ta.thread_id = t.id WHERE t.id = $1`,
        [id],
      );
      if (!t.rows[0]) return null;
      const m = await c.query(
        `SELECT id, sender, recipients, subject, body_text, body_html_sanitized, attachments_meta, "timestamp", direction, is_read
         FROM messages WHERE thread_id = $1 ORDER BY "timestamp"`,
        [id],
      );
      return { ...t.rows[0], messages: m.rows };
    });
    if (!out) throw new NotFoundException();
    return out;
  }

  /** Read state is kept locally; it is not written back to the provider mailbox. */
  @HttpCode(204) @Post('threads/:id/read')
  async markThread(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(readBody)) b: z.infer<typeof readBody>) {
    await this.db.tx(dbCtx(u), (c) => c.query('UPDATE messages SET is_read = $2 WHERE thread_id = $1 AND direction = $3', [id, b.read, 'inbound']));
  }

  @HttpCode(204) @Post('messages/:id/read')
  async markMessage(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(readBody)) b: z.infer<typeof readBody>) {
    await this.db.tx(dbCtx(u), (c) => c.query('UPDATE messages SET is_read = $2 WHERE id = $1', [id, b.read]));
  }

  @Get('calendar/events')
  async events(@CurrentUser() u: AuthUser, @Query(new ZodPipe(eventsQuery)) q: z.infer<typeof eventsQuery>) {
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 2 * 86_400_000);
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `SELECT e.id, e.account_id, e.channel, e.title, e.start_at, e.end_at, e.all_day, e.timezone, e.organizer, e.attendees,
                e.location, e.meeting_link, e.status
         FROM calendar_events e WHERE e.status <> 'cancelled' AND e.end_at >= $1 AND e.start_at < $2 ORDER BY e.start_at LIMIT 500`,
        [from, to],
      ),
    );
    return { from, to, events: r.rows };
  }
}
