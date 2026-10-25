import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { DemoService } from './demo.service';

const inboundBody = z.object({
  threadId: z.string().uuid().optional(),
  fromName: z.string().min(1).max(80).default('Alex Morgan'),
  fromEmail: z.string().email().max(200).default('alex@example.org'),
  subject: z.string().min(1).max(200).default('Quick question'),
  body: z.string().min(1).max(4000).default('Hi, could you send me an update on this when you get a moment? Thanks.'),
  priority: z.enum(['urgent', 'needs_reply', 'fyi', 'low']).nullable().default('needs_reply'),
});

/** Development helpers; every route answers 404 unless DEMO_MODE=true. */
@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get()
  status() {
    return this.demo.status();
  }

  @HttpCode(200) @Post('seed')
  seed(@CurrentUser() u: AuthUser) {
    return this.demo.seed(dbCtx(u));
  }

  @HttpCode(200) @Post('inbound')
  inbound(@CurrentUser() u: AuthUser, @Body(new ZodPipe(inboundBody)) b: z.infer<typeof inboundBody>) {
    return this.demo.inbound(dbCtx(u), b);
  }

  @Delete()
  clear(@CurrentUser() u: AuthUser) {
    return this.demo.clear(dbCtx(u));
  }
}
