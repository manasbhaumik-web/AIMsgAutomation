import { Env } from '../config/env';
import { hashPassword, verifyPassword } from './password';
import { TokenService, hashToken } from './token.service';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    expect(await hashPassword('same-password-123')).not.toBe(await hashPassword('same-password-123'));
  });

  it('rejects when there is no stored hash (OIDC-only users, unknown emails)', async () => {
    expect(await verifyPassword('anything-at-all', null)).toBe(false);
  });
});

describe('TokenService', () => {
  const t = new TokenService({ JWT_SECRET: 'x'.repeat(40) } as Env);
  const user = { id: 'u1', tenantId: 't1', role: 'user' as const, tenantRole: 'tenant_admin' as const, sessionId: 's1' };

  it('round-trips access tokens', async () => {
    expect(await t.verifyAccess(await t.signAccess(user))).toEqual(user);
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new TokenService({ JWT_SECRET: 'y'.repeat(40) } as Env);
    await expect(t.verifyAccess(await other.signAccess(user))).rejects.toThrow();
  });

  it('rejects garbage and OIDC state tokens used as access tokens', async () => {
    await expect(t.verifyAccess('not-a-jwt')).rejects.toThrow();
    const state = await t.signState({ v: 'v', n: 'n', r: 'http://x', p: 'google' });
    await expect(t.verifyAccess(state)).rejects.toThrow();
  });

  it('round-trips OIDC state', async () => {
    const s = { v: 'verifier', n: 'nonce', r: 'http://localhost/cb', p: 'google' };
    expect(await t.verifyState(await t.signState(s))).toEqual(s);
  });

  it('hashes refresh tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('password hash parameters', () => {
  it('writes self-describing hashes with the current cost', async () => {
    const h = await hashPassword('a-long-password-123');
    expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
  });

  it('still verifies hashes made with the earlier, cheaper parameters', async () => {
    const { scryptSync, randomBytes } = await import('crypto');
    const salt = randomBytes(16);
    const legacy = `scrypt$16384$${salt.toString('base64')}$${scryptSync('legacy-password-1', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    expect(await verifyPassword('legacy-password-1', legacy)).toBe(true);
    expect(await verifyPassword('legacy-password-2', legacy)).toBe(false);
  });

  it('refuses stored parameters outside a sane range instead of burning memory on them', async () => {
    const h = await hashPassword('a-long-password-123');
    const weak = h.replace('$32768$', '$1024$');
    const huge = h.replace('$32768$', `$${2 ** 24}$`);
    expect(await verifyPassword('a-long-password-123', weak)).toBe(false);
    expect(await verifyPassword('a-long-password-123', huge)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});
