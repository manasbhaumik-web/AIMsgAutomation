import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { Db, DbCtx } from '../db/db.service';

export const AI_PURPOSE = 'ai_processing';

/** Thrown to the client as 403 with a stable code so the UI can show the consent prompt. */
export class AiConsentRequired extends ForbiddenException {
  constructor() {
    super({ code: 'ai_consent_required', message: 'Turn on AI features to use this. Your messages are sent to the configured AI provider only after you agree.' });
  }
}

@Injectable()
export class ConsentService {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  async has(ctx: DbCtx): Promise<boolean> {
    const r = await this.db.tx(ctx, (c) => c.query('SELECT 1 FROM consents WHERE user_id = $1 AND purpose = $2 AND withdrawn_at IS NULL', [ctx.userId, AI_PURPOSE]));
    return r.rowCount! > 0;
  }

  async require(ctx: DbCtx): Promise<void> {
    if (!(await this.has(ctx))) throw new AiConsentRequired();
  }

  async grant(ctx: DbCtx): Promise<void> {
    if (await this.has(ctx)) return;
    await this.db.tx(ctx, (c) => c.query('INSERT INTO consents(user_id, purpose) VALUES ($1, $2)', [ctx.userId, AI_PURPOSE]));
    await this.audit.log(ctx, 'consent.grant', AI_PURPOSE);
  }

  /** Stops all AI processing for the user. Derived data (vectors, tags, summaries, chats) is erased unless the caller keeps it. */
  async withdraw(ctx: DbCtx, eraseDerived: boolean): Promise<void> {
    await this.db.tx(ctx, (c) => c.query('UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND purpose = $2 AND withdrawn_at IS NULL', [ctx.userId, AI_PURPOSE]));
    await this.audit.log(ctx, 'consent.withdraw', AI_PURPOSE, { eraseDerived });
    if (eraseDerived) await this.eraseDerived(ctx);
  }

  /** Deletes everything the AI layer produced for this user. Source messages and accounts are untouched. */
  async eraseDerived(ctx: DbCtx): Promise<void> {
    await this.db.tx(ctx, async (c) => {
      // Unsent assistant-written drafts are derived data; drafts the user wrote or already sent are not.
      await c.query(`DELETE FROM reply_drafts WHERE user_id = $1 AND source = 'ai' AND status IN ('draft','failed')`, [ctx.userId]);
      for (const t of ['message_embeddings', 'thread_topics', 'thread_analysis', 'action_items', 'summaries', 'digests', 'topics', 'conversations']) {
        await c.query(`DELETE FROM ${t} WHERE user_id = $1`, [ctx.userId]); // table names are constants above
      }
    });
    await this.audit.log(ctx, 'ai_data.erase');
  }
}
