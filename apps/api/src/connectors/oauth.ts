import { decodeJwt } from 'jose';
import { FetchFn, ProviderAuthError, ProviderError, TokenSet } from './types';

export interface OAuthConfig {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  extraAuthParams?: Record<string, string>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/** Authorization-code + PKCE client shared by the Google and Microsoft connectors. */
export class OAuthClient {
  constructor(private readonly cfg: OAuthConfig, private readonly f: FetchFn = fetch) {}

  authUrl(a: { scopes: string[]; state: string; challenge: string; redirectUri: string }): string {
    const u = new URL(this.cfg.authUrl);
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: 'code',
      redirect_uri: a.redirectUri,
      scope: a.scopes.join(' '),
      state: a.state,
      code_challenge: a.challenge,
      code_challenge_method: 'S256',
      ...this.cfg.extraAuthParams,
    }).toString();
    return u.toString();
  }

  async exchange(a: { code: string; verifier: string; redirectUri: string }): Promise<{ tokens: TokenSet; scope: string[]; idToken?: string }> {
    const r = await this.post({ grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri, code_verifier: a.verifier });
    if (!r.access_token) throw new ProviderAuthError('Provider returned no access token');
    return {
      tokens: { accessToken: r.access_token, refreshToken: r.refresh_token ?? null, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 },
      scope: (r.scope ?? '').split(' ').filter(Boolean),
      idToken: r.id_token,
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthError('No refresh token stored');
    const r = await this.post({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    if (!r.access_token) throw new ProviderAuthError('Provider returned no access token');
    return {
      accessToken: r.access_token,
      // Google omits the refresh token on refresh; Microsoft rotates it. Keep whichever is current.
      refreshToken: r.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
    };
  }

  private async post(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.f(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }),
    });
    // 400/401 from the token endpoint means the grant is invalid or revoked: the user must reconnect.
    if (res.status === 400 || res.status === 401) throw new ProviderAuthError('Authorization is no longer valid');
    if (!res.ok) throw new ProviderError(`${new URL(this.cfg.tokenUrl).host} responded ${res.status}`, res.status);
    return (await res.json()) as TokenResponse;
  }
}

export function emailFromIdToken(idToken: string | undefined): { email: string | null; name: string | null } {
  if (!idToken) return { email: null, name: null };
  const p = decodeJwt(idToken); // direct TLS response from the token endpoint; signature not needed here
  return { email: typeof p.email === 'string' ? p.email : null, name: typeof p.name === 'string' ? p.name : null };
}
