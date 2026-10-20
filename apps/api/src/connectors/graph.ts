import { getJson, sendJson } from './http';
import { OAuthClient } from './oauth';
import { ConnectResult, ConnectorAccount, FetchFn, ProviderAuthError, Subscription, TokenSet, WebhookRequest, WebhookResult } from './types';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
// Outlook mail and calendar share one Entra app; each channel requests only its own Graph scope.
export const MS_BASE_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read'];

export function msOAuth(clientId: string, clientSecret: string, f?: FetchFn): OAuthClient {
  return new OAuthClient(
    {
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientId,
      clientSecret,
      extraAuthParams: { prompt: 'select_account' },
    },
    f,
  );
}

/** Shared by the two Microsoft connectors: connect callback, token refresh, subscriptions, webhook parsing. */
export class GraphBase {
  constructor(readonly oauth: OAuthClient, readonly f: FetchFn, private readonly resource: string, private readonly scopes: string[]) {}

  authUrl(a: { state: string; challenge: string; redirectUri: string }, extraScopes: string[] = []): string {
    return this.oauth.authUrl({ scopes: [...MS_BASE_SCOPES, ...this.scopes, ...extraScopes], state: a.state, challenge: a.challenge, redirectUri: a.redirectUri });
  }

  async callback(a: { code: string; verifier: string; redirectUri: string }): Promise<ConnectResult> {
    const r = await this.oauth.exchange(a);
    const me = await getJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(this.f, `${GRAPH}/me?$select=mail,userPrincipalName,displayName`, r.tokens.accessToken);
    const email = me.mail ?? me.userPrincipalName;
    if (!email) throw new ProviderAuthError('Microsoft did not return a mailbox address');
    return { tokens: r.tokens, externalId: email.toLowerCase(), displayName: me.displayName ?? null, scopes: r.scope };
  }

  refresh(t: TokenSet): Promise<TokenSet> {
    return this.oauth.refresh(t);
  }

  /** Graph subscriptions for mail/events live at most ~3 days; the renewal job calls this again before expiry. */
  async subscribe(acct: ConnectorAccount, notifyUrl: string, clientState: string): Promise<Subscription | null> {
    const expiresAt = new Date(Date.now() + 4200 * 60_000);
    const r = await sendJson<{ id: string; expirationDateTime: string }>(this.f, 'POST', `${GRAPH}/subscriptions`, acct.tokens.accessToken, {
      changeType: 'created,updated,deleted',
      notificationUrl: notifyUrl,
      resource: this.resource,
      expirationDateTime: expiresAt.toISOString(),
      clientState,
    });
    return r ? { id: r.id, expiresAt: new Date(r.expirationDateTime) } : null;
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    if (req.query.validationToken) return { response: req.query.validationToken, lookups: [] };
    const value = (req.body as { value?: { subscriptionId?: string; clientState?: string }[] })?.value;
    if (!Array.isArray(value)) throw new ProviderAuthError('Malformed notification');
    return { lookups: value.filter((v) => v.subscriptionId).map((v) => ({ subscriptionId: v.subscriptionId, clientState: v.clientState })) };
  }
}

export interface DeltaPage<T> {
  value: (T & { '@removed'?: unknown; id: string })[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * Follows nextLink pages until Graph returns a deltaLink. If maxItems is reached first, the pending nextLink
 * is returned as the cursor, so the next run continues where this one stopped.
 */
export async function followDelta<T>(f: FetchFn, firstUrl: string, token: string, headers: Record<string, string>, maxItems = 3000): Promise<{ items: DeltaPage<T>['value']; cursor: string }> {
  const items: DeltaPage<T>['value'] = [];
  let url = firstUrl;
  let cursor = '';
  for (;;) {
    const page: DeltaPage<T> = await getJson<DeltaPage<T>>(f, url, token, headers);
    items.push(...page.value);
    if (page['@odata.deltaLink']) {
      cursor = page['@odata.deltaLink'];
      break;
    }
    const next = page['@odata.nextLink'];
    if (!next) break;
    if (items.length >= maxItems) {
      cursor = next;
      break;
    }
    url = next;
  }
  return { items, cursor };
}
