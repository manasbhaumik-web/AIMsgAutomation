import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { ENV, Env } from '../config/env';
import { Db } from '../db/db.service';
import { AuthService, Session } from './auth.service';
import { CurrentUser, Public, SessionLiveness, dbCtx } from './guards';
import { OidcProvider, OidcService } from './oidc.service';
import { clearRefreshCookie, isWebClient, readRefreshCookie, setRefreshCookie } from './refresh-cookie';
import { AuthUser, REFRESH_TTL_DAYS } from './token.service';

const credentials = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(200),
  name: z.string().min(1).max(100).optional(),
  deviceName: z.string().max(100).optional(),
});
const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200), deviceName: z.string().max(100).optional() });
// Browsers send no body: the HttpOnly cookie carries the token. Mobile apps send it in the body.
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });
const exchangeBody = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(4000), deviceName: z.string().max(100).optional() });

function provider(p: string): OidcProvider {
  if (p !== 'google' && p !== 'microsoft') throw new BadRequestException('Unknown provider');
  return p;
}

const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller()
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(private readonly auth: AuthService, private readonly oidc: OidcService, private readonly db: Db, private readonly liveness: SessionLiveness, @Inject(ENV) env: Env) {
    this.secureCookie = env.WEB_URL.startsWith('https://');
  }

  /** Browsers get the refresh token as an HttpOnly cookie and not in the body; other clients get it in the body. */
  private deliver(s: Session, req: Request, res: Response): Session | Omit<Session, 'refreshToken'> {
    if (!isWebClient(req)) return s;
    setRefreshCookie(res, s.refreshToken, REFRESH_TTL_DAYS, this.secureCookie);
    const { refreshToken: _omit, ...rest } = s;
    void _omit;
    return rest;
  }

  @Public() @Throttle(STRICT) @Post('auth/register')
  async register(@Body(new ZodPipe(credentials)) b: z.infer<typeof credentials>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(await this.auth.register(b.email, b.password, b.name, b.deviceName), req, res);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('auth/login')
  async login(@Body(new ZodPipe(loginBody)) b: z.infer<typeof loginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(await this.auth.login(b.email, b.password, b.deviceName), req, res);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('auth/refresh')
  async refresh(@Body(new ZodPipe(refreshBody)) b: z.infer<typeof refreshBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // The cookie is honoured only with the custom header, so a forged cross-site request cannot ride on it.
    const token = b.refreshToken ?? (isWebClient(req) ? readRefreshCookie(req) : undefined);
    if (!token) throw new UnauthorizedException('Missing refresh token');
    try {
      return this.deliver(await this.auth.refresh(token), req, res);
    } catch (e) {
      if (isWebClient(req)) clearRefreshCookie(res, this.secureCookie);
      throw e;
    }
  }

  @HttpCode(204) @Post('auth/logout')
  async logout(@CurrentUser() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(u.id, u.tenantId, u.sessionId);
    this.liveness.forget(u.sessionId);
    if (isWebClient(req)) clearRefreshCookie(res, this.secureCookie);
  }

  /** Returns the provider URL. The client opens it in the system browser (PKCE is handled server-side via signed state). */
  @Public() @Throttle(STRICT) @Get('auth/oidc/:provider/start')
  async start(@Param('provider') p: string, @Query('redirectUri') redirectUri: string) {
    return { url: await this.oidc.start(provider(p), redirectUri ?? '') };
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('auth/oidc/:provider/exchange')
  async exchange(@Param('provider') p: string, @Body(new ZodPipe(exchangeBody)) b: z.infer<typeof exchangeBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const idn = await this.oidc.exchange(provider(p), b.code, b.state);
    return this.deliver(await this.auth.loginWithIdentity(idn, b.deviceName), req, res);
  }

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) => c.query('SELECT id, email, name, locale, role, settings FROM users WHERE id = $1', [u.id]));
    return { ...r.rows[0], tenantId: u.tenantId, tenantRole: u.tenantRole };
  }

  @Get('me/sessions')
  async sessions(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query('SELECT id, device_name, last_seen, created_at FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen DESC', [u.id]),
    );
    return r.rows.map((s) => ({ ...s, current: s.id === u.sessionId }));
  }

  @HttpCode(204) @Delete('me/sessions/:id')
  async revokeSession(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Invalid id');
    await this.db.tx(dbCtx(u), (c) => c.query('UPDATE device_sessions SET revoked_at = now() WHERE id = $1', [id]));
    this.liveness.forget(id);
  }
}
