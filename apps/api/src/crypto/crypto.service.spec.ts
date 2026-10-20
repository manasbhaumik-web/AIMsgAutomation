import { randomBytes } from 'crypto';
import { Env } from '../config/env';
import { CryptoService } from './crypto.service';

const env = (key: string) => ({ MASTER_KEY: key }) as Env;
const key = randomBytes(32).toString('base64');

describe('CryptoService', () => {
  it('round-trips a secret', () => {
    const c = new CryptoService(env(key));
    expect(c.decrypt(c.encrypt('sk-ant-secret'))).toBe('sk-ant-secret');
  });

  it('produces different ciphertext each time and never contains the plaintext', () => {
    const c = new CryptoService(env(key));
    const a = c.encrypt('sk-ant-secret');
    expect(a.equals(c.encrypt('sk-ant-secret'))).toBe(false);
    expect(a.toString('utf8')).not.toContain('sk-ant-secret');
  });

  it('rejects tampered data', () => {
    const c = new CryptoService(env(key));
    const blob = c.encrypt('hello');
    blob[blob.length - 1] ^= 0xff;
    expect(() => c.decrypt(blob)).toThrow();
  });

  it('cannot decrypt with a different master key', () => {
    const blob = new CryptoService(env(key)).encrypt('hello');
    expect(() => new CryptoService(env(randomBytes(32).toString('base64'))).decrypt(blob)).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new CryptoService(env(randomBytes(16).toString('base64')))).toThrow(/32 bytes/);
  });

  describe('key rotation', () => {
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const rotated = () => new CryptoService({ MASTER_KEY: newKey, MASTER_KEY_PREVIOUS: oldKey } as Env);

    it('reads data written under the previous key while both are configured', () => {
      const blob = new CryptoService(env(oldKey)).encrypt('provider-token');
      expect(rotated().decrypt(blob)).toBe('provider-token');
    });

    it('re-wraps to the new key without changing the secret, and the old key is then no longer needed', () => {
      const blob = new CryptoService(env(oldKey)).encrypt('provider-token');
      const next = rotated().rewrap(blob)!;
      expect(next.equals(blob)).toBe(false);
      expect(new CryptoService(env(newKey)).decrypt(next)).toBe('provider-token');
      expect(() => new CryptoService(env(oldKey)).decrypt(next)).toThrow();
    });

    it('leaves data that already uses the current key alone, so the job is repeatable', () => {
      const fresh = new CryptoService(env(newKey)).encrypt('x');
      expect(rotated().rewrap(fresh)).toBeNull();
    });

    it('new data is always written under the new key', () => {
      const blob = rotated().encrypt('y');
      expect(new CryptoService(env(newKey)).decrypt(blob)).toBe('y');
      expect(() => new CryptoService(env(oldKey)).decrypt(blob)).toThrow();
    });

    it('rejects a malformed previous key at startup', () => {
      expect(() => new CryptoService({ MASTER_KEY: newKey, MASTER_KEY_PREVIOUS: 'short' } as Env)).toThrow(/32 bytes/);
    });
  });
});
