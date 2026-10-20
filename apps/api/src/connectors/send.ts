import { NormalizedMessage, Party } from './types';

/** True when a granted-scope list contains `needle`, as a bare name or as the tail of a URL scope (Microsoft returns full URLs). */
export const hasScope = (scopes: string[] | null | undefined, needle: string | undefined): boolean =>
  !!needle && (scopes ?? []).some((s) => s === needle || s.endsWith(`/${needle}`));

/** Header values are attacker-influenced (subjects, addresses): CR/LF would let them inject extra headers. */
export const headerSafe = (s: string): string => s.replace(/\s+/g, ' ').trim(); // \s covers CR, LF and Unicode line separators

export const isEmail = (s: string | undefined): s is string => !!s && /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/.test(s);

/** RFC 2047 encoding for non-ASCII header text. */
export const encodeHeader = (s: string): string => {
  const v = headerSafe(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
};

export const replySubject = (subject: string | null | undefined): string => {
  const s = headerSafe(subject ?? '');
  return /^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
};

/** A plain-text reply as an RFC 822 message (UTF-8, base64 body so line length and encoding are never an issue). */
export function buildMime(h: { to: string[]; subject: string; inReplyTo?: string; references?: string; text: string }): string {
  const lines = [
    `To: ${h.to.map(headerSafe).join(', ')}`,
    `Subject: ${encodeHeader(h.subject)}`,
    ...(h.inReplyTo ? [`In-Reply-To: ${headerSafe(h.inReplyTo)}`] : []),
    ...(h.references ? [`References: ${headerSafe(h.references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(h.text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ];
  return lines.join('\r\n');
}

/** The message we just sent, so it shows up immediately. The provider's own copy later upserts onto the same id. */
export function outboundMessage(a: { channel: string; externalId: string; threadExternalId: string; subject: string | null; to: Party[]; text: string; at?: Date }): NormalizedMessage {
  return {
    externalId: a.externalId,
    threadExternalId: a.threadExternalId,
    subject: a.subject ?? '',
    sender: null,
    recipients: { to: a.to, cc: [] },
    bodyText: a.text,
    bodyHtml: null,
    attachments: [],
    timestamp: a.at ?? new Date(),
    direction: 'outbound',
    isRead: true,
    rawRef: a.externalId,
  };
}
