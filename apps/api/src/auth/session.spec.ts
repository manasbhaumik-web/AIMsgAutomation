import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ENV } from '../config/env';
import { Db } from '../db/db.service';
import { AuthGuard, SessionLiveness } from './guards';
import { OidcService } from './oidc.service';
import { TokenService } from './token.service';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const session = { accessToken: 'access-1', refreshToken: 'refresh-token-value-0123456789', expiresIn: 900, user: { id: 'u1', email: 'a@b.co', name: null, role: 'user' as const } };

describe('refresh token delivery: HttpOnly cookie for browsers, body for apps', () => {
  let app: INestApplication;
  let url: string;
  const seen: string[] = [];
  let refreshFails = false;
  const live = new SessionLiveness({ system: async () => ({ rows: [{ ok: true }] }) } as unknown as Db);
  const forgot: string[] = [];
  live.forget = (id: string) => { forgot.push(id); };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: { login: async () => session, refresh: async (t: string) => { seen.push(t); if (refreshFails) throw new UnauthorizedException(); return { ...session, refreshToken: 'rotated-refresh-token-0123456789' }; }, logout: async () => undefined } },
        { provide: OidcService, useValue: {} },
        { provide: Db, useValue: {} },
        { provide: SessionLiveness, useValue: live },
        { provide: ENV, useValue: { WEB_URL: 'https://inbox.example.org' } },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: { user?: unknown; url: string }, _res: unknown, next: () => void) => { if (req.url.includes('logout')) req.user = { id: 'u1', tenantId: 't', sessionId: 's-9', role: 'user', tenantRole: 'user' }; next(); });
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());
  beforeEach(() => { seen.length = 0; forgot.length = 0; refreshFails = false; });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('web login sets an HttpOnly, SameSite=Strict, Secure cookie scoped to the auth path and keeps the token out of the body', async () => {
    const res = await post('/auth/login', { email: 'a@b.co', password: 'x' }, { 'x-client': 'web' });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^inbox_rt=refresh-token-value-0123456789;/);
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api/v1/auth', 'Max-Age=2592000']) expect(cookie).toContain(part);
    const body = await res.json();
    expect(body.accessToken).toBe('access-1');
    expect(body).not.toHaveProperty('refreshToken');
  });

  it('app login (no web header) gets the token in the body and no cookie', async () => {
    const res = await post('/auth/login', { email: 'a@b.co', password: 'x' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await res.json()).refreshToken).toBe('refresh-token-value-0123456789');
  });

  it('refresh reads the cookie only when the web header proves the request came from our own page', async () => {
    const cookie = { cookie: 'a=1; inbox_rt=cookie-token-aaaaaaaaaaaaaaaa; b=2' };
    expect((await post('/auth/refresh', {}, { ...cookie, 'x-client': 'web' })).status).toBe(200);
    expect(seen).toEqual(['cookie-token-aaaaaaaaaaaaaaaa']);
    seen.length = 0;
    // A cross-site request carries the cookie but cannot add the custom header.
    expect((await post('/auth/refresh', {}, cookie)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('an app can still refresh with the token in the body, and the body wins', async () => {
    expect((await post('/auth/refresh', { refreshToken: 'body-token-bbbbbbbbbbbbbbbbbb' })).status).toBe(200);
    expect(seen).toEqual(['body-token-bbbbbbbbbbbbbbbbbb']);
  });

  it('a rejected refresh clears the cookie', async () => {
    refreshFails = true;
    const res = await post('/auth/refresh', {}, { cookie: 'inbox_rt=stale-token-cccccccccccccccc', 'x-client': 'web' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/inbox_rt=;.*Max-Age=0/);
  });

  it('logout clears the cookie and drops the cached session on this instance', async () => {
    const res = await post('/auth/logout', {}, { 'x-client': 'web' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(forgot).toEqual(['s-9']);
  });
});

describe('session liveness', () => {
  const guard = (alive: () => boolean) => {
    let lookups = 0;
    const live = new SessionLiveness({ system: async () => { lookups++; return { rows: [{ ok: alive() }] }; } } as unknown as Db);
    const tokens = { verifyAccess: async () => ({ id: 'u1', tenantId: 't', role: 'user', tenantRole: 'user', sessionId: 's1' }) } as unknown as TokenService;
    const g = new AuthGuard(new Reflector(), tokens, live);
    const ctx = { getHandler: () => function handler() {}, getClass: () => class Cls {}, switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer x' } }) }) } as never;
    return { g, ctx, live, lookups: () => lookups };
  };

  it('rejects a valid token whose session was revoked, disabled or deleted', async () => {
    const { g, ctx } = guard(() => false);
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('checks the database once per few seconds, and a logout takes effect immediately on this instance', async () => {
    let alive = true;
    const { g, ctx, live, lookups } = guard(() => alive);
    await g.canActivate(ctx);
    await g.canActivate(ctx);
    expect(lookups()).toBe(1);
    alive = false;
    live.forget('s1');
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(lookups()).toBe(2);
  });
});
