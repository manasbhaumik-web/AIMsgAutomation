import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { MAX_DRAFT_CHARS, upsertOpenDraft } from '../ai/draft.service';
import { AuditService } from '../common/audit.service';
import { ConnectorRegistry } from '../connectors/registry';
import { hasScope, isEmail } from '../connectors/send';
import { ConnectorAccount, Party, ProviderAuthError, ProviderError, SendRequest } from '../connectors/types';
import { Db, DbCtx } from '../db/db.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { SyncService } from '../ingestion/sync.service';
import { MetricsService } from '../observability/metrics.service';

const WHATSAPP_WINDOW_MS = 24 * 3_600_000;

export interface DraftView {
  id: string;
  threadId: string;
  accountId: string;
  channel: string;
  body: string;
  bodyHash: string;
  source: string;
  status: string;
  error: string | null;
  /** A message arrived (or was sent) after this draft was written. */
  stale: boolean;
  canSend: boolean;
  /** Why sending is not possible right now, in words for the user. */
  blockedReason: string | null;
  /** Exactly who receives the reply, as derived from the conversation (never supplied by the client). */
  to: Party[];
  subject: string | null;
  accountLabel: string;
  updatedAt: Date;
}

interface Target {
  threadId: string;
  channel: string;
  subject: string | null;
  account: { id: string; external_id: string; display_name: string | null; status: string; scopes: string[] };
  latestId: string | null;
  replyTo: { id: string; external_id: string; sender: Party | null; timestamp: Date; recipients: { to?: Party[] } } | null;
}

/**
 * The only code that sends. A reply goes out only when the user presents the hash of the exact text they were shown
 * (`confirm`); AI code cannot reach this class. There is no queue and no automatic retry, because a retry could
 * deliver the same message twice.
 */
@Injectable()
export class RepliesService {
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly sync: SyncService,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async get(ctx: DbCtx, threadId: string): Promise<DraftView | null> {
    const d = (await this.db.tx(ctx, (c) => c.query(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status IN ('draft','sending','failed')`, [threadId]))).rows[0];
    return d ? this.view(ctx, d) : null;
  }

  async save(ctx: DbCtx, threadId: string, body: string): Promise<DraftView> {
    const text = body.replace(/\r\n/g, '\n').trim();
    if (!text) throw new BadRequestException('The reply is empty');
    if (text.length > MAX_DRAFT_CHARS) throw new BadRequestException(`The reply is longer than ${MAX_DRAFT_CHARS} characters`);
    const t = await this.target(ctx, threadId);
    const row = await this.db.tx(ctx, (c) =>
      upsertOpenDraft(c, { tenantId: ctx.tenantId!, userId: ctx.userId!, threadId, accountId: t.account.id, body: text, baseMessageId: t.latestId, source: 'user' }),
    );
    return this.view(ctx, row);
  }

  async discard(ctx: DbCtx, threadId: string): Promise<void> {
    const r = await this.db.tx(ctx, (c) => c.query(`UPDATE reply_drafts SET status = 'discarded', updated_at = now() WHERE thread_id = $1 AND status IN ('draft','failed')`, [threadId]));
    if (!r.rowCount) throw new NotFoundException('No draft to discard');
  }

  /** What the confirmation screen shows. */
  async preview(ctx: DbCtx, draftId: string): Promise<DraftView> {
    const d = (await this.db.tx(ctx, (c) => c.query('SELECT * FROM reply_drafts WHERE id = $1', [draftId]))).rows[0];
    if (!d) throw new NotFoundException();
    return this.view(ctx, d);
  }

  /**
   * Sends one confirmed draft. `bodyHash` must be the hash the client displayed; if the draft changed since, nothing is sent.
   */
  async send(ctx: DbCtx, draftId: string, c: { bodyHash: string; acceptNewMessages: boolean }): Promise<DraftView> {
    const d = (await this.db.tx(ctx, (q) => q.query('SELECT * FROM reply_drafts WHERE id = $1', [draftId]))).rows[0];
    if (!d) throw new NotFoundException();
    if (!['draft', 'failed'].includes(d.status)) throw new ConflictException({ code: 'not_sendable', message: d.status === 'sent' ? 'This reply was already sent.' : 'This draft cannot be sent.' });
    if (d.body_hash !== c.bodyHash) throw new ConflictException({ code: 'draft_changed', message: 'The reply changed after you reviewed it. Review it again.' });

    const t = await this.target(ctx, d.thread_id);
    const view = await this.view(ctx, d, t);
    if (!view.canSend) throw new ConflictException({ code: 'send_blocked', message: view.blockedReason });
    if (view.stale && !c.acceptNewMessages) throw new ConflictException({ code: 'thread_changed', message: 'A newer message arrived in this conversation. Read it, then confirm again.' });

    const connector = this.registry.get(t.channel)!; // canSend guarantees it exists and can send
    const acctRow = (await this.db.tx(ctx, (q) => q.query('SELECT id, tenant_id, user_id, channel, external_id, status, enc_tokens, sync_cursor, backfill_days, settings FROM connected_accounts WHERE id = $1', [t.account.id]))).rows[0];

    // Claim the draft atomically: a double click or a second device cannot send it twice.
    const claimed = await this.db.tx(ctx, (q) =>
      q.query(`UPDATE reply_drafts SET status = 'sending', error = NULL, updated_at = now() WHERE id = $1 AND status IN ('draft','failed') AND body_hash = $2 RETURNING id`, [draftId, c.bodyHash]),
    );
    if (!claimed.rowCount) throw new ConflictException({ code: 'send_in_progress', message: 'This reply is being sent or has changed.' });

    const req: SendRequest = { threadExternalId: t.threadExternal, replyToExternalId: t.replyTo!.external_id, to: view.to, subject: t.subject, text: d.body };
    try {
      const tokens = await this.sync.freshTokens(ctx, acctRow, connector);
      const ca: ConnectorAccount = { id: acctRow.id, channel: acctRow.channel, externalId: acctRow.external_id, tokens, backfillDays: acctRow.backfill_days, settings: acctRow.settings ?? {} };
      const sent = await connector.sendReply!(ca, req);
      await this.db.tx(ctx, (q) => q.query(`UPDATE reply_drafts SET status = 'sent', sent_external_id = $2, sent_at = now(), error = NULL, updated_at = now() WHERE id = $1`, [draftId, sent.externalId]));
      if (sent.message && acctRow.sync_cursor) {
        await this.ingestion.apply(ctx, acctRow, { messages: [sent.message], events: [], deletedExternalIds: [], cursor: acctRow.sync_cursor }).catch(() => undefined); // the provider copy arrives on the next sync anyway
      }
      this.metrics?.sends.inc({ channel: acctRow.channel, result: 'sent' });
      await this.audit.log(ctx, 'reply.send', draftId, { channel: acctRow.channel, threadId: d.thread_id, aiDrafted: d.source === 'ai', chars: d.body.length });
    } catch (e) {
      const msg = e instanceof ProviderAuthError ? 'Reconnect this account, then try again.' : e instanceof ProviderError ? `The provider refused the message (${e.status}).` : 'The connection failed. The message may or may not have been sent: check the conversation before trying again.';
      await this.db.tx(ctx, (q) => q.query(`UPDATE reply_drafts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [draftId, msg]));
      if (e instanceof ProviderAuthError) await this.db.tx(ctx, (q) => q.query(`UPDATE connected_accounts SET status = 'reauth', last_error = 'Reconnect required' WHERE id = $1`, [t.account.id]));
      this.metrics?.sends.inc({ channel: acctRow.channel, result: 'failed' });
      await this.audit.log(ctx, 'reply.send_failed', draftId, { channel: acctRow.channel });
      throw new ConflictException({ code: 'send_failed', message: msg });
    }
    return this.preview(ctx, draftId);
  }

