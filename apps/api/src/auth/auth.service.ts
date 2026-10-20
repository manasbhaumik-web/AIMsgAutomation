import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { hashPassword, verifyPassword } from './password';
import { OidcIdentity } from './oidc.service';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS, TokenService, hashToken, newRefreshToken } from './token.service';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string | null; role: string };
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  role: 'admin' | 'user';
  disabled: boolean;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Db, private readonly tokens: TokenService, private readonly audit: AuditService) {}

  async register(email: string, password: string, name: string | undefined, device?: string): Promise<Session> {
    const hash = await hashPassword(password);
    try {
      const r = await this.db.system((c) => c.query('SELECT auth_create_user($1, $2, $3, $4) AS id', [email, name ?? null, hash, 'user']));
      return this.issue(r.rows[0].id, device);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Email is already registered');
      throw e;
    }
  }

  async login(email: string, password: string, device?: string): Promise<Session> {
    const u = await this.findByEmail(email);
    const ok = await verifyPassword(password, u?.password_hash ?? null);
    if (!u || !ok || u.disabled) throw new UnauthorizedException('Invalid email or password');
    return this.issue(u.id, device);
  }

  async loginWithIdentity(idn: OidcIdentity, device?: string): Promise<Session> {
    const byIdentity = await this.db.system((c) => c.query<UserRow>('SELECT * FROM auth_find_user_by_identity($1, $2)', [idn.provider, idn.subject]));
    let user = byIdentity.rows[0];

    if (!user) {
      if (!idn.email) throw new UnauthorizedException('The provider did not return an email address');
      const existing = await this.findByEmail(idn.email);
      if (existing) {
        // Only link automatically when the provider vouches for the address. Otherwise someone could
        // pre-create a provider account with a victim's email and take over their account.
        if (!idn.emailVerified) throw new ConflictException('An account with this email exists. Sign in with your password, then link this provider.');
        user = existing;
      } else {
        const r = await this.db.system((c) => c.query('SELECT auth_create_user($1, $2, NULL, $3) AS id', [idn.email, idn.name, 'user']));
        user = (await this.findById(r.rows[0].id))!;
      }
      await this.db.system((c) => c.query('SELECT auth_link_identity($1, $2, $3, $4)', [user.id, idn.provider, idn.subject, idn.email]));
    }
    if (user.disabled) throw new UnauthorizedException('Account disabled');
    return this.issue(user.id, device);
  }

  async refresh(refreshToken: string): Promise<Session> {
    const h = hashToken(refreshToken);
    const found = await this.db.system((c) => c.query('SELECT * FROM auth_find_session($1)', [h]));
    const s = found.rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw new UnauthorizedException('Invalid refresh token');

    const ctx = await this.userCtx(s.user_id);
    if (s.refresh_hash !== h) {
      // An already-rotated token was presented again: assume theft and kill the session.
      await this.db.tx(ctx, (c) => c.query('UPDATE device_sessions SET revoked_at = now() WHERE id = $1', [s.id]));
      await this.audit.log(ctx, 'auth.refresh_reuse_detected', s.id);
      throw new UnauthorizedException('Invalid refresh token');
    }
    const next = newRefreshToken();
    const upd = await this.db.tx(ctx, (c) =>
      c.query(
        `UPDATE device_sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $2, last_seen = now(),
           expires_at = now() + make_interval(days => $3)
         WHERE id = $1 AND refresh_hash = $4 AND revoked_at IS NULL`,
        [s.id, hashToken(next), REFRESH_TTL_DAYS, h],
      ),
    );
    if (upd.rowCount !== 1) throw new UnauthorizedException('Invalid refresh token');
    const user = (await this.findById(s.user_id))!;
    if (user.disabled) throw new UnauthorizedException('Account disabled');
    return this.build(user, ctx.tenantId, ctx.tenantRole, s.id, next);
  }

  async logout(userId: string, tenantId: string, sessionId: string): Promise<void> {
    await this.db.tx({ userId, tenantId }, (c) => c.query('UPDATE device_sessions SET revoked_at = now() WHERE id = $1', [sessionId]));
  }

  private async issue(userId: string, device?: string): Promise<Session> {
    const ctx = await this.userCtx(userId);
    const user = (await this.findById(userId))!;
    const refresh = newRefreshToken();
    const ins = await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO device_sessions(user_id, refresh_hash, device_name, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id`,
        [userId, hashToken(refresh), device ?? null, REFRESH_TTL_DAYS],
      ),
    );
    return this.build(user, ctx.tenantId, ctx.tenantRole, ins.rows[0].id, refresh);
  }

  private async build(user: UserRow, tenantId: string, tenantRole: 'tenant_admin' | 'user', sessionId: string, refreshToken: string): Promise<Session> {
    const accessToken = await this.tokens.signAccess({ id: user.id, tenantId, role: user.role, tenantRole, sessionId });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  }

  private async userCtx(userId: string): Promise<{ userId: string; tenantId: string; tenantRole: 'tenant_admin' | 'user'; role: 'admin' | 'user' }> {
    const [m, u] = await Promise.all([
      this.db.system((c) => c.query('SELECT * FROM auth_user_context($1)', [userId])),
      this.findById(userId),
    ]);
    if (!m.rows[0] || !u) throw new UnauthorizedException('Account not found');
    return { userId, tenantId: m.rows[0].tenant_id, tenantRole: m.rows[0].tenant_role, role: u.role };
  }

  /** For re-authentication before destructive actions. 'none' = OIDC-only account with no password. */
  async passwordCheck(userId: string, password: string | undefined): Promise<'ok' | 'wrong' | 'missing' | 'none'> {
    const u = await this.findById(userId);
    if (!u) return 'wrong';
    if (!u.password_hash) return 'none';
    if (!password) return 'missing';
    return (await verifyPassword(password, u.password_hash)) ? 'ok' : 'wrong';
  }

  private async findByEmail(email: string): Promise<UserRow | undefined> {
    return (await this.db.system((c) => c.query<UserRow>('SELECT * FROM auth_find_user($1)', [email]))).rows[0];
  }

  private async findById(id: string): Promise<UserRow | undefined> {
    return (await this.db.system((c) => c.query<UserRow>('SELECT * FROM auth_find_user_by_id($1)', [id]))).rows[0];
  }
}
