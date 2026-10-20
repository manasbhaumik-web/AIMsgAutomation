import { SignJWT, importPKCS8 } from 'jose';
import type { FetchFn } from '../connectors/types';

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

export interface PushProvider {
  send(token: string, m: PushMessage): Promise<PushOutcome>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * Firebase Cloud Messaging (HTTP v1). One provider covers Android and iOS: for iOS, FCM relays through APNs using the
 * APNs key uploaded in the Firebase console, so this service holds no Apple credentials.
 */
export class FcmPush implements PushProvider {
  private cached?: { token: string; exp: number };

  constructor(private readonly cfg: { projectId: string; account: ServiceAccount }, private readonly f: FetchFn = fetch) {}

  static fromEnv(projectId: string | undefined, json: string | undefined, f?: FetchFn): FcmPush | null {
    if (!projectId || !json) return null;
    try {
      const account = JSON.parse(json) as ServiceAccount;
      if (!account.client_email || !account.private_key) return null;
      return new FcmPush({ projectId, account }, f);
    } catch {
      return null;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.exp - 60_000 > Date.now()) return this.cached.token;
    const key = await importPKCS8(this.cfg.account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.cfg.account.client_email)
      .setSubject(this.cfg.account.client_email)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('55m')
      .sign(key);
    const res = await this.f('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM auth responded ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  async send(token: string, m: PushMessage): Promise<PushOutcome> {
    const res = await this.f(`https://fcm.googleapis.com/v1/projects/${this.cfg.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title: m.title, body: m.body }, data: m.data } }),
    });
    if (res.ok) return 'sent';
    // 404 UNREGISTERED: the app was uninstalled or the token rotated. Other 4xx on a token is also permanent.
    if (res.status === 404 || res.status === 400) {
      const e = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const code = e.error?.details?.find((d) => d.errorCode)?.errorCode ?? e.error?.status;
      if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return 'invalid_token';
    }
    return 'failed';
  }
}
