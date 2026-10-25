import { Injectable } from '@nestjs/common';
import { zonedToUtc } from '../calendar/calendar-actions.service';
import { Db, DbCtx } from '../db/db.service';
import { ProfileService } from '../profile/profile.service';
import { ReportService } from '../reports/report.service';
import { ApprovalsService } from '../workflows/approvals.service';
import { HELP_TEXT, parseCommand } from './commands';

export type Card =
  | { type: 'approval'; approval: Record<string, unknown> }
  | { type: 'report'; report: { id: string; title: string; format: string; size_bytes: number } };
export interface CommandResult {
  handled: boolean;
  reply?: string;
  cards?: Card[];
}

const fmtWhen = (d: Date, tz: string) => d.toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

/**
 * Runs the few chat commands (see commands.ts). It never sends or changes anything outside the app: a calendar request
 * becomes an approval that waits for the person, and a report stays inside the app until they download it.
 */
@Injectable()
export class AssistantCommandsService {
  constructor(private readonly db: Db, private readonly profiles: ProfileService, private readonly approvals: ApprovalsService, private readonly reports: ReportService) {}

  async handle(ctx: DbCtx, text: string, now = new Date()): Promise<CommandResult> {
    const profile = await this.profiles.get(ctx);
    const tz = profile.timezone;
    const cmd = parseCommand(text, now, tz);

    if (cmd.kind === 'none') return { handled: false };
    if (cmd.kind === 'help') return { handled: true, reply: HELP_TEXT };

    if (cmd.kind === 'approvals') {
      const pending = await this.approvals.list(ctx, 'pending');
      if (!pending.length) return { handled: true, reply: 'Nothing is waiting for your approval.' };
      return { handled: true, reply: `${pending.length} request${pending.length === 1 ? ' is' : 's are'} waiting for you. Nothing has happened yet.`, cards: pending.map((a) => ({ type: 'approval' as const, approval: a })) };
    }

    if (cmd.kind === 'report') {
      const r = await this.reports.generate(ctx, { kind: cmd.reportKind, format: cmd.format ?? profile.reportPrefs.defaultFormat, rangeDays: cmd.rangeDays ?? profile.reportPrefs.rangeDays });
      return { handled: true, reply: `I built “${r.title}”. It stays in the app until you download it; nothing was sent anywhere.`, cards: [{ type: 'report', report: r }] };
    }

    // event
    const missing = [!cmd.day && 'which day', !cmd.time && 'what time'].filter(Boolean) as string[];
    if (missing.length) return { handled: true, reply: `I can prepare “${cmd.title}”, but I need ${missing.join(' and ')}. For example: “Schedule a call with Dana on Thursday at 3pm for 30 minutes”.` };
    const start = zonedToUtc(cmd.day!.y, cmd.day!.m, cmd.day!.d, cmd.time!.h, cmd.time!.min, tz);
    if (start.getTime() <= now.getTime()) return { handled: true, reply: `That time has already passed (${fmtWhen(start, tz)}). Give me a later day or time.` };
    const end = new Date(start.getTime() + cmd.durationMin * 60_000);
    const payload = { title: cmd.title, start: start.toISOString(), end: end.toISOString(), timezone: tz, location: null, attendees: cmd.attendees };
    const row = await this.approvals.create(ctx, { workflowId: null, runId: null, kind: 'create_event', summary: `Create the event "${cmd.title}" on ${fmtWhen(start, tz)}`, payload });
    return {
      handled: true,
      reply: `I prepared this for your approval. Nothing is added to your calendar until you press Approve.${cmd.attendees.length ? ` Your calendar will email ${cmd.attendees.join(', ')} once you approve.` : ''}`,
      cards: [{ type: 'approval', approval: { ...row, error: null, workflow_name: 'Assistant' } }],
    };
  }
}
