import { BadRequestException } from '@nestjs/common';
import { isIP } from 'net';

/** Hosts that point at the machine or its private network, as names. */
const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

function ipv4Private(ip: string): { private: boolean; linkLocal: boolean } {
  const [a, b] = ip.split('.').map(Number);
  const linkLocal = a === 169 && b === 254; // includes the cloud metadata address 169.254.169.254
  const priv = a === 10 || a === 127 || a === 0 || linkLocal || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  return { private: priv, linkLocal };
}

function classify(host: string): { private: boolean; linkLocal: boolean } {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(h);
  if (kind === 4) return ipv4Private(h);
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return ipv4Private(mapped[1]);
    // The URL parser rewrites ::ffff:10.0.0.1 as ::ffff:a00:1, so the hex form must be decoded too.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const linkLocal = /^fe[89ab]/.test(h);
    return { private: h === '::1' || h === '::' || linkLocal || /^f[cd]/.test(h), linkLocal };
  }
  return { private: PRIVATE_NAMES.test(h) || !h.includes('.'), linkLocal: /^metadata(\.|$)/.test(h) };
}

/**
 * An administrator can set where a provider's API lives, and the server then calls that URL with the provider key. Without a
 * check, that is a way to make the server call internal services or the cloud metadata endpoint. Rules: https only; no
 * credentials in the URL; no private, loopback or link-local addresses. Local model servers (Ollama) may use http on a private
 * address but never on a link-local one. Names are checked here, not resolved, so this narrows rather than eliminates DNS tricks:
 * keep egress filtering at the network layer too.
 */
export function assertSafeProviderUrl(raw: string | null | undefined, kind: string): void {
  if (!raw) return;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException('The provider URL is not valid');
  }
  if (u.username || u.password) throw new BadRequestException('The provider URL must not contain credentials');
  const c = classify(u.hostname);
  if (c.linkLocal) throw new BadRequestException('The provider URL points at a reserved address');
  if (kind === 'ollama') {
    if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequestException('The provider URL must be http or https');
    return;
  }
  if (u.protocol !== 'https:') throw new BadRequestException('The provider URL must use https');
  if (c.private) throw new BadRequestException('The provider URL must be a public address');
}
