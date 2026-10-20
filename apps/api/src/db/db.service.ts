import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ENV, Env } from '../config/env';

/** Identity of the caller, applied to every transaction so Postgres RLS can enforce isolation. */
export interface DbCtx {
  userId?: string;
  tenantId?: string;
  role?: 'admin' | 'user';
  tenantRole?: 'tenant_admin' | 'user';
}

export async function applyCtx(client: PoolClient, ctx: DbCtx): Promise<void> {
  await client.query(
    `SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true),
            set_config('app.role', $3, true), set_config('app.tenant_role', $4, true)`,
    [ctx.userId ?? '', ctx.tenantId ?? '', ctx.role ?? '', ctx.tenantRole ?? ''],
  );
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX });
  }

  /** Runs fn in a transaction scoped to ctx. All data access goes through here. */
  async tx<T>(ctx: DbCtx, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await applyCtx(client, ctx);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** No user context. Only for pre-authentication lookups, which are SECURITY DEFINER functions. */
  system<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.tx({}, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
