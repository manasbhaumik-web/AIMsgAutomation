import { Injectable, Logger } from '@nestjs/common';
import { ConnectorRegistry } from '../connectors/registry';
import { ChannelConnector, ConnectorAccount, ProviderAuthError, SyncResetError, SyncResult, TokenSet } from '../connectors/types';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { AccountRow, IngestionService } from './ingestion.service';

interface FullAccountRow extends AccountRow {
  external_id: string;
  status: string;
  enc_tokens: Buffer | null;
  sync_cursor: string | null;
  backfill_days: number;
  settings: Record<string, unknown> | null;
}

const REFRESH_MARGIN_MS = 120_000;

/** Runs one sync pass for one account, as that account's owner (so RLS applies to every write). */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(private readonly db: Db, private readonly crypto: CryptoService, private readonly registry: ConnectorRegistry, private readonly ingestion: IngestionService) {}

  /** Returns false when there was nothing to do (missing, paused, or needs reconnect). Throws on retryable errors. */
  async syncAccount(accountId: string): Promise<boolean> {
    const ctx = await this.ctxFor(accountId);
    if (!ctx) return false;
    const acct = await this.load(ctx, accountId);
    if (!acct || acct.status !== 'active' || !acct.enc_tokens) return false;
    const connector = this.registry.get(acct.channel);
    if (!connector) return false;

    try {
      const tokens = await this.freshTokens(ctx, acct, connector);
      const ca: ConnectorAccount = { id: acct.id, channel: acct.channel as ConnectorAccount['channel'], externalId: acct.external_id, tokens, backfillDays: acct.backfill_days, settings: acct.settings ?? {} };
      if (connector.ingestPushed) return await this.drainPushed(ctx, acct, connector, ca);
      const since = new Date(Date.now() - acct.backfill_days * 86_400_000);
      let result: SyncResult;
      if (acct.sync_cursor) {
        try {
          result = await connector.incrementalSync(ca, acct.sync_cursor);
        } catch (e) {
          if (!(e instanceof SyncResetError)) throw e;
          this.log.warn(`Cursor reset for account ${acct.id}; running a fresh initial sync`);
          result = await connector.initialSync(ca, since);
        }
      } else {
        result = await connector.initialSync(ca, since);
      }
      await this.ingestion.apply(ctx, acct, result);
      return true;
    } catch (e) {
      if (e instanceof ProviderAuthError) {
        await this.db.tx(ctx, (c) => c.query(`UPDATE connected_accounts SET status = 'reauth', last_error = 'Reconnect required' WHERE id = $1`, [accountId]));
        return false; // retrying cannot help until the user reconnects
      }
      // Store a generic message only: provider errors may quote addresses or subjects.
      await this.db.tx(ctx, (c) => c.query(`UPDATE connected_accounts SET last_error = $2 WHERE id = $1`, [accountId, (e as Error).message.slice(0, 200)])).catch(() => undefined);
      throw e;
    }
  }

  /** Push-only channels: convert the stored, signature-verified webhook events. Rows are deleted only after they are ingested. */
  private async drainPushed(ctx: DbCtx, acct: FullAccountRow, connector: ChannelConnector, ca: ConnectorAccount): Promise<boolean> {
    let any = false;
    for (let batch = 0; batch < 10; batch++) {
      const rows = (await this.db.tx(ctx, (c) => c.query('SELECT id, enc_payload FROM webhook_inbox WHERE account_id = $1 ORDER BY id LIMIT 200', [acct.id]))).rows;
      const payloads: unknown[] = [];
      const ids: number[] = [];
      for (const r of rows) {
        ids.push(Number(r.id));
        try {
          payloads.push(JSON.parse(this.crypto.decrypt(r.enc_payload)));
        } catch {
          this.log.warn(`Dropped an unreadable stored webhook event for account ${acct.id}`);
        }
      }
      await this.ingestion.apply(ctx, acct, connector.ingestPushed!(ca, payloads));
      if (ids.length) await this.db.tx(ctx, (c) => c.query('DELETE FROM webhook_inbox WHERE account_id = $1 AND id = ANY($2::bigint[])', [acct.id, ids]));
      any = any || payloads.length > 0;
      if (rows.length < 200) break;
    }
    return any;
  }

  /**
   * Returns a valid access token, refreshing under a per-account advisory lock so two workers never race
   * on a rotating refresh token.
   */
  async freshTokens(ctx: DbCtx, acct: FullAccountRow, connector: ChannelConnector): Promise<TokenSet> {
    const current = JSON.parse(this.crypto.decrypt(acct.enc_tokens!)) as TokenSet;
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current;
    return this.db.tx(ctx, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tokens:${acct.id}`]);
      const row = await c.query('SELECT enc_tokens FROM connected_accounts WHERE id = $1', [acct.id]);
      const latest = JSON.parse(this.crypto.decrypt(row.rows[0].enc_tokens)) as TokenSet;
      if (latest.expiresAt - Date.now() > REFRESH_MARGIN_MS) return latest;
      const next = await connector.refreshToken(latest);
      await c.query('UPDATE connected_accounts SET enc_tokens = $2 WHERE id = $1', [acct.id, this.crypto.encrypt(JSON.stringify(next))]);
      return next;
    });
  }

  private async ctxFor(accountId: string): Promise<DbCtx | null> {
    const r = await this.db.system((c) => c.query('SELECT * FROM sys_account_ctx($1)', [accountId]));
    const row = r.rows[0];
    return row ? { userId: row.user_id, tenantId: row.tenant_id, role: row.role, tenantRole: row.tenant_role } : null;
  }

  private async load(ctx: DbCtx, id: string): Promise<FullAccountRow | undefined> {
    const r = await this.db.tx(ctx, (c) =>
      c.query<FullAccountRow>('SELECT id, tenant_id, user_id, channel, external_id, status, enc_tokens, sync_cursor, backfill_days, settings FROM connected_accounts WHERE id = $1', [id]),
    );
    return r.rows[0];
  }
}
