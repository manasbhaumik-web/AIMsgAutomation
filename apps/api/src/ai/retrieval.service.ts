import { Injectable, Logger } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { GatewayError } from '../llm/types';
import { keywordQuery, rrf, vectorLiteral } from './helpers';

export interface MessageHit {
  id: string;
  thread_id: string;
  channel: string;
  subject: string | null;
  sender: { name?: string; email?: string; handle?: string } | null;
  timestamp: Date;
  direction: string;
  body_text: string;
}

export interface EventHit {
  id: string;
  title: string;
  start_at: Date;
  end_at: Date;
  all_day: boolean;
  location: string | null;
  channel: string;
}

const CANDIDATES = 30;

/**
 * Hybrid retrieval over the caller's own mail: exact vector search plus Postgres full-text, fused with reciprocal
 * rank fusion. Every query runs inside the caller's RLS context and also filters on user_id explicitly, and only
 * covers accounts whose AI switch is on.
 */
@Injectable()
export class RetrievalService {
  private readonly log = new Logger(RetrievalService.name);

  constructor(private readonly db: Db, private readonly gateway: LlmGateway) {}

  async searchMessages(ctx: DbCtx, query: string, limit = 8): Promise<MessageHit[]> {
    const [vectorIds, keywordIds] = await Promise.all([this.vectorSearch(ctx, query), this.keywordSearch(ctx, query)]);
    const top = rrf([vectorIds, keywordIds]).slice(0, limit);
    if (!top.length) return [];
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT m.id, m.thread_id, m.channel, m.subject, m.sender, m."timestamp", m.direction, left(m.body_text, 2000) AS body_text
           FROM messages m JOIN connected_accounts a ON a.id = m.account_id
           WHERE m.id = ANY($1::uuid[]) AND m.user_id = $2 AND a.ai_enabled`,
          [top, ctx.userId],
        ),
      )
    ).rows as MessageHit[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return top.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  /** Nearby events (yesterday to two weeks ahead) so schedule questions can be answered without guessing dates. */
  async upcomingEvents(ctx: DbCtx, now = new Date()): Promise<EventHit[]> {
    const from = new Date(now.getTime() - 86_400_000);
    const to = new Date(now.getTime() + 14 * 86_400_000);
    return (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT e.id, e.title, e.start_at, e.end_at, e.all_day, e.location, e.channel
           FROM calendar_events e JOIN connected_accounts a ON a.id = e.account_id
           WHERE e.user_id = $1 AND a.ai_enabled AND e.status <> 'cancelled' AND e.end_at >= $2 AND e.start_at < $3
           ORDER BY e.start_at LIMIT 40`,
          [ctx.userId, from, to],
        ),
      )
    ).rows;
  }

  private async vectorSearch(ctx: DbCtx, query: string): Promise<string[]> {
    try {
      const model = await this.gateway.embedModel(ctx);
      if (!model) return [];
      const { vectors } = await this.gateway.embed(ctx, [query]);
      const rows = (
        await this.db.tx(ctx, (c) =>
          // Exact scan restricted to this user's vectors from the current model; see migration 003 for why.
          c.query(
            `WITH mine AS MATERIALIZED (
               SELECT e.message_id, e.embedding FROM message_embeddings e JOIN messages m ON m.id = e.message_id
               JOIN connected_accounts a ON a.id = m.account_id
               WHERE e.user_id = $2 AND e.model = $3 AND a.ai_enabled)
             SELECT message_id AS id FROM mine ORDER BY embedding <=> $1::vector LIMIT ${CANDIDATES}`,
            [vectorLiteral(vectors[0]), ctx.userId, model],
          ),
        )
      ).rows;
      return rows.map((r) => r.id);
    } catch (e) {
      // Search still works on keywords if embeddings are unavailable (no route, quota, provider outage).
      if (e instanceof GatewayError) this.log.warn(`Vector search skipped: ${e.code}`);
      else throw e;
      return [];
    }
  }

  private async keywordSearch(ctx: DbCtx, question: string): Promise<string[]> {
    const tsq = keywordQuery(question);
    if (!tsq) return [];
    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT m.id FROM messages m JOIN connected_accounts a ON a.id = m.account_id,
                  to_tsquery('simple', $1) q
           WHERE m.user_id = $2 AND a.ai_enabled AND m.tsv @@ q
           ORDER BY ts_rank(m.tsv, q) DESC, m."timestamp" DESC LIMIT ${CANDIDATES}`,
          [tsq, ctx.userId],
        ),
      )
    ).rows;
    return rows.map((r) => r.id);
  }
}
