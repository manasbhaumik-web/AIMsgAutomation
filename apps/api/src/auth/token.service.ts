import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ENV, Env } from '../config/env';

export interface AuthUser {
  id: string;
  tenantId: string;
  role: 'admin' | 'user';
  tenantRole: 'tenant_admin' | 'user';
  sessionId: string;
}

const ISSUER = 'inbox-ai';
const AUDIENCE = 'inbox-api';
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.secret = new TextEncoder().encode(env.JWT_SECRET);
  }

  signAccess(u: AuthUser): Promise<string> {
    return new SignJWT({ tid: u.tenantId, role: u.role, tr: u.tenantRole, sid: u.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      return {
        id: String(payload.sub),
        tenantId: String(payload.tid),
        role: payload.role === 'admin' ? 'admin' : 'user',
        tenantRole: payload.tr === 'tenant_admin' ? 'tenant_admin' : 'user',
        sessionId: String(payload.sid),
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Short-lived signed payload for flows that must survive a browser round trip (channel connect). */
  signBlob(audience: string, data: Record<string, string>, ttl = '10m'): Promise<string> {
    return new SignJWT(data).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience(audience).setExpirationTime(ttl).sign(this.secret);
  }

  async verifyBlob(audience: string, token: string): Promise<Record<string, string>> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience, algorithms: ['HS256'] });
      return Object.fromEntries(Object.entries(payload).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
  }

  /** Short-lived signed blob carrying OIDC PKCE verifier, nonce and redirect URI; keeps /start stateless. */
  signState(data: { v: string; n: string; r: string; p: string }): Promise<string> {
    return new SignJWT(data).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience('oidc-state').setExpirationTime('10m').sign(this.secret);
  }

  async verifyState(state: string): Promise<{ v: string; n: string; r: string; p: string }> {
    try {
      const { payload } = await jwtVerify(state, this.secret, { issuer: ISSUER, audience: 'oidc-state', algorithms: ['HS256'] });
      return { v: String(payload.v), n: String(payload.n), r: String(payload.r), p: String(payload.p) };
    } catch {
      throw new UnauthorizedException('Invalid or expired sign-in state');
    }
  }
}
