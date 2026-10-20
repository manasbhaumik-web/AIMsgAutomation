import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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

@Controller()
export class CalendarActionsController {
  constructor(private readonly actions: CalendarActionsService) {}

  /** Read-only: free slots from the user's own calendars. */
  @HttpCode(200) @Post('calendar/suggest-times')
  async suggest(@CurrentUser() u: AuthUser, @Body(new ZodPipe(suggestBody)) b: z.infer<typeof suggestBody>) {
    return { slots: await this.actions.suggestTimes(dbCtx(u), b) };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } }) @HttpCode(204) @Post('events/:id/respond')
  async respond(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(respondBody)) b: z.infer<typeof respondBody>) {
    await this.actions.respond(dbCtx(u), id, { response: b.response, comment: b.comment });
  }
}
