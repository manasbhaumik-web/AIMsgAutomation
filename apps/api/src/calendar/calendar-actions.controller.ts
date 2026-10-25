import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { isValidTimeZone } from '../ai/helpers';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { CalendarActionsService } from './calendar-actions.service';

const suggestBody = z
  .object({
    durationMin: z.number().int().min(15).max(240).default(30),
    days: z.number().int().min(1).max(14).default(7),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
    dayStartHour: z.number().int().min(0).max(23).default(9),
    dayEndHour: z.number().int().min(1).max(24).default(17),
    includeWeekends: z.boolean().default(false),
    bufferMin: z.number().int().min(0).max(120).default(15),
    limit: z.number().int().min(1).max(10).default(5),
    maxPerDay: z.number().int().min(1).max(4).default(2),
  })
  .refine((v) => v.dayEndHour > v.dayStartHour, 'The day must end after it starts');
const respondBody = z.object({ confirm: z.literal(true), response: z.enum(['accept', 'decline', 'tentative']), comment: z.string().max(500).optional() });

const when = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const eventFields = {
  title: z.string().min(1).max(200),
  start: when,
  end: when,
  allDay: z.boolean().optional(),
  timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').optional(),
  location: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  attendees: z.array(z.string().email().max(200)).max(50).optional(),
};
const createBody = z.object({ confirm: z.literal(true), accountId: z.string().uuid().optional(), acceptConflicts: z.boolean().default(false), ...eventFields });
const patchBody = z.object({ confirm: z.literal(true), acceptConflicts: z.boolean().default(false), ...z.object(eventFields).partial().shape });
const cancelBody = z.object({ confirm: z.literal(true) });
const conflictsBody = z.object({ start: when, end: when, excludeEventId: z.string().uuid().optional() });

@Controller()
export class CalendarActionsController {
  constructor(private readonly actions: CalendarActionsService) {}

  /** Read-only: free slots from the user's own calendars. */
  @HttpCode(200) @Post('calendar/suggest-times')
  async suggest(@CurrentUser() u: AuthUser, @Body(new ZodPipe(suggestBody)) b: z.infer<typeof suggestBody>) {
    return { slots: await this.actions.suggestTimes(dbCtx(u), b) };
  }

  /** Read-only: which existing events overlap a proposed time. */
  @HttpCode(200) @Post('calendar/conflicts')
  async conflicts(@CurrentUser() u: AuthUser, @Body(new ZodPipe(conflictsBody)) b: z.infer<typeof conflictsBody>) {
    return { conflicts: await this.actions.conflicts(dbCtx(u), b.start, b.end, b.excludeEventId) };
  }

  /** Creates an event on the user's calendar. `confirm: true` means the user reviewed it; an overlap is refused unless `acceptConflicts`. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(201) @Post('calendar/events')
  async create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createBody)) b: z.infer<typeof createBody>) {
    const { accountId, title, start, end, allDay, timezone, location, description, attendees, acceptConflicts } = b; // `confirm` is the gate, not data
    return this.actions.createEvent(dbCtx(u), { accountId, title, start, end, allDay, timezone, location, description, attendees }, { acceptConflicts, actor: 'user' });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Patch('calendar/events/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchBody)) b: z.infer<typeof patchBody>) {
    const { title, start, end, allDay, timezone, location, description, attendees, acceptConflicts } = b;
    return this.actions.updateEvent(dbCtx(u), id, { title, start, end, allDay, timezone, location, description, attendees }, { acceptConflicts, actor: 'user' });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(204) @Post('calendar/events/:id/cancel')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelBody)) _b: z.infer<typeof cancelBody>) {
    await this.actions.cancelEvent(dbCtx(u), id, { actor: 'user' });
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } }) @HttpCode(204) @Post('events/:id/respond')
  async respond(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(respondBody)) b: z.infer<typeof respondBody>) {
    await this.actions.respond(dbCtx(u), id, { response: b.response, comment: b.comment });
  }
}
