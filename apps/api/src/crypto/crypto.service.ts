import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ENV, Env } from '../config/env';

/** Wraps data keys. Swap LocalKeyProvider for a KMS/Key Vault implementation without touching callers. */
export interface KeyProvider {
  wrap(dek: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
}

/**
 * Master key held in the environment. The first key wraps new data keys; older keys (MASTER_KEY_PREVIOUS) are only tried
 * when unwrapping, so a key can be rotated without downtime: deploy with the new key first and the old one as previous,
 * run `rotate-keys`, then drop the old key.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: Buffer[];
  constructor(base64Key: string, previous: string[] = []) {
    this.keys = [base64Key, ...previous].map((k) => {
      const key = Buffer.from(k, 'base64');
      if (key.length !== 32) throw new Error('Master keys must be base64 of exactly 32 bytes');
      return key;
    });
  }
  wrap(dek: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys[0], iv);
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  unwrap(wrapped: Buffer): Buffer {
    let last: unknown;
    for (const key of this.keys) {
      try {
        const d = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
        d.setAuthTag(wrapped.subarray(12, 28));
        return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
      } catch (e) {
        last = e; // authentication failed with this key: try the next
      }
    }
    throw last instanceof Error ? last : new Error('Cannot unwrap data key');
  }
  /** True when the data key is already wrapped by the current key. */
  isCurrent(wrapped: Buffer): boolean {
    try {
      const d = createDecipheriv('aes-256-gcm', this.keys[0], wrapped.subarray(0, 12));
      d.setAuthTag(wrapped.subarray(12, 28));
      d.update(wrapped.subarray(28));
      d.final();
      return true;
    } catch {
      return false;
    }
  }
}

const VERSION = 1;

/**
 * Envelope encryption: a fresh AES-256-GCM data key per value, wrapped by the key provider.
 * Layout: version(1) | wrappedLen(2) | wrapped | iv(12) | tag(16) | ciphertext
 */
@Injectable()
export class CryptoService {
  private readonly keys: LocalKeyProvider;

  constructor(@Inject(ENV) env: Env) {
    this.keys = new LocalKeyProvider(env.MASTER_KEY, (env.MASTER_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  }

  encrypt(plain: string): Buffer {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    const wrapped = this.keys.wrap(dek);
    const head = Buffer.alloc(3);
    head.writeUInt8(VERSION, 0);
    head.writeUInt16BE(wrapped.length, 1);
    return Buffer.concat([head, wrapped, iv, c.getAuthTag(), ct]);
  }

  /**
   * Re-wraps the data key with the current master key without touching the ciphertext. Returns null when the blob already
   * uses the current key. Used by `rotate-keys`.
   */
  rewrap(blob: Buffer): Buffer | null {
    if (blob.readUInt8(0) !== VERSION) throw new Error('Unsupported ciphertext version');
    const wlen = blob.readUInt16BE(1);
    const wrapped = blob.subarray(3, 3 + wlen);
    if (this.keys.isCurrent(wrapped)) return null;
    const fresh = this.keys.wrap(this.keys.unwrap(wrapped));
    const head = Buffer.alloc(3);
    head.writeUInt8(VERSION, 0);
    head.writeUInt16BE(fresh.length, 1);
    return Buffer.concat([head, fresh, blob.subarray(3 + wlen)]);
  }

  decrypt(blob: Buffer): string {
    if (blob.readUInt8(0) !== VERSION) throw new Error('Unsupported ciphertext version');
    const wlen = blob.readUInt16BE(1);
    const dek = this.keys.unwrap(blob.subarray(3, 3 + wlen));
    const o = 3 + wlen;
    const d = createDecipheriv('aes-256-gcm', dek, blob.subarray(o, o + 12));
    d.setAuthTag(blob.subarray(o + 12, o + 28));
    return Buffer.concat([d.update(blob.subarray(o + 28)), d.final()]).toString('utf8');
  }
}
