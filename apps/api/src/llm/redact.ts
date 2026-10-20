/**
 * Replaces emails, phone numbers and long digit sequences with placeholders before text leaves the system.
 * The mapping stays in memory for the duration of one call so answers can be restored.
 */
export class Redactor {
  private readonly map = new Map<string, string>();
  private readonly counters: Record<string, number> = {};

  private placeholder(kind: string, original: string): string {
    for (const [ph, orig] of this.map) if (orig === original) return ph;
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;
    const ph = `[${kind}_${this.counters[kind]}]`;
    this.map.set(ph, original);
    return ph;
  }

  redact(text: string): string {
    return text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => this.placeholder('EMAIL', m))
      // International numbers (+60 12-345 6789), grouped local numbers (012-345 6789), and long digit runs (IDs, cards).
      // Dates and times such as 2026-10-19 14:02 deliberately do not match.
      .replace(/\+\d[\d\s().-]{6,}\d|\(?\b\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b|\b\d{9,}\b/g, (m) => (m.replace(/\D/g, '').length >= 8 ? this.placeholder('NUMBER', m) : m));
  }

  restore(text: string): string {
    let out = text;
    for (const [ph, orig] of this.map) out = out.split(ph).join(orig);
    return out;
  }
}

/**
 * Restores placeholders in a token stream. A placeholder such as [EMAIL_1] can be split across chunks, so any
 * trailing unclosed "[" fragment is held back until it completes or can no longer be a placeholder.
 */
export class StreamRestorer {
  private held = '';
  constructor(private readonly r: Redactor) {}

  push(chunk: string): string {
    const text = this.held + chunk;
    const open = text.lastIndexOf('[');
    if (open >= 0 && text.indexOf(']', open) < 0 && text.length - open <= 24) {
      this.held = text.slice(open);
      return this.r.restore(text.slice(0, open));
    }
    this.held = '';
    return this.r.restore(text);
  }

  flush(): string {
    const out = this.r.restore(this.held);
    this.held = '';
    return out;
  }
}

/** Fills {{name}} placeholders. Throws on a missing variable so a bad template never reaches the model. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    if (!(key in vars)) throw new Error(`Missing template variable: ${key}`);
    return vars[key];
  });
}
