import sanitizeHtml from 'sanitize-html';
import { Party } from './types';

/**
 * Allow-list sanitizer for mail HTML. Remote images are removed (tracking pixels, IP leaks); only inline
 * data: images survive. Links keep http(s)/mailto and get rel=noopener nofollow.
 */
export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['a', 'b', 'i', 'em', 'strong', 'u', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'img'],
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }, true) },
    exclusiveFilter: (f) => f.tag === 'img' && !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(f.attribs.src ?? ''),
  });
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n').replace(/<style[\s\S]*?<\/style>/gi, '');
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return stripped.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m).replace(/\n{3,}/g, '\n\n').trim();
}

/** Parses an RFC 5322 address list such as `"Doe, Jane" <j@x.com>, bob@y.com`. */
export function parseAddressList(header: string | undefined | null): Party[] {
  if (!header) return [];
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: Party[] = [];
  for (const p of parts) {
    const m = p.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/) ?? p.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (!m) continue;
    const name = m[1]?.trim();
    out.push({ email: m[2].trim().toLowerCase(), ...(name ? { name } : {}) });
  }
  return out;
}
