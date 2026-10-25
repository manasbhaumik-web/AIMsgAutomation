const BASE = '/api/v1';

export interface Session {
  accessToken: string;
  user: { id: string; email: string; name: string | null; role: 'admin' | 'user' };
}

let session: Session | null = null;
// The refresh token lives in an HttpOnly cookie set by the API (scripts cannot read it); only the short-lived access token is kept in memory.

export const getSession = () => session;

function store(s: Session | null): void {
  session = s;
}

async function raw(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-client': 'web', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function fail(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}));
  // Nest wraps structured errors as { code, message }; validation errors arrive as a message array.
  const m = body.message;
  throw new ApiError(Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : `Request failed (${res.status})`, res.status, body.code);
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await raw('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceName: 'Web' }) });
  if (!res.ok) return fail(res);
  const s = (await res.json()) as Session;
  store(s);
  return s;
}

export async function register(email: string, password: string, name: string): Promise<Session> {
  const res = await raw('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name: name || undefined, deviceName: 'Web' }) });
  if (!res.ok) return fail(res);
  const s = (await res.json()) as Session;
  store(s);
  return s;
}

let restoring: Promise<Session | null> | null = null;

/** One refresh at a time: refresh tokens are single-use, so parallel refreshes would look like token theft and end the session. */
export function restore(): Promise<Session | null> {
  restoring ??= doRestore().finally(() => { restoring = null; });
  return restoring;
}

async function doRestore(): Promise<Session | null> {
  // The cookie (if any) is sent automatically; the custom header proves the request came from our own page.
  const res = await raw('/auth/refresh', { method: 'POST', body: '{}' });
  if (!res.ok) {
    store(null);
    return null;
  }
  const s = (await res.json()) as Session;
  store(s);
  return s;
}

export async function logout(): Promise<void> {
  if (session) await raw('/auth/logout', { method: 'POST' }, session.accessToken).catch(() => undefined);
  store(null);
}

export async function oidcStart(provider: 'google' | 'microsoft'): Promise<void> {
  const redirectUri = `${location.origin}/auth/callback`;
  const res = await raw(`/auth/oidc/${provider}/start?redirectUri=${encodeURIComponent(redirectUri)}`);
  if (!res.ok) return fail(res);
  sessionStorage.setItem('inbox.oidc.provider', provider);
  location.href = (await res.json()).url;
}

export async function oidcFinish(code: string, state: string): Promise<Session> {
  const provider = sessionStorage.getItem('inbox.oidc.provider');
  if (provider !== 'google' && provider !== 'microsoft') throw new Error('Sign-in was not started in this browser');
  const res = await raw(`/auth/oidc/${provider}/exchange`, { method: 'POST', body: JSON.stringify({ code, state, deviceName: 'Web' }) });
  if (!res.ok) return fail(res);
  const s = (await res.json()) as Session;
  store(s);
  return s;
}

/** Authenticated call with one automatic token refresh. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!session) throw new Error('Not signed in');
  let res = await raw(path, init, session.accessToken);
  if (res.status === 401 && (await restore())) res = await raw(path, init, session!.accessToken);
  if (!res.ok) return fail(res);
  if (res.status === 204) return undefined as T;
  // A handler that returns null sends an empty body; treat that as null instead of failing to parse it.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Saves a file that needs the bearer token (a plain link would not carry it). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  if (!session) throw new Error('Not signed in');
  let res = await raw(path, {}, session.accessToken);
  if (res.status === 401 && (await restore())) res = await raw(path, {}, session!.accessToken);
  if (!res.ok) return fail(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface StreamEvent {
  type: 'token' | 'citations' | 'done' | 'error';
  text?: string;
  citations?: Citation[];
  code?: string;
  message?: string;
}
export interface Citation { marker: string; kind: 'message' | 'event'; id: string; threadId?: string; title: string; who?: string; at: string }

/** POSTs and reads a server-sent-event response (EventSource cannot send auth headers). */
export async function streamPost(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!session) throw new Error('Not signed in');
  const send = () => fetch(BASE + path, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${session!.accessToken}` }, body: JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && (await restore())) res = await send();
  if (!res.ok) return fail(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (data) onEvent(JSON.parse(data.slice(6)) as StreamEvent);
    }
  }
}
