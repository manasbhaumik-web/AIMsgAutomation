import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { TokenService, AuthUser } from '../auth/token.service';
import { dbCtx } from '../auth/guards';
import { AuditService } from '../common/audit.service';
import { ENV, Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Db } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { ConnectorRegistry } from './registry';
import { hasScope } from './send';
import { ConnectorAccount, TokenSet } from './types';

const LIST_SQL = `
  SELECT a.id, a.channel, a.external_id, a.display_name, a.status, a.last_sync_at, a.last_error, a.ai_enabled, a.backfill_days,
         a.created_at, a.scopes, coalesce(count(m.id) FILTER (WHERE NOT m.is_read AND m.direction = 'inbound'), 0)::int AS unread
  FROM connected_accounts a LEFT JOIN messages m ON m.account_id = a.id
  GROUP BY a.id ORDER BY a.channel, a.external_id`;

export interface AccountPatch {
  paused?: boolean;
  backfillDays?: number;
  aiEnabled?: boolean;
}

@Injectable()
export class AccountsService {
  private readonly allowedRedirects: string[];

  constructor(
    @Inject(ENV) env: Env,
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly registry: ConnectorRegistry,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {
    this.allowedRedirects = [`${env.WEB_URL.replace(/\/$/, '')}/connect/callback`, ...env.CONNECT_REDIRECT_URIS.split(',').map((s) => s.trim()).filter(Boolean)];
  }

  channels() {
    return this.registry.available();
  }

  /** Each account reports what it may do right now: sending needs the write scope granted at connect time. */
  async list(u: AuthUser) {
    const rows = (await this.db.tx(dbCtx(u), (c) => c.query(LIST_SQL))).rows;
    return rows.map(({ scopes, ...a }) => {
      const connector = this.registry.get(a.channel);
      const granted = hasScope(scopes, connector?.writeScope);
      return { ...a, can_send: granted && !!connector?.sendReply, can_respond: granted && !!connector?.respondToEvent };
    });
  }

  /** Step 1: returns the provider consent URL. PKCE verifier and user binding travel in the signed state. */
  async startConnect(u: AuthUser, channel: string, redirectUri: string, write = false): Promise<string> {
    const connector = this.registry.get(channel);
    if (!connector) throw new BadRequestException(`${channel} is not available on this server`);
    if (!this.allowedRedirects.includes(redirectUri)) throw new BadRequestException('redirectUri is not allowed');
    const verifier = randomBytes(32).toString('base64url');
    const state = await this.tokens.signBlob('connect', { u: u.id, c: channel, v: verifier, r: redirectUri, w: write ? '1' : '0' });
    return connector.getAuthUrl({ state, challenge: createHash('sha256').update(verifier).digest('base64url'), redirectUri, write: write && !!connector.writeScope });
  }

  /** Step 2: the client posts the code and state it received on its redirect. */
  async completeConnect(u: AuthUser, code: string, state: string) {
    const s = await this.tokens.verifyBlob('connect', state);
    if (s.u !== u.id) throw new BadRequestException('This connection was started by a different user');
    const connector = this.registry.get(s.c);
    if (!connector) throw new BadRequestException('Channel unavailable');
    const r = await connector.handleAuthCallback({ code, verifier: s.v, redirectUri: s.r });
    const ctx = dbCtx(u);

    const existing = await this.db.tx(ctx, (c) => c.query('SELECT enc_tokens FROM connected_accounts WHERE user_id = $1 AND channel = $2 AND external_id = $3', [u.id, s.c, r.externalId]));
    let tokens: TokenSet = r.tokens;
    if (!tokens.refreshToken && !connector.longLivedTokens) {
      const prev = existing.rows[0]?.enc_tokens ? (JSON.parse(this.crypto.decrypt(existing.rows[0].enc_tokens)) as TokenSet) : null;
      if (!prev?.refreshToken) throw new BadRequestException('The provider did not grant offline access. Remove the app from your account permissions and connect again.');
      tokens = { ...tokens, refreshToken: prev.refreshToken };
    }
    const row = await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO connected_accounts(tenant_id, user_id, channel, external_id, display_name, status, enc_tokens, scopes, settings)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
         ON CONFLICT (user_id, channel, external_id) DO UPDATE
           SET status = 'active', enc_tokens = EXCLUDED.enc_tokens, scopes = EXCLUDED.scopes, display_name = EXCLUDED.display_name, settings = EXCLUDED.settings, last_error = NULL
         RETURNING id, channel, external_id, display_name, status`,
        [u.tenantId, u.id, s.c, r.externalId, r.displayName, this.crypto.encrypt(JSON.stringify(tokens)), r.scopes, JSON.stringify(r.settings ?? {})],
      ),
    );
    await this.audit.log(ctx, 'account.connect', row.rows[0].id, { channel: s.c });
    await this.jobs.enqueueSync(row.rows[0].id);
    await this.jobs.enqueueRenew(row.rows[0].id);
    return row.rows[0];
  }

  async update(u: AuthUser, id: string, p: AccountPatch) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `UPDATE connected_accounts SET
           status = CASE WHEN $2::boolean IS NULL THEN status WHEN $2 THEN 'paused' WHEN status = 'paused' THEN 'active' ELSE status END,
           backfill_days = coalesce($3, backfill_days), ai_enabled = coalesce($4, ai_enabled)
         WHERE id = $1 AND status <> 'revoked' RETURNING id, status, backfill_days, ai_enabled`,
        [id, p.paused ?? null, p.backfillDays ?? null, p.aiEnabled ?? null],
      ),
    );
    if (!r.rowCount) throw new NotFoundException();
    if (r.rows[0].status === 'active' && p.paused === false) await this.jobs.enqueueSync(id);
    return r.rows[0];
  }

  /** Disconnect: always revoke at the provider when possible; optionally delete synced data. */
  async disconnect(u: AuthUser, id: string, deleteData: boolean): Promise<void> {
    const ctx = dbCtx(u);
    const row = (await this.db.tx(ctx, (c) => c.query('SELECT id, channel, external_id, enc_tokens, settings FROM connected_accounts WHERE id = $1', [id]))).rows[0];
    if (!row) throw new NotFoundException();
    const connector = this.registry.get(row.channel);
    if (connector && row.enc_tokens) {
      const tokens = JSON.parse(this.crypto.decrypt(row.enc_tokens)) as TokenSet;
      const ca: ConnectorAccount = { id, channel: row.channel, externalId: row.external_id, tokens, backfillDays: 0, settings: row.settings };
      await connector.revoke(ca).catch(() => undefined); // best effort: local deletion below always happens
    }
    await this.db.tx(ctx, async (c) => {
      if (!deleteData) {
        await c.query(`UPDATE connected_accounts SET status = 'revoked', enc_tokens = NULL, sync_cursor = NULL, subscription_id = NULL WHERE id = $1`, [id]);
        return;
      }
      // Summaries are derived from the account's content and are keyed by text refs, so the cascade would miss them.
      // Past digests and chat answers may still quote it; "Erase AI data" in settings removes those.
      await c.query(`DELETE FROM summaries WHERE user_id = $1 AND ((scope = 'thread' AND ref IN (SELECT id::text FROM threads WHERE account_id = $2)) OR scope IN ('channel','topic'))`, [ctx.userId, id]);
      await c.query('DELETE FROM connected_accounts WHERE id = $1', [id]);
    });
    await this.audit.log(ctx, 'account.disconnect', id, { channel: row.channel, deleteData });
  }

  async requireOwned(u: AuthUser, id: string): Promise<void> {
    const r = await this.db.tx(dbCtx(u), (c) => c.query('SELECT 1 FROM connected_accounts WHERE id = $1', [id]));
    if (!r.rowCount) throw new ConflictException('Unknown account');
  }
}
