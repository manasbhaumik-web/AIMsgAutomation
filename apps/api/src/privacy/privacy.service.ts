import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import { ConnectorRegistry } from '../connectors/registry';
import { ConnectorAccount, TokenSet } from '../connectors/types';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';

export interface ExportLine {
  section: string;
  data: unknown;
}

const BATCH = 500;

/**
 * Sections of the personal data export. Provider tokens and password hashes are never exported, embeddings are
 * left out (derived, large, meaningless to a person), and everything is read under the caller's own RLS context.
 */
const SECTIONS: { name: string; sql: string; keyed: boolean }[] = [
  { name: 'accounts', keyed: false, sql: 'SELECT id, channel, external_id, display_name, status, scopes, backfill_days, ai_enabled, last_sync_at, created_at FROM connected_accounts ORDER BY created_at' },
  { name: 'threads', keyed: false, sql: 'SELECT id, account_id, channel, external_id, subject, last_message_at FROM threads ORDER BY last_message_at' },
  { name: 'calendar_events', keyed: false, sql: 'SELECT id, account_id, channel, title, start_at, end_at, all_day, timezone, organizer, attendees, location, meeting_link, status FROM calendar_events ORDER BY start_at' },
  { name: 'reply_drafts', keyed: false, sql: 'SELECT id, thread_id, body, source, status, created_at, sent_at FROM reply_drafts ORDER BY created_at' },
  { name: 'topics', keyed: false, sql: 'SELECT id, name::text AS name FROM topics ORDER BY name' },
  { name: 'thread_analysis', keyed: false, sql: 'SELECT thread_id, priority, status, analyzed_through FROM thread_analysis ORDER BY thread_id' },
  { name: 'action_items', keyed: false, sql: 'SELECT id, thread_id, text, due_at, status, created_at FROM action_items ORDER BY created_at' },
  { name: 'summaries', keyed: false, sql: 'SELECT scope, ref, text, model, created_at FROM summaries ORDER BY created_at' },
  { name: 'digests', keyed: false, sql: 'SELECT digest_date, text, created_at FROM digests ORDER BY digest_date' },
  { name: 'chat_turns', keyed: false, sql: 'SELECT conversation_id, role, content, created_at FROM chat_turns ORDER BY id' },
  { name: 'notifications', keyed: false, sql: 'SELECT id, kind, channel, priority, thread_id, created_at, read_at FROM notifications ORDER BY id' },
  { name: 'push_devices', keyed: false, sql: 'SELECT id, platform, label, created_at FROM push_devices ORDER BY created_at' },
  { name: 'consents', keyed: false, sql: 'SELECT purpose, granted_at, withdrawn_at FROM consents ORDER BY granted_at' },
];

@Injectable()
export class PrivacyService {
  private readonly log = new Logger(PrivacyService.name);

  constructor(
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectorRegistry,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** Streams the user's data as newline-delimited JSON, in bounded batches so memory stays flat for large mailboxes. */
  async *export(ctx: DbCtx): AsyncGenerator<ExportLine> {
    const profile = (await this.db.tx(ctx, (c) => c.query('SELECT id, email, name, locale, role, settings, created_at FROM users WHERE id = $1', [ctx.userId]))).rows[0];
    yield { section: 'profile', data: profile };
    yield { section: 'notification_prefs', data: (await this.db.tx(ctx, (c) => c.query('SELECT min_priority, show_preview, quiet_start, quiet_end, timezone FROM notification_prefs'))).rows[0] ?? null };

    for (const s of SECTIONS.slice(0, 3)) for await (const row of this.rows(ctx, s.sql)) yield { section: s.name, data: row };

    // Messages page by id so one huge mailbox never sits in memory.
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = (
        await this.db.tx(ctx, (c) =>
          c.query(
            `SELECT id, account_id, thread_id, channel, external_id, sender, recipients, subject, body_text, attachments_meta, "timestamp", direction, is_read
             FROM messages WHERE id > $1 ORDER BY id LIMIT ${BATCH}`,
            [after],
          ),
        )
      ).rows;
      for (const m of page) yield { section: 'messages', data: m };
      if (page.length < BATCH) break;
      after = page[page.length - 1].id;
    }

    for (const s of SECTIONS.slice(3)) for await (const row of this.rows(ctx, s.sql)) yield { section: s.name, data: row };
    for (const a of (await this.db.tx(ctx, (c) => c.query('SELECT * FROM sys_user_audit($1)', [ctx.userId]))).rows) yield { section: 'audit_log', data: a };
    await this.audit.log(ctx, 'data.export');
  }

