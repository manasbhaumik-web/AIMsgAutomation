import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { AssistantCommandsService } from './assistant-commands.service';

const body = z.object({ text: z.string().min(1).max(500) });

@Controller()
export class AssistantCommandsController {
  constructor(private readonly commands: AssistantCommandsService) {}

  /**
   * Chat commands (report, calendar request, approvals list). `handled: false` means "not a command": the client then asks
   * the assistant as a normal question. Commands never send or change anything without an approval.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) @HttpCode(200) @Post('assistant/command')
  run(@CurrentUser() u: AuthUser, @Body(new ZodPipe(body)) b: z.infer<typeof body>) {
    return this.commands.handle(dbCtx(u), b.text);
  }
}
