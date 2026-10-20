import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConnectorRegistry } from '../connectors/registry';
import { ConnectorAccount, ProviderAuthError, TokenSet } from '../connectors/types';
import { ENV, Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { SyncService } from './sync.service';

const HOOK_PATH: Record<string, string> = {
  gmail: 'google-pubsub',
  google_calendar: 'google-calendar',
  outlook: 'graph',
  microsoft_calendar: 'graph',
  slack: 'slack',
  whatsapp: 'whatsapp',
};
const RETRY_AFTER_MS = 3_600_000;
const NO_PUSH_RECHECK_MS = 7 * 86_400_000;

/** Registers and renews provider push notifications. Polling keeps working if any of this fails. */
@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectorRegistry,
    private readonly sync: SyncService,
  ) {}

  /** Per-account secret echoed back by the provider (Graph clientState, Google channel token). */
  clientState(accountId: string): string {
    return createHmac('sha256', this.env.JWT_SECRET).update(`subscription:${accountId}`).digest('base64url');
  }

  verifyClientState(accountId: string, presented: string): boolean {
    const a = Buffer.from(this.clientState(accountId));
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async ensure(accountId: string): Promise<void> {
    const r = await this.db.system((c) => c.query('SELECT * FROM sys_account_ctx($1)', [accountId]));
    const row = r.rows[0];
    if (!row) return;
    const ctx: DbCtx = { userId: row.user_id, tenantId: row.tenant_id, role: row.role, tenantRole: row.tenant_role };
    const a = (await this.db.tx(ctx, (c) => c.query('SELECT id, channel, external_id, status, enc_tokens, backfill_days, settings FROM connected_accounts WHERE id = $1', [accountId]))).rows[0];
    const connector = a && this.registry.get(a.channel);
    if (!a || a.status !== 'active' || !a.enc_tokens || !connector) return;

    const base = this.env.PUBLIC_API_URL?.replace(/\/$/, '');
    let sub: { id: string; expiresAt: Date } | null = null;
    let retryAt = Date.now() + NO_PUSH_RECHECK_MS;
    if (base?.startsWith('https://') && connector.subscribe) {
      try {
        const tokens: TokenSet = await this.sync.freshTokens(ctx, a, connector);
        const ca: ConnectorAccount = { id: a.id, channel: a.channel, externalId: a.external_id, tokens, backfillDays: a.backfill_days, settings: a.settings };
        sub = await connector.subscribe(ca, `${base}/api/v1/webhooks/${HOOK_PATH[a.channel]}`, this.clientState(a.id));
      } catch (e) {
        if (e instanceof ProviderAuthError) return; // the next sync marks the account for reconnect
        this.log.warn(`Subscription failed for ${a.channel}: ${(e as Error).message}`);
        retryAt = Date.now() + RETRY_AFTER_MS;
      }
    }
    await this.db.tx(ctx, (c) =>
      c.query('UPDATE connected_accounts SET subscription_id = $2, subscription_expiry = $3 WHERE id = $1', [a.id, sub?.id ?? null, sub?.expiresAt ?? new Date(retryAt)]),
    );
  }
}
