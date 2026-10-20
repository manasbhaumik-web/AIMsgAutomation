import { OAuthClient, emailFromIdToken } from './oauth';
import { ChannelConnector, ConnectResult, ConnectorAccount, FetchFn, ProviderAuthError, SyncResult, TokenSet } from './types';

/**
 * Feature-flagged stub (LINKEDIN_ENABLED). LinkedIn's messaging and inbox APIs are limited to approved partners, so a
 * normal app cannot read a member's messages. This connector implements only what is official and open: Sign in with
 * LinkedIn (OpenID Connect: openid, profile, email). It links the profile and syncs nothing.
 * Becoming a partner and implementing the Messaging API is a business step, not a code change; see the connectors README.
 */
export class LinkedInConnector implements ChannelConnector {
  readonly id = 'linkedin' as const;
  readonly displayName = 'LinkedIn (profile only)';
  readonly capabilities = { read: false, send: false, calendar: false, realtime: false };
  readonly longLivedTokens = true;
  readonly notice = 'LinkedIn does not let ordinary apps read messages; only approved partners can. This links your profile and brings in no messages. LinkedIn notification emails in your connected mailbox are still organized with your mail.';

  constructor(private readonly oauth: OAuthClient, private readonly f: FetchFn = fetch) {}

  getAuthUrl(a: { state: string; challenge: string; redirectUri: string }): string {
    return this.oauth.authUrl({ scopes: ['openid', 'profile', 'email'], ...a });
  }

  async handleAuthCallback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const r = await this.oauth.exchange(a);
    const claims = emailFromIdToken(r.idToken);
    const info = await this.f('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${r.tokens.accessToken}` } });
    if (!info.ok) throw new ProviderAuthError('LinkedIn rejected the access token');
    const j = (await info.json()) as { sub?: string; name?: string };
    if (!j.sub) throw new ProviderAuthError('LinkedIn returned no member id');
    return { tokens: r.tokens, externalId: j.sub, displayName: j.name ?? claims.name, scopes: r.scope };
  }

  async refreshToken(t: TokenSet): Promise<TokenSet> {
    // Refresh tokens are partner-only: after the access token expires (about 60 days) the user reconnects.
    if (t.expiresAt > Date.now()) return t;
    throw new ProviderAuthError('LinkedIn access expired');
  }

  async initialSync(): Promise<SyncResult> {
    return { messages: [], events: [], deletedExternalIds: [], cursor: 'none' };
  }
  async incrementalSync(_acct: ConnectorAccount, _cursor: string): Promise<SyncResult> {
    return { messages: [], events: [], deletedExternalIds: [], cursor: 'none' };
  }
  async revoke(): Promise<void> {
    // LinkedIn's revoke endpoint needs the client secret; local token deletion by the caller is sufficient for a profile-only link.
  }
}