  private async target(ctx: DbCtx, threadId: string): Promise<Target & { threadExternal: string }> {
    const th = (
      await this.db.tx(ctx, (q) =>
        q.query(
          `SELECT t.id, t.channel, t.subject, t.external_id AS thread_external, a.id AS account_id, a.external_id, a.display_name, a.status, a.scopes
           FROM threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1`,
          [threadId],
        ),
      )
    ).rows[0];
    if (!th) throw new NotFoundException('Conversation not found');
    const latest = (await this.db.tx(ctx, (q) => q.query(`SELECT id FROM messages WHERE thread_id = $1 ORDER BY "timestamp" DESC LIMIT 1`, [threadId]))).rows[0];
    const inbound = (
      await this.db.tx(ctx, (q) =>
        q.query(`SELECT id, external_id, sender, recipients, "timestamp" FROM messages WHERE thread_id = $1 AND direction = 'inbound' ORDER BY "timestamp" DESC LIMIT 1`, [threadId]),
      )
    ).rows[0];
    return {
      threadId,
      channel: th.channel,
      subject: th.subject,
      threadExternal: th.thread_external,
      account: { id: th.account_id, external_id: th.external_id, display_name: th.display_name, status: th.status, scopes: th.scopes },
      latestId: latest?.id ?? null,
      replyTo: inbound ? { id: inbound.id, external_id: inbound.external_id, sender: inbound.sender, timestamp: inbound.timestamp, recipients: inbound.recipients } : null,
    };
  }

  private async view(ctx: DbCtx, d: Record<string, any>, known?: Target & { threadExternal: string }): Promise<DraftView> {
    const t = known ?? (await this.target(ctx, d.thread_id));
    const connector = this.registry.get(t.channel);
    let blocked: string | null = null;
    const to: Party[] = t.replyTo?.sender ? [t.replyTo.sender] : [];
    if (!connector?.sendReply) blocked = 'Replies are not supported on this channel.';
    else if (!hasScope(t.account.scopes, connector.writeScope)) blocked = 'Sending is not enabled for this account. Reconnect it with "Allow replies" turned on.';
    else if (t.account.status !== 'active') blocked = 'Reconnect this account before sending.';
    else if (!t.replyTo) blocked = 'There is no incoming message to reply to.';
    else if (['gmail', 'outlook'].includes(t.channel) && !isEmail(t.replyTo.sender?.email)) blocked = 'The sender has no usable email address.';
    else if (t.channel === 'whatsapp' && Date.now() - new Date(t.replyTo.timestamp).getTime() > WHATSAPP_WINDOW_MS) {
      blocked = 'WhatsApp only allows free-form replies within 24 hours of the customer’s last message.';
    }
    if (d.status === 'sent') blocked = 'Already sent.';
    return {
      id: d.id, threadId: d.thread_id, accountId: d.account_id, channel: t.channel, body: d.body, bodyHash: d.body_hash, source: d.source, status: d.status, error: d.error,
      stale: !!t.latestId && t.latestId !== d.base_message_id, canSend: blocked === null, blockedReason: blocked, to,
      subject: t.subject, accountLabel: t.account.display_name ?? t.account.external_id, updatedAt: d.updated_at,
    };
  }
}