  private async *rows(ctx: DbCtx, sql: string): AsyncGenerator<unknown> {
    // These tables are small relative to messages; one query each is fine.
    for (const r of (await this.db.tx(ctx, (c) => c.query(sql))).rows) yield r;
  }

  /**
   * Deletes the account and everything it owns. One database function removes the data, then provider access is revoked where the provider
   * supports it (best effort; tokens are read before deletion). The caller must retype their email, and password users must
   * also give their password.
   */
  async deleteAccount(ctx: DbCtx, confirmEmail: string, password?: string): Promise<void> {
    const user = (await this.db.tx(ctx, (c) => c.query('SELECT email FROM users WHERE id = $1', [ctx.userId]))).rows[0];
    if (!user || user.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) throw new BadRequestException('The email you typed does not match this account');
    const cred = await this.auth.passwordCheck(ctx.userId!, password);
    if (cred === 'wrong') throw new ForbiddenException('Wrong password');
    if (cred === 'missing') throw new BadRequestException('Enter your password to delete the account');

    // Read the tokens first, delete second, revoke last: a refused deletion (last administrator) must not leave the
    // user with revoked connections, and nothing can be read after the rows are gone.
    const accounts = (await this.db.tx(ctx, (c) => c.query('SELECT id, channel, external_id, enc_tokens, settings FROM connected_accounts WHERE enc_tokens IS NOT NULL'))).rows;
    const toRevoke: { connector: NonNullable<ReturnType<ConnectorRegistry['get']>>; account: ConnectorAccount }[] = [];
    for (const a of accounts) {
      const connector = this.registry.get(a.channel);
      if (!connector) continue;
      try {
        const tokens = JSON.parse(this.crypto.decrypt(a.enc_tokens)) as TokenSet;
        toRevoke.push({ connector, account: { id: a.id, channel: a.channel, externalId: a.external_id, tokens, backfillDays: 0, settings: a.settings ?? {} } });
      } catch {
        this.log.warn(`Could not read ${a.channel} credentials for revocation during account deletion`);
      }
    }
    try {
      await this.db.tx(ctx, (c) => c.query('SELECT sys_delete_user($1)', [ctx.userId]));
    } catch (e) {
      const m = (e as Error).message;
      if (m.includes('last_admin')) throw new ConflictException({ code: 'last_admin', message: 'You are the only platform administrator. Make someone else an administrator first.' });
      if (m.includes('last_tenant_admin')) throw new ConflictException({ code: 'last_tenant_admin', message: 'You are the only administrator of a shared workspace. Make someone else an administrator first.' });
      throw e;
    }
    for (const r of toRevoke) {
      await r.connector.revoke(r.account).catch(() => this.log.warn(`Could not revoke ${r.account.channel} access; the user can remove the app in the provider's settings`));
    }
  }

  /** Hourly retention sweep. Returns counts per kind for metrics and logs. */
  async purge(p: { sessionsDays: number; notificationsDays: number; webhookDays: number; draftsDays: number; auditDays: number; usageDays: number }): Promise<Record<string, number>> {
    const r = await this.db.system((c) =>
      c.query('SELECT * FROM sys_purge_expired($1,$2,$3,$4,$5,$6)', [p.sessionsDays, p.notificationsDays, p.webhookDays, p.draftsDays, p.auditDays, p.usageDays]),
    );
    return Object.fromEntries(r.rows.map((x: { what: string; n: string | number }) => [x.what, Number(x.n)]));
  }
}

