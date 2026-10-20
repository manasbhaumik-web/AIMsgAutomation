import type { components } from './schema.js';

export type Schemas = components['schemas'];
export type Session = Schemas['Session'];
export type Account = Schemas['Account'];
export type Channel = Schemas['Channel'];
export type ThreadRow = Schemas['ThreadRow'];
export type ThreadDetail = Schemas['ThreadDetail'];
export type Draft = Schemas['Draft'];
export type CalendarEvent = Schemas['Event'];
export type Notification = Schemas['Notification'];

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}
/** Where the app keeps tokens: Keychain/Keystore on mobile, memory or a cookie-free store on web. */
export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(t: Tokens): Promise<void>;
  clear(): Promise<void>;
}
export class MemoryTokenStore implements TokenStore {
  private t: Tokens | null = null;
  async get() { return this.t; }
  async set(t: Tokens) { this.t = t; }
  async clear() { this.t = null; }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: { marker: string; kind: 'message' | 'event'; id: string; threadId?: string; title: string; who?: string; at?: string }[] }
  | { type: 'done'; turnId: number }
  | { type: 'error'; code: string; message: string };

export interface ClientOptions {
  baseUrl: string;
  tokens?: TokenStore;
  fetch?: typeof fetch;
  /** Called when the refresh token is no longer accepted: show the sign-in screen. */
  onSignedOut?: () => void;
}

/**
 * Typed client for the Unified Inbox API. It signs requests, refreshes the access token once on 401 (concurrent calls share
 * one refresh, because refresh tokens are single-use), and never sends anything on the person's behalf: sending a reply or
 * answering an invitation needs the `Draft` the person reviewed or an explicit `response`.
 */
