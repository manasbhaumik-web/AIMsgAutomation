import { Db } from '../db/db.service';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser, TokenService } from './token.service';
import { DbCtx } from '../db/db.service';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type PlatformRole = 'admin' | 'tenant_admin';
export const ROLES = 'roles';
export const Roles = (...roles: PlatformRole[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

export function dbCtx(u: AuthUser): DbCtx {
  return { userId: u.id, tenantId: u.tenantId, role: u.role, tenantRole: u.tenantRole };
}

/**
 * Asks the database whether a session is still valid. Results are cached for a few seconds per instance, which bounds both
 * the load (one lookup per user per few seconds) and how long a revoked session keeps working.
 */
@Injectable()
export class SessionLiveness {
  private readonly cache = new Map<string, { ok: boolean; until: number }>();
  static readonly TTL_MS = 10_000;

  constructor(private readonly db: Db) {}

  async alive(sessionId: string, userId: string): Promise<boolean> {
    const key = `${sessionId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    const r = await this.db.system((c) => c.query('SELECT auth_session_alive($1, $2) AS ok', [sessionId, userId]));
    const ok = r.rows[0]?.ok === true;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, { ok, until: Date.now() + SessionLiveness.TTL_MS });
    return ok;
  }

  /** Immediate effect on this instance for logout and revocation. */
  forget(sessionId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${sessionId}:`)) this.cache.delete(k);
  }
}

/** Global guard: every route needs a valid bearer token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService, private readonly sessions: SessionLiveness) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const user = await this.tokens.verifyAccess(header.slice(7));
    if (!(await this.sessions.alive(user.sessionId, user.id))) throw new UnauthorizedException('Session ended');
    req.user = user;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const needed = this.reflector.getAllAndOverride<PlatformRole[]>(ROLES, [context.getHandler(), context.getClass()]);
    if (!needed?.length) return true;
    const u: AuthUser | undefined = context.switchToHttp().getRequest().user;
    const ok = !!u && needed.some((r) => (r === 'admin' ? u.role === 'admin' : u.tenantRole === 'tenant_admin' || u.role === 'admin'));
    if (!ok) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
