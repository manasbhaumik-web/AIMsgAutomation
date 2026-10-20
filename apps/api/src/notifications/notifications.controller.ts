import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { isValidTimeZone } from '../ai/helpers';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { MIN_PRIORITIES, NotificationsService } from './notifications.service';

const prefsBody = z.object({
  minPriority: z.enum(MIN_PRIORITIES),
  showPreview: z.boolean(),
  quietStart: z.number().int().min(0).max(23).nullable(),
  quietEnd: z.number().int().min(0).max(23).nullable(),
  timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone'),
});
const deviceBody = z.object({ token: z.string().min(20).max(4096), label: z.string().max(80).optional() });
const readBody = z.object({ ids: z.array(z.number().int().positive()).max(200).optional(), all: z.boolean().optional() }).refine((b) => b.all || b.ids?.length, 'Say which notifications');

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly n: NotificationsService) {}

  @Get()
  feed(@CurrentUser() u: AuthUser) {
    return this.n.feed(dbCtx(u));
  }

  @HttpCode(204) @Post('read')
  async read(@CurrentUser() u: AuthUser, @Body(new ZodPipe(readBody)) b: z.infer<typeof readBody>) {
    await this.n.markRead(dbCtx(u), b.all ? 'all' : b.ids!);
  }

  @Get('settings')
  async settings(@CurrentUser() u: AuthUser) {
    return { prefs: await this.n.prefs(dbCtx(u)), devices: await this.n.devices(dbCtx(u)), pushAvailable: this.n.pushConfigured };
  }

  @Put('settings')
  async setSettings(@CurrentUser() u: AuthUser, @Body(new ZodPipe(prefsBody)) b: z.infer<typeof prefsBody>) {
    return { prefs: await this.n.setPrefs(dbCtx(u), b) };
  }

  /** Mobile apps register their FCM token after sign-in. */
  @HttpCode(200) @Post('devices')
  register(@CurrentUser() u: AuthUser, @Body(new ZodPipe(deviceBody)) b: z.infer<typeof deviceBody>) {
    return this.n.registerDevice(dbCtx(u), b);
  }

  @HttpCode(204) @Delete('devices/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.n.removeDevice(dbCtx(u), id))) throw new NotFoundException();
  }
}
