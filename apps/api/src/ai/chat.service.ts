import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { GatewayError } from '../llm/types';
import { ConsentService } from './consent.service';
import { extractCitations, localDate, neutralize, truncate } from './helpers';
import { EventHit, MessageHit, RetrievalService } from './retrieval.service';

export interface Citation {
  marker: string;
  kind: 'message' | 'event';
  id: string;
  threadId?: string;
  title: string;
  who?: string;
  at: Date;
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; turnId: number }
  | { type: 'error'; code: string; message: string };

const HISTORY_TURNS = 6;
const MAX_QUESTION = 2000;

const who = (s: { name?: string; email?: string; handle?: string } | null) => (s ? (s.name && (s.email || s.handle) ? `${s.name} <${s.email ?? s.handle}>` : s.name ?? s.email ?? s.handle ?? 'unknown') : 'unknown');

/** Builds the numbered source list the model must cite. Pure so it can be tested without a database. */
export function buildContext(messages: MessageHit[], events: EventHit[], tz = 'UTC'): { text: string; sources: Map<string, Citation> } {
  const sources = new Map<string, Citation>();
  const lines: string[] = [];
  messages.forEach((m, i) => {
    const marker = `M${i + 1}`;
    sources.set(marker, { marker, kind: 'message', id: m.id, threadId: m.thread_id, title: m.subject || '(no subject)', who: who(m.sender), at: m.timestamp });
    lines.push(`[${marker}] ${m.channel} · ${new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${m.direction === 'outbound' ? 'sent by you' : `from ${who(m.sender)}`} · subject: ${m.subject ?? '(none)'}\n${truncate(m.body_text, 1200)}`);
  });
  events.forEach((e, i) => {
    const marker = `E${i + 1}`;
    sources.set(marker, { marker, kind: 'event', id: e.id, title: e.title, at: e.start_at });
    const when = e.all_day
      ? `${localDate(tz, new Date(e.start_at))} all day`
      : `${new Date(e.start_at).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })} to ${new Date(e.end_at).toLocaleTimeString('en-GB', { timeZone: tz, timeStyle: 'short' })}`;
    lines.push(`[${marker}] calendar · ${when} (${tz}) · ${e.title}${e.location ? ` · at ${e.location}` : ''}`);
  });
  return { text: neutralize(lines.join('\n\n')) || '(no sources found)', sources };
}

@Injectable()
export class ChatService {
  constructor(private readonly db: Db, private readonly gateway: LlmGateway, private readonly retrieval: RetrievalService, private readonly consent: ConsentService) {}

  async create(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query('INSERT INTO conversations(tenant_id, user_id) VALUES ($1,$2) RETURNING id, title, created_at', [ctx.tenantId, ctx.userId]))).rows[0];
  }

  async list(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50'))).rows;
  }

  async get(ctx: DbCtx, id: string) {
    return this.db.tx(ctx, async (c) => {
      const conv = (await c.query('SELECT id, title, created_at FROM conversations WHERE id = $1', [id])).rows[0];
      if (!conv) throw new NotFoundException();
      const turns = (await c.query('SELECT id, role, content, citations, created_at FROM chat_turns WHERE conversation_id = $1 ORDER BY id', [id])).rows;
      return { ...conv, turns };
    });
  }

  async remove(ctx: DbCtx, id: string): Promise<void> {
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM conversations WHERE id = $1', [id]));
    if (!r.rowCount) throw new NotFoundException();
  }

  /**
   * Answers a question from the user's own mail and calendar. Yields token events, then the citations that the
   * answer actually used, then done. The assistant has no tools: it cannot send, delete or change anything.
   */
  async *ask(ctx: DbCtx, conversationId: string, question: string, tz = 'UTC'): AsyncGenerator<ChatEvent> {
    await this.consent.require(ctx);
    const q = question.trim().slice(0, MAX_QUESTION);
    const conv = (await this.db.tx(ctx, (c) => c.query('SELECT id, title FROM conversations WHERE id = $1', [conversationId]))).rows[0];
    if (!conv) throw new NotFoundException();

    const history = (
      await this.db.tx(ctx, (c) => c.query('SELECT role, content FROM chat_turns WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2', [conversationId, HISTORY_TURNS]))
    ).rows.reverse();

    const [messages, events] = await Promise.all([this.retrieval.searchMessages(ctx, q), this.retrieval.upcomingEvents(ctx)]);
    const { text: context, sources } = buildContext(messages, events, tz);

    await this.db.tx(ctx, async (c) => {
      await c.query('INSERT INTO chat_turns(conversation_id, tenant_id, user_id, role, content) VALUES ($1,$2,$3,$4,$5)', [conversationId, ctx.tenantId, ctx.userId, 'user', q]);
      await c.query('UPDATE conversations SET updated_at = now(), title = coalesce(title, $2) WHERE id = $1', [conversationId, truncate(q, 60)]);
    });

    let answer = '';
    try {
      const stream = this.gateway.stream(ctx, 'chat', {
        context,
        history: neutralize(history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${truncate(h.content, 1500)}`).join('\n') || '(first question)'),
        question: q,
        today: new Date().toISOString().slice(0, 10),
        timezone: tz,
      });
      for await (const ev of stream) {
        if (ev.type === 'text') {
          answer += ev.text;
          yield { type: 'token', text: ev.text };
        }
      }
    } catch (e) {
      if (e instanceof GatewayError) {
        yield { type: 'error', code: e.code, message: friendly(e) };
        return;
      }
      throw e;
    }

    // Only markers that exist in the provided sources become citations; invented ones are dropped.
    const used = extractCitations(answer, new Set(sources.keys())).map((m) => sources.get(m)!);
    const saved = await this.db.tx(ctx, (c) =>
      c.query('INSERT INTO chat_turns(conversation_id, tenant_id, user_id, role, content, citations) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [conversationId, ctx.tenantId, ctx.userId, 'assistant', answer, JSON.stringify(used)]),
    );
    yield { type: 'citations', citations: used };
    yield { type: 'done', turnId: Number(saved.rows[0].id) };
  }
}

function friendly(e: GatewayError): string {
  switch (e.code) {
    case 'route_not_configured':
    case 'prompt_not_configured': return 'The assistant is not set up yet. Ask your administrator to configure an AI provider.';
    case 'quota_exceeded': return 'You have reached the daily AI usage limit. Try again tomorrow.';
    case 'upstream_failed': return 'The AI provider did not respond. Please try again.';
    default: return 'The assistant could not answer right now.';
  }
}