export class InboxClient {
  private readonly f: typeof fetch;
  private readonly tokens: TokenStore;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly opts: ClientOptions) {
    this.f = opts.fetch ?? fetch;
    this.tokens = opts.tokens ?? new MemoryTokenStore();
  }

  // ---- auth
  async login(email: string, password: string, deviceName?: string): Promise<Session> {
    return this.adopt(await this.raw<Session>('POST', '/auth/login', { email, password, deviceName }, false));
  }
  async register(email: string, password: string, name?: string, deviceName?: string): Promise<Session> {
    return this.adopt(await this.raw<Session>('POST', '/auth/register', { email, password, name, deviceName }, false));
  }
  /** Mobile: open `url` in the system browser with your deep-link redirect, then call `finishOidc` with the code and state. */
  async oidcStartUrl(provider: 'google' | 'microsoft', redirectUri: string): Promise<string> {
    return (await this.raw<{ url: string }>('GET', `/auth/oidc/${provider}/start?redirectUri=${encodeURIComponent(redirectUri)}`, undefined, false)).url;
  }
  async finishOidc(provider: 'google' | 'microsoft', code: string, state: string, deviceName?: string): Promise<Session> {
    return this.adopt(await this.raw<Session>('POST', `/auth/oidc/${provider}/exchange`, { code, state, deviceName }, false));
  }
  async logout(): Promise<void> {
    try { await this.request('POST', '/auth/logout'); } finally { await this.tokens.clear(); }
  }
  me() { return this.request<Schemas['User']>('GET', '/me'); }

  // ---- inbox
  accounts() { return this.request<Account[]>('GET', '/accounts'); }
  threads(q: { channel?: string; accountId?: string; unreadOnly?: boolean; priority?: string; topicId?: string; before?: string; limit?: number } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.request<{ threads: ThreadRow[]; nextBefore: string | null }>('GET', `/inbox/threads?${p}`);
  }
  thread(id: string) { return this.request<ThreadDetail>('GET', `/threads/${id}`); }
  markThreadRead(id: string, read: boolean) { return this.request('POST', `/threads/${id}/read`, { read }); }

  // ---- replies: drafting is free, sending needs the reviewed draft
  async getDraft(threadId: string): Promise<Draft | null> { return (await this.request<{ draft: Draft | null }>('GET', `/threads/${threadId}/draft`)).draft; }
  async saveDraft(threadId: string, body: string): Promise<Draft> { return (await this.request<{ draft: Draft }>('PUT', `/threads/${threadId}/draft`, { body })).draft; }
  async aiDraft(threadId: string, instructions?: string): Promise<Draft> { return (await this.request<{ draft: Draft }>('POST', `/threads/${threadId}/draft/ai`, { instructions })).draft; }
  discardDraft(threadId: string) { return this.request('DELETE', `/threads/${threadId}/draft`); }
  /**
   * Sends the reply, confirming the exact text of `reviewed`, which must be the draft object the person was looking at.
   * Call this only from the handler of an explicit "Send" tap on a confirmation screen.
   */
  async sendDraft(reviewed: Draft, opts: { acceptNewMessages?: boolean } = {}): Promise<Draft> {
    return (await this.request<{ draft: Draft }>('POST', `/drafts/${reviewed.id}/send`, { confirm: true, bodyHash: reviewed.bodyHash, acceptNewMessages: opts.acceptNewMessages ?? false })).draft;
  }

  // ---- calendar
  events(from: Date, to: Date) { return this.request<{ events: CalendarEvent[] }>('GET', `/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`); }
  suggestTimes(o: { durationMin?: number; days?: number; timezone?: string } = {}) { return this.request<{ slots: { start: string; end: string }[] }>('POST', '/calendar/suggest-times', o); }
  /** Call only after the person confirmed the answer. */
  respondToEvent(eventId: string, response: 'accept' | 'decline' | 'tentative', comment?: string) { return this.request('POST', `/events/${eventId}/respond`, { confirm: true, response, comment }); }

  // ---- notifications and devices
  notifications() { return this.request<{ unread: number; items: Notification[] }>('GET', '/notifications'); }
  registerPushToken(token: string, label?: string) { return this.request<{ id: string }>('POST', '/notifications/devices', { token, label }); }
  removePushDevice(id: string) { return this.request('DELETE', `/notifications/devices/${id}`); }

  // ---- privacy
  /** Newline-delimited JSON of everything held about the person. */
  async exportData(): Promise<Response> { return this.send('GET', '/me/export'); }
  deleteAccount(confirmEmail: string, password?: string) { return this.request('DELETE', '/me', { confirmEmail, password }); }

  // ---- assistant (Server-Sent Events over fetch)
  async *chat(conversationId: string, content: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const res = await this.send('POST', `/chat/conversations/${conversationId}/messages`, { content }, signal);
    if (!res.body) throw new ApiError(res.status, 'No response stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev && data) yield { type: ev, ...(JSON.parse(data) as object) } as ChatEvent;
      }
    }
  }

  // ---- plumbing
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
  }

  private async raw<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    const res = await this.fetchOnce(method, path, body, auth ? (await this.tokens.get())?.accessToken : undefined);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as T;
  }

  private async send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res = await this.fetchOnce(method, path, body, (await this.tokens.get())?.accessToken, signal);
    if (res.status === 401 && (await this.refresh())) res = await this.fetchOnce(method, path, body, (await this.tokens.get())?.accessToken, signal);
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private fetchOnce(method: string, path: string, body: unknown, accessToken?: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    return this.f(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  }

  /** One refresh at a time: refresh tokens are single-use, so parallel refreshes would revoke the session. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const cur = await this.tokens.get();
        if (!cur) return false;
        const res = await this.fetchOnce('POST', '/auth/refresh', { refreshToken: cur.refreshToken });
        if (!res.ok) {
          await this.tokens.clear();
          this.opts.onSignedOut?.();
          return false;
        }
        await this.adopt((await res.json()) as Session);
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async adopt(s: Session): Promise<Session> {
    await this.tokens.set({ accessToken: s.accessToken as string, refreshToken: s.refreshToken as string });
    return s;
  }

  private async toError(res: Response): Promise<ApiError> {
    const j = (await res.json().catch(() => ({}))) as { message?: string | string[]; code?: string };
    return new ApiError(res.status, Array.isArray(j.message) ? j.message.join(', ') : j.message ?? res.statusText, j.code);
  }
}
