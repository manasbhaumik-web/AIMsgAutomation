import { Injectable } from '@nestjs/common';
import { Db, DbCtx } from '../db/db.service';

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  /** Records an audit entry. Never include secrets in meta. */
  async log(ctx: DbCtx, action: string, target?: string, meta: Record<string, unknown> = {}): Promise<void> {
    await this.db.tx(ctx, (c) =>
      c.query('INSERT INTO audit_log(tenant_id, actor_id, action, target, meta) VALUES ($1, $2, $3, $4, $5)', [
        ctx.tenantId ?? null,
        ctx.userId ?? null,
        action,
        target ?? null,
        JSON.stringify(meta),
      ]),
    );
  }
}
