import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

// OWASP password-storage guidance for scrypt: N=2^15 (32 MiB), r=8, p=3. Parameters are stored with each hash, so they can be
// raised later without breaking existing passwords. The first format (`scrypt$N$salt$key`, N=2^14, r=8, p=1) still verifies.
const N = 32768;
const R = 8;
const P = 3;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parse(stored: string | null): { n: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = (stored ?? '').split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 6) return { n: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), salt: Buffer.from(parts[4], 'base64'), key: Buffer.from(parts[5], 'base64') };
  if (parts.length === 4) return { n: Number(parts[1]), r: 8, p: 1, salt: Buffer.from(parts[2], 'base64'), key: Buffer.from(parts[3], 'base64') };
  return null;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the work so unknown users and wrong passwords take similar time.
  const h = parse(stored);
  const sane = h && Number.isInteger(h.n) && h.n >= 2 ** 14 && h.n <= 2 ** 20 && (h.n & (h.n - 1)) === 0 && h.r === 8 && h.p >= 1 && h.p <= 8;
  const key = await derive(password, sane ? h.salt : randomBytes(16), sane ? h.n : N, sane ? h.r : R, sane ? h.p : P);
  if (!sane) return false;
  return h.key.length === key.length && timingSafeEqual(h.key, key);
}
