import type { Request, Response } from 'express';

export const REFRESH_COOKIE = 'inbox_rt';
/** The web client sends this header on auth calls. Browsers cannot add it to cross-site form posts, which is the CSRF check. */
export const WEB_CLIENT_HEADER = 'x-client';

export const isWebClient = (req: Request): boolean => req.header(WEB_CLIENT_HEADER) === 'web';

export function readRefreshCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === REFRESH_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Browsers keep the refresh token in an HttpOnly cookie that scripts cannot read (so an XSS bug cannot steal it), scoped to
 * the auth endpoints and sent only to the same site. Mobile apps keep using the token from the response body.
 */
export function setRefreshCookie(res: Response, token: string, maxAgeDays: number, secure: boolean): void {
  res.append('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/auth; Max-Age=${maxAgeDays * 86_400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; Path=/api/v1/auth; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}
