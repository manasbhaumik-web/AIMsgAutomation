import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { AccountsService } from './accounts.service';

const startBody = z.object({ redirectUri: z.string().url(), write: z.boolean().default(false) });
const callbackBody = z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(4000) });
const patchBody = z.object({ paused: z.boolean().optional(), backfillDays: z.number().int().min(1).max(365).optional(), aiEnabled: z.boolean().optional() });
const deleteQuery = z.object({ deleteData: z.enum(['true', 'false']).default('false') });

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('channels')
  channels() {
    return this.accounts.channels();
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.accounts.list(u);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Post('callback')
  complete(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callbackBody)) b: z.infer<typeof callbackBody>) {
    return this.accounts.completeConnect(u, b.code, b.state);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Post(':channel/connect')
  async start(@CurrentUser() u: AuthUser, @Param('channel') channel: string, @Body(new ZodPipe(startBody)) b: z.infer<typeof startBody>) {
    return { url: await this.accounts.startConnect(u, channel, b.redirectUri, b.write) };
  }

  @Patch(':id')
  patch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(patchBody)) b: z.infer<typeof patchBody>) {
    return this.accounts.update(u, id, b);
  }

  @HttpCode(204) @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(deleteQuery)) q: z.infer<typeof deleteQuery>) {
    await this.accounts.disconnect(u, id, q.deleteData === 'true');
  }
}
