import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ENV, Env } from '../config/env';
import { TokenService } from './token.service';

export type OidcProvider = 'google' | 'microsoft';

interface ProviderDef {
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  scope: string;
  issuer: (iss: string) => boolean;
}

const DEFS: Record<OidcProvider, ProviderDef> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    scope: 'openid email profile',
    issuer: (i) => i === 'https://accounts.google.com' || i === 'accounts.google.com',
  },
  microsoft: {
    // "common" accepts work/school and personal accounts; the issuer carries the real tenant id.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    jwksUrl: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    scope: 'openid email profile',
    issuer: (i) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(i),
  },
};

export interface OidcIdentity {
  provider: OidcProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

@Injectable()
export class OidcService {
  private readonly jwks = new Map<OidcProvider, ReturnType<typeof createRemoteJWKSet>>();
  private readonly allowedRedirects: string[];

  constructor(@Inject(ENV) private readonly env: Env, private readonly tokens: TokenService) {
    this.allowedRedirects = env.OIDC_REDIRECT_URIS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private creds(p: OidcProvider): { id: string; secret: string } {
    const id = p === 'google' ? this.env.GOOGLE_CLIENT_ID : this.env.MICROSOFT_CLIENT_ID;
    const secret = p === 'google' ? this.env.GOOGLE_CLIENT_SECRET : this.env.MICROSOFT_CLIENT_SECRET;
    if (!id || !secret) throw new BadRequestException(`${p} sign-in is not configured`);
    return { id, secret };
  }

  async start(provider: OidcProvider, redirectUri: string): Promise<string> {
    if (!this.allowedRedirects.includes(redirectUri)) throw new BadRequestException('redirectUri is not allowed');
    const { id } = this.creds(provider);
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const state = await this.tokens.signState({ v: verifier, n: nonce, r: redirectUri, p: provider });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(DEFS[provider].authUrl);
    u.search = new URLSearchParams({
      client_id: id,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: DEFS[provider].scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  async exchange(provider: OidcProvider, code: string, state: string): Promise<OidcIdentity> {
    const st = await this.tokens.verifyState(state);
    if (st.p !== provider) throw new UnauthorizedException('Provider mismatch');
    const { id, secret } = this.creds(provider);
    const def = DEFS[provider];

    const res = await fetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: st.r,
        client_id: id,
        client_secret: secret,
        code_verifier: st.v,
      }),
    });
    if (!res.ok) throw new UnauthorizedException('Sign-in provider rejected the code');
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new UnauthorizedException('No id_token returned');

    let jwks = this.jwks.get(provider);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(def.jwksUrl));
      this.jwks.set(provider, jwks);
    }
    const { payload } = await jwtVerify(body.id_token, jwks, { audience: id }).catch(() => {
      throw new UnauthorizedException('Invalid id_token');
    });
    if (!def.issuer(String(payload.iss)) || payload.nonce !== st.n || !payload.sub) throw new UnauthorizedException('Invalid id_token claims');

    const email = typeof payload.email === 'string' ? payload.email : null;
    return {
      provider,
      subject: payload.sub,
      email,
      // Google asserts verification. Microsoft's email claim is not verified, so never trust it for linking.
      emailVerified: provider === 'google' && payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
