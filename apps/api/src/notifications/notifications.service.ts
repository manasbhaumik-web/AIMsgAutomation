import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { localHour } from '../ai/helpers';
import { CryptoService } from '../crypto/crypto.service';
import { Db, DbCtx } from '../db/db.service';
import { PushProvider } from './fcm';

export const PUSH = Symbol('PUSH_PROVIDER');
export const MIN_PRIORITIES = ['off', 'urgent', 'needs_reply', 'all'] as const;
export type MinPriority = (typeof MIN_PRIORITIES)[number];

const MAX_PUSHES_PER_SCAN = 5;
const LOOKBACK = "interval '1 day'";
const CHANNEL_NAME: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook', slack: 'Slack', teams: 'Teams', whatsapp: 'WhatsApp' };

export interface Prefs {
  minPriority: MinPriority;
  showPreview: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  timezone: string;
}
const DEFAULTS: Prefs = { minPriority: 'needs_reply', showPreview: false, quietStart: null, quietEnd: null, timezone: 'UTC' };

/** True when `hour` falls in [start, end), where the window may wrap past midnight. */
export const inQuietHours = (hour: number, start: number | null, end: number | null): boolean => {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private readonly db: Db, private readonly crypto: CryptoService, @Inject(PUSH) private readonly push: PushProvider | null) {}

  get pushConfigured(): boolean {
    return this.push !== null;
  }

  async prefs(ctx: DbCtx): Promise<Prefs> {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT min_priority, show_preview, quiet_start, quiet_end, timezone FROM notification_prefs WHERE user_id = $1', [ctx.userId]))).rows[0];
    return r ? { minPriority: r.min_priority, showPreview: r.show_preview, quietStart: r.quiet_start, quietEnd: r.quiet_end, timezone: r.timezone } : DEFAULTS;
  }

  async setPrefs(ctx: DbCtx, p: Prefs): Promise<Prefs> {
    await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO notification_prefs(user_id, tenant_id, min_priority, show_preview, quiet_start, quiet_end, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id) DO UPDATE SET min_priority = EXCLUDED.min_priority, show_preview = EXCLUDED.show_preview, quiet_start = EXCLUDED.quiet_start,
           quiet_end = EXCLUDED.quiet_end, timezone = EXCLUDED.timezone, updated_at = now()`,
        [ctx.userId, ctx.tenantId, p.minPriority, p.showPreview, p.quietStart, p.quietEnd, p.timezone],
      ),
    );
    return p;
  }

  async registerDevice(ctx: DbCtx, d: { token: string; label?: string }): Promise<{ id: string }> {
    const hash = createHash('sha256').update(d.token).digest('hex');
    const r = await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO push_devices(tenant_id, user_id, platform, enc_token, token_hash, label) VALUES ($1,$2,'fcm',$3,$4,$5)
         ON CONFLICT (user_id, token_hash) DO UPDATE SET label = coalesce(EXCLUDED.label, push_devices.label) RETURNING id`,
        [ctx.tenantId, ctx.userId, this.crypto.encrypt(d.token), hash, d.label ?? null],
      ),
    );
    return r.rows[0];
  }

  async devices(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query('SELECT id, platform, label, created_at, last_ok_at FROM push_devices ORDER BY created_at DESC'))).rows;
  }

  async removeDevice(ctx: DbCtx, id: string): Promise<boolean> {
    return (await this.db.tx(ctx, (c) => c.query('DELETE FROM push_devices WHERE id = $1', [id]))).rowCount! > 0;
  }

  async feed(ctx: DbCtx, limit = 50) {
    const items = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT n.id, n.kind, n.channel, n.priority, n.created_at, n.read_at, n.thread_id, t.subject
           FROM notifications n LEFT JOIN threads t ON t.id = n.thread_id ORDER BY n.id DESC LIMIT $1`,
          [limit],
        ),
      )
    ).rows;
    const unread = (await this.db.tx(ctx, (c) => c.query('SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL'))).rows[0].n;
    return { unread, items };
  }

  async markRead(ctx: DbCtx, ids: number[] | 'all'): Promise<void> {
    await this.db.tx(ctx, (c) =>
      ids === 'all'
        ? c.query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL')
        : c.query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND id = ANY($1::bigint[])', [ids]),
    );
  }

  /**
   * Called by the worker after an account's sync and AI pass. Records one notification per (thread, latest inbound
   * message), so reruns and redeliveries never notify twice, then pushes the newest few outside quiet hours.
   */
  async scan(accountId: string, now = new Date()): Promise<number> {
    const r = (await this.db.system((c) => c.query('SELECT * FROM sys_account_ctx($1)', [accountId]))).rows[0];
    if (!r) return 0;
    const ctx: DbCtx = { userId: r.user_id, tenantId: r.tenant_id, role: r.role, tenantRole: r.tenant_role };
    const prefs = await this.prefs(ctx);
    if (prefs.minPriority === 'off') return 0;

    const wanted = prefs.minPriority === 'all' ? null : prefs.minPriority === 'urgent' ? ['urgent'] : ['urgent', 'needs_reply'];
    const cands = (
      await this.db.tx(ctx, (c) =>
        c.query(
          `SELECT t.id AS thread_id, t.channel, t.subject, m."timestamp" AS at, m.sender, ta.priority
           FROM threads t JOIN connected_accounts a ON a.id = t.account_id
           JOIN LATERAL (SELECT "timestamp", sender FROM messages WHERE thread_id = t.id AND direction = 'inbound' ORDER BY "timestamp" DESC LIMIT 1) m ON true
           LEFT JOIN thread_analysis ta ON ta.thread_id = t.id
           WHERE t.account_id = $1 AND a.status = 'active' AND m."timestamp" > now() - ${LOOKBACK}
             AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.thread_id = t.id AND o.direction = 'outbound' AND o."timestamp" > m."timestamp")
             AND ($2::text[] IS NULL OR ta.priority = ANY($2))
           ORDER BY m."timestamp" DESC LIMIT 50`,
          [accountId, wanted],
        ),
      )
    ).rows;

    const fresh: typeof cands = [];
    for (const k of cands) {
      const ins = await this.db.tx(ctx, (c) =>
        c.query(
          `INSERT INTO notifications(tenant_id, user_id, kind, ref, thread_id, channel, priority) VALUES ($1,$2,'new_message',$3,$4,$5,$6)
           ON CONFLICT (user_id, kind, ref) DO NOTHING RETURNING id`,
          [ctx.tenantId, ctx.userId, `${k.thread_id}:${new Date(k.at).toISOString()}`, k.thread_id, k.channel, k.priority],
        ),
      );
      if (ins.rowCount) fresh.push({ ...k, nid: ins.rows[0].id });
    }
    if (!fresh.length || !this.push || inQuietHours(localHour(prefs.timezone, now), prefs.quietStart, prefs.quietEnd)) return fresh.length;

    const tokens = (await this.db.tx(ctx, (c) => c.query('SELECT id, enc_token FROM push_devices'))).rows.map((d) => ({ id: d.id as string, token: this.crypto.decrypt(d.enc_token) }));
    if (!tokens.length) return fresh.length;
    for (const k of fresh.slice(0, MAX_PUSHES_PER_SCAN)) {
      const channel = CHANNEL_NAME[k.channel] ?? k.channel;
      // Lock screens and Google's relay see this text, so by default it carries no sender or subject.
      const body = prefs.showPreview
        ? `${k.sender?.name ?? k.sender?.email ?? k.sender?.handle ?? 'Someone'}: ${(k.subject ?? '').slice(0, 80)}`
        : k.priority === 'urgent' ? 'An urgent message arrived' : k.priority === 'needs_reply' ? 'A message needs your reply' : 'You have a new message';
      let delivered = false;
      for (const d of tokens) {
        const outcome = await this.push.send(d.token, { title: channel, body, data: { threadId: k.thread_id, kind: 'new_message' } }).catch((e: Error) => {
          this.log.warn(`Push failed: ${e.message}`);
          return 'failed' as const;
        });
        if (outcome === 'invalid_token') await this.removeDevice(ctx, d.id);
        else if (outcome === 'sent') {
          delivered = true;
          await this.db.tx(ctx, (c) => c.query('UPDATE push_devices SET last_ok_at = now() WHERE id = $1', [d.id]));
        }
      }
      if (delivered) await this.db.tx(ctx, (c) => c.query('UPDATE notifications SET pushed = true WHERE id = $1', [(k as unknown as { nid: number }).nid]));
    }
    return fresh.length;
  }
}
