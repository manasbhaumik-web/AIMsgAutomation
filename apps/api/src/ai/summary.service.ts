import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { ConsentService } from './consent.service';
import { neutralize, truncate } from './helpers';

export interface SummaryResult {
  text: string;
  cached: boolean;
  model: string | null;
  createdAt: Date;
}

export type SummaryTarget =
  | { scope: 'thread'; threadId: string }
  | { scope: 'channel'; channel?: string; accountId?: string; days: number }
  | { scope: 'topic'; topicId: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Thread, channel and topic summaries. Results are cached and regenerated only when the underlying content changed. */
@Injectable()
export class SummaryService {
  constructor(private readonly db: Db, private readonly gateway: LlmGateway, private readonly consent: ConsentService) {}

  async summarize(ctx: DbCtx, t: SummaryTarget, refresh = false): Promise<SummaryResult> {
    await this.consent.require(ctx);
    const { ref, content, maxWords } = await this.gather(ctx, t);
    const hash = sha(content);

    if (!refresh) {
      const hit = (await this.db.tx(ctx, (c) => c.query('SELECT text, input_hash, model, created_at FROM summaries WHERE user_id = $1 AND scope = $2 AND ref = $3', [ctx.userId, t.scope, ref]))).rows[0];
      if (hit && hit.input_hash === hash) return { text: hit.text, cached: true, model: hit.model, createdAt: hit.created_at };
    }
    const res = await this.gateway.run(ctx, 'summarize', { scope: t.scope, content: neutralize(content), max_words: String(maxWords) });
    const saved = await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO summaries(tenant_id, user_id, scope, ref, text, input_hash, model, prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, scope, ref) DO UPDATE SET text = EXCLUDED.text, input_hash = EXCLUDED.input_hash, model = EXCLUDED.model,
           prompt_version = EXCLUDED.prompt_version, created_at = now() RETURNING created_at`,
        [ctx.tenantId, ctx.userId, t.scope, ref, res.text.trim(), hash, res.model, res.promptVersion],
      ),
    );
    return { text: res.text.trim(), cached: false, model: res.model, createdAt: saved.rows[0].created_at };
  }

  private async gather(ctx: DbCtx, t: SummaryTarget): Promise<{ ref: string; content: string; maxWords: number }> {
    if (t.scope === 'thread') {
      const rows = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT m.sender, m.subject, m.body_text, m."timestamp", m.direction FROM messages m
             JOIN connected_accounts a ON a.id = m.account_id
             WHERE m.thread_id = $1 AND a.ai_enabled ORDER BY m."timestamp" DESC LIMIT 30`,
            [t.threadId],
          ),
        )
      ).rows.reverse();
      if (!rows.length) throw new NotFoundException('Conversation not found, or AI is switched off for its account');
      const content = rows.map((m) => `[${new Date(m.timestamp).toISOString().slice(0, 16)}] ${m.direction === 'outbound' ? 'You' : (m.sender?.name ?? m.sender?.email ?? m.sender?.handle ?? 'Unknown')}: ${m.subject ?? ''}\n${truncate(m.body_text, 1500)}`).join('\n\n');
      return { ref: t.threadId, content, maxWords: 120 };
    }
    if (t.scope === 'channel') {
      const rows = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT th.id, th.subject, th.last_message_at, th.channel, ta.priority,
                    (SELECT string_agg(tp.name::text, ', ') FROM thread_topics tt JOIN topics tp ON tp.id = tt.topic_id WHERE tt.thread_id = th.id) AS topics,
                    (SELECT left(m.body_text, 300) FROM messages m WHERE m.thread_id = th.id ORDER BY m."timestamp" DESC LIMIT 1) AS latest
             FROM threads th JOIN connected_accounts a ON a.id = th.account_id
             LEFT JOIN thread_analysis ta ON ta.thread_id = th.id
             WHERE a.ai_enabled AND th.last_message_at > now() - make_interval(days => $1)
               AND ($2::uuid IS NULL OR th.account_id = $2) AND ($3::text IS NULL OR th.channel = $3)
             ORDER BY th.last_message_at DESC LIMIT 40`,
            [t.days, t.accountId ?? null, t.channel ?? null],
          ),
        )
      ).rows;
      if (!rows.length) throw new NotFoundException('No recent conversations to summarize');
      return { ref: `${t.accountId ?? t.channel ?? 'all'}:${t.days}d`, content: this.listing(rows), maxWords: 200 };
    }
    const topic = (await this.db.tx(ctx, (c) => c.query('SELECT name FROM topics WHERE id = $1', [t.topicId]))).rows[0];
    if (!topic) throw new NotFoundException('Topic not found');
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT th.id, th.subject, th.last_message_at, th.channel, ta.priority, NULL::text AS topics,
                  (SELECT left(m.body_text, 300) FROM messages m WHERE m.thread_id = th.id ORDER BY m."timestamp" DESC LIMIT 1) AS latest
           FROM thread_topics tt JOIN threads th ON th.id = tt.thread_id JOIN connected_accounts a ON a.id = th.account_id
           LEFT JOIN thread_analysis ta ON ta.thread_id = th.id
           WHERE tt.topic_id = $1 AND a.ai_enabled ORDER BY th.last_message_at DESC LIMIT 30`,
          [t.topicId],
        ),
      )
    ).rows;
    if (!rows.length) throw new NotFoundException('No conversations under this topic');
    return { ref: t.topicId, content: `Topic: ${topic.name}\n\n${this.listing(rows)}`, maxWords: 200 };
  }

  private listing(rows: { subject: string | null; last_message_at: Date; channel: string; priority: string | null; topics: string | null; latest: string | null }[]): string {
    return rows
      .map((r) => `- ${new Date(r.last_message_at).toISOString().slice(0, 10)} · ${r.channel} · ${r.priority ?? 'unrated'}${r.topics ? ` · topics: ${r.topics}` : ''}\n  Subject: ${r.subject ?? '(none)'}\n  Latest: ${truncate(r.latest, 300)}`)
      .join('\n');
  }
}
