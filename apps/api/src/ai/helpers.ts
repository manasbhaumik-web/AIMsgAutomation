import { z } from 'zod';

export const PRIORITIES = ['urgent', 'needs_reply', 'fyi', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const truncate = (s: string | null | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Message text goes inside delimiter tags in prompts; stop it from closing them early and impersonating instructions. */
export const neutralize = (s: string): string =>
  s.replace(/<\/?(sources|conversation|thread|content|calendar|new_activity|open_action_items)\b/gi, (m) => m.replace('<', '‹'));

// ---- thread analysis ----------------------------------------------------------------------------------------

const analysisSchema = z.object({
  topics: z.array(z.string()).default([]),
  priority: z.enum(PRIORITIES),
  action_items: z.array(z.object({ text: z.string().min(1), due: z.string().nullable().optional() })).default([]),
});

export interface Analysis {
  topics: string[];
  priority: Priority;
  actionItems: { text: string; due: Date | null }[];
}

/** Extracts and validates the model's JSON. Returns null when it is unusable, so bad output never reaches the database. */
export function parseAnalysis(raw: string): Analysis | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const r = analysisSchema.safeParse(json);
  if (!r.success) return null;
  const seen = new Set<string>();
  const topics = r.data.topics
    .map((t) => t.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter((t) => t.length > 0 && !seen.has(t.toLowerCase()) && !!seen.add(t.toLowerCase()))
    .slice(0, 3);
  const actionItems = r.data.action_items.slice(0, 5).map((a) => ({
    text: a.text.replace(/\s+/g, ' ').trim().slice(0, 300),
    due: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) && !Number.isNaN(Date.parse(`${a.due}T00:00:00Z`)) ? new Date(`${a.due}T00:00:00Z`) : null,
  }));
  return { topics, priority: r.data.priority, actionItems };
}

// ---- retrieval -----------------------------------------------------------------------------------------------

/** Reciprocal rank fusion of several ranked id lists. Higher score = better. */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export const vectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

const STOPWORDS = new Set(
  'the and for are but not you your with that this from have has had was were what when where who whom which how why can could would should did does done about into over after before there their them they then than been being its also any all our out off per via'.split(' '),
);

/**
 * Turns a natural-language question into a match-any full-text query ("invoice | payment | due"). Matching every word
 * (as websearch_to_tsquery does) finds almost nothing for questions; ts_rank then orders by how many words matched.
 * Words are letters/digits only, so the result is safe to pass to to_tsquery.
 */
export function keywordQuery(question: string): string | null {
  const words = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w)))].slice(0, 12);
  return words.length ? words.join(' | ') : null;
}

// ---- citations -----------------------------------------------------------------------------------------------

/** Markers like [M2] and [E1] in the answer, in first-seen order, limited to sources that were actually provided. */
export function extractCitations(answer: string, known: ReadonlySet<string>): string[] {
  const seen: string[] = [];
  for (const m of answer.matchAll(/\[([ME]\d{1,3})\]/g)) if (known.has(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

// ---- time zones ----------------------------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMs(tz: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) in tz. */
export const localDate = (tz: string, at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export const localHour = (tz: string, at: Date): number => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).format(at));

/** UTC instant of local midnight at the start of `at`'s date in tz, DST-safe. */
export function startOfLocalDay(tz: string, at: Date): Date {
  const local = new Date(at.getTime() + offsetMs(tz, at));
  local.setUTCHours(0, 0, 0, 0);
  const guess = new Date(local.getTime() - offsetMs(tz, at));
  return new Date(local.getTime() - offsetMs(tz, guess));
}
