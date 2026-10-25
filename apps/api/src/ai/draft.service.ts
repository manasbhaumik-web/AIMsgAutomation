import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { Db, DbCtx } from '../db/db.service';
import { LlmGateway } from '../llm/gateway.service';
import { ConsentService } from './consent.service';
import { ProfileService } from '../profile/profile.service';
import { neutralize, truncate } from './helpers';

export const MAX_DRAFT_CHARS = 4000;
export const hashBody = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

const STYLE: Record<string, string> = {
  gmail: 'an email (plain text; no subject line)',
  outlook: 'an email (plain text; no subject line)',
  slack: 'a Slack message (short, conversational, no markdown headings)',
  teams: 'a Microsoft Teams chat message (short, conversational)',
  whatsapp: 'a WhatsApp message to a customer (short, plain text, no markdown)',
};

/** Removes wrappers models like to add. The user still reviews every word before anything is sent. */
export function cleanDraft(raw: string): string {
  let t = raw.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(here(?:'s| is) (?:a |the )?(?:draft|reply)[^:\n]*:|reply:|draft:)\s*/i, '').trim();
  if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t.slice(0, MAX_DRAFT_CHARS);
}

/** Creates or replaces the single open draft of a thread. Refuses while that draft is mid-send. */
export async function upsertOpenDraft(
  c: PoolClient,
  d: { tenantId: string; userId: string; threadId: string; accountId: string; body: string; baseMessageId: string | null; source: 'ai' | 'user'; instructions?: string | null; model?: string | null; promptVersion?: number | null },
): Promise<Record<string, unknown>> {
  const open = (await c.query(`SELECT id, status FROM reply_drafts WHERE thread_id = $1 AND status IN ('draft','sending','failed') FOR UPDATE`, [d.threadId])).rows[0];
  if (open?.status === 'sending') throw new ConflictException({ code: 'send_in_progress', message: 'This reply is being sent right now.' });
  if (open) {
    return (
      await c.query(
        `UPDATE reply_drafts SET body = $2, body_hash = $8, base_message_id = $3, source = $4, instructions = $5, model = $6, prompt_version = $7, status = 'draft', error = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [open.id, d.body, d.baseMessageId, d.source, d.instructions ?? null, d.model ?? null, d.promptVersion ?? null, hashBody(d.body)],
      )
    ).rows[0];
  }
  return (
    await c.query(
      `INSERT INTO reply_drafts(tenant_id, user_id, thread_id, account_id, body, body_hash, base_message_id, source, instructions, model, prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [d.tenantId, d.userId, d.threadId, d.accountId, d.body, hashBody(d.body), d.baseMessageId, d.source, d.instructions ?? null, d.model ?? null, d.promptVersion ?? null],
    )
  ).rows[0];
}

/**
 * Writes reply text with the LLM and stores it as a draft. This class has no way to send: it depends on the
 * database, the gateway and consent only. Sending lives in replies/replies.service.ts behind an explicit confirmation.
 */
@Injectable()
export class DraftService {
  constructor(private readonly db: Db, private readonly gateway: LlmGateway, private readonly consent: ConsentService, private readonly profile: ProfileService) {}

  async draftReply(ctx: DbCtx, threadId: string, instructions?: string): Promise<Record<string, unknown>> {
    await this.consent.require(ctx);
    const t = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT t.id, t.channel, t.account_id, a.status FROM threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND a.ai_enabled`,
          [threadId],
        ),
      )
    ).rows[0];
    if (!t) throw new NotFoundException('Conversation not found, or AI is switched off for its account');
    if (t.status !== 'active') throw new ConflictException('Reconnect this account before replying');
    if (!STYLE[t.channel]) throw new UnprocessableEntityException('Replies are not supported on this channel');

    const rows = (
      await this.db.tx(ctx, (c) =>
        c.query(`SELECT id, sender, subject, body_text, "timestamp", direction FROM messages WHERE thread_id = $1 ORDER BY "timestamp" DESC LIMIT 12`, [threadId]),
      )
    ).rows.reverse();
    if (!rows.length || !rows.some((m) => m.direction === 'inbound')) throw new UnprocessableEntityException('There is nothing to reply to yet');
    const thread = rows
      .map((m) => `[${new Date(m.timestamp).toISOString().slice(0, 16)}] ${m.direction === 'outbound' ? 'You' : (m.sender?.name ?? m.sender?.email ?? m.sender?.handle ?? 'Unknown')}\n${truncate(m.body_text, 1500)}`)
      .join('\n\n');

    // The person's saved tone, language and signature come first; their guidance for this reply follows.
    const hints = await this.profile.promptHints(ctx);
    const guidance = [hints, neutralize(truncate(instructions ?? '', 500))].filter(Boolean).join(' ');
    const res = await this.gateway.run(ctx, 'draft-reply', {
      today: new Date().toISOString().slice(0, 10),
      style: STYLE[t.channel],
      thread: neutralize(thread),
      instructions: guidance || '(none)',
    });
    const body = cleanDraft(res.text);
    if (!body) throw new UnprocessableEntityException('The assistant did not produce a usable draft. Try again or write one yourself.');

    return this.db.tx(ctx, (c) =>
      upsertOpenDraft(c, {
        tenantId: ctx.tenantId!, userId: ctx.userId!, threadId, accountId: t.account_id, body,
        baseMessageId: rows[rows.length - 1].id, source: 'ai', instructions: instructions ? truncate(instructions, 500) : null, model: res.model, promptVersion: res.promptVersion,
      }),
    );
  }
}
