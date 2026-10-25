import { localDate } from '../ai/helpers';

export type ReportKindWord = 'inbox' | 'actions' | 'calendar' | 'weekly';
export type ParsedCommand =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'approvals' }
  | { kind: 'report'; reportKind: ReportKindWord; format: 'pdf' | 'docx' | 'xlsx' | null; rangeDays: number | null }
  | { kind: 'event'; title: string; day: { y: number; m: number; d: number } | null; time: { h: number; min: number } | null; durationMin: number; attendees: string[] };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Calendar date `days` after today, as the wall clock reads in `tz`. */
function dayFrom(now: Date, tz: string, days: number): { y: number; m: number; d: number } {
  const [y, m, d] = localDate(tz, now).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + days));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

function parseDay(t: string, now: Date, tz: string): { y: number; m: number; d: number } | null {
  if (/\bday after tomorrow\b/.test(t)) return dayFrom(now, tz, 2);
  if (/\btomorrow\b/.test(t)) return dayFrom(now, tz, 1);
  if (/\btoday\b/.test(t)) return dayFrom(now, tz, 0);
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const inDays = t.match(/\bin (\d{1,2}) days?\b/);
  if (inDays) return dayFrom(now, tz, +inDays[1]);
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const nowWd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
      const ahead = (i - WEEKDAYS.indexOf(nowWd) + 7) % 7 || 7; // the next one, never today
      return dayFrom(now, tz, ahead);
    }
  }
  return null;
}

function parseTime(t: string): { h: number; min: number } | null {
  if (/\bnoon\b/.test(t)) return { h: 12, min: 0 };
  if (/\bmidnight\b/.test(t)) return { h: 0, min: 0 };
  const m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/) ?? t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/) ?? t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const mer = (m[3] ?? '').replace(/\./g, '');
  if (min > 59 || h > 23) return null;
  if (mer === 'pm' && h < 12) h += 12;
  else if (mer === 'am' && h === 12) h = 0;
  else if (!mer && h >= 1 && h <= 7) h += 12; // "at 3" means mid-afternoon, not 3 in the morning
  return { h, min };
}

function parseDuration(t: string): number {
  if (/\bhalf an hour\b/.test(t)) return 30;
  if (/\b(?:for )?an hour\b/.test(t)) return 60;
  const m = t.match(/\bfor (\d{1,3}(?:\.\d)?)\s*(min(?:ute)?s?|hours?|hrs?|h)\b/) ?? t.match(/\b(\d{1,3}(?:\.\d)?)\s*(min(?:ute)?s?|hours?|hrs?)\b/);
  if (!m) return 30;
  const n = parseFloat(m[1]);
  const mins = /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n);
  return Math.min(480, Math.max(15, mins));
}

function parseEvent(raw: string, t: string, now: Date, tz: string): ParsedCommand {
  const verb = /\b(schedule|propose|set up|setup|add|create|book|plan|arrange)\b/.test(t);
  const noun = t.match(/\b(call|meeting|event|appointment|catch-?up|sync|lunch|coffee)\b/);
  if (!verb || !noun) return { kind: 'none' };
  const attendees = [...new Set((raw.match(EMAIL) ?? []).map((e) => e.toLowerCase()))];
  const quoted = raw.match(/["“]([^"”]{2,100})["”]/);
  const who = raw.replace(EMAIL, '').match(/\bwith\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*)/);
  const base = cap(noun[1].replace('-', ' '));
  const title = quoted ? quoted[1].trim() : who && !/^(an?|the|me|on|at|for|in|next|this|tomorrow|today)$/i.test(who[1].split(/\s+/)[0]) ? `${base} with ${who[1].trim()}` : base;
  return { kind: 'event', title: title.slice(0, 200), day: parseDay(t, now, tz), time: parseTime(t), durationMin: parseDuration(t), attendees };
}

/**
 * Reads a chat message as one of a few fixed commands. This is plain pattern matching, not an AI model: nothing a message
 * or a model says can add a command, and a command can only ask for an approval or build an in-app report.
 */
export function parseCommand(text: string, now = new Date(), tz = 'UTC'): ParsedCommand {
  const raw = text.trim();
  const t = raw.toLowerCase();
  if (!t) return { kind: 'none' };
  if (/^(help|what can you do|what can i ask|commands)\b/.test(t) || /\bwhat can you (do|help)/.test(t)) return { kind: 'help' };
  if (/\b(approvals?|waiting for (my )?approval|needs? my approval|pending requests?)\b/.test(t) && /\b(show|list|what|any|open|my|pending|waiting|check)\b/.test(t) && !/\b(create|build|make|schedule)\b/.test(t)) return { kind: 'approvals' };
  if (/\b(build|make|create|generate|prepare|produce|export|give me)\b/.test(t) && /\b(report|summary|spreadsheet)\b/.test(t)) {
    const reportKind: ReportKindWord = /\baction items?|tasks?|to-?dos?\b/.test(t) ? 'actions' : /\bcalendar|meetings|schedule\b/.test(t) ? 'calendar' : /\binbox|mail|messages?|emails?\b/.test(t) ? 'inbox' : 'weekly';
    const format = /\b(excel|xlsx|spreadsheet)\b/.test(t) ? 'xlsx' : /\b(word|docx)\b/.test(t) ? 'docx' : /\bpdf\b/.test(t) ? 'pdf' : null;
    const n = t.match(/\b(\d{1,4})\s*days?\b/);
    const rangeDays = n ? Math.min(90, Math.max(1, +n[1])) : /\bmonth(ly)?\b/.test(t) ? 30 : /\b(today|daily)\b/.test(t) ? 1 : /\bweek(ly)?\b/.test(t) ? 7 : null;
    return { kind: 'report', reportKind, format, rangeDays };
  }
  return parseEvent(raw, t, now, tz);
}

export const HELP_TEXT = [
  'I can do a few things for you here. Anything that sends or changes something waits for your approval first.',
  '• “Build a weekly report as a PDF” (also Word or Excel; inbox, action items or calendar; “for 14 days”)',
  '• “Schedule a call with Dana on Thursday at 3pm for 30 minutes” (I prepare it; you approve before it is added)',
  '• “Show my approvals” (what is waiting for you)',
  '• Anything else is a normal question about your mail and calendar.',
].join('\n');
