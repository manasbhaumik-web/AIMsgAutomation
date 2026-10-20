import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { DraftService } from '../ai/draft.service';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { RepliesService } from './replies.service';

const saveBody = z.object({ body: z.string().min(1).max(4000) });
const aiBody = z.object({ instructions: z.string().max(500).optional() });
/** `confirm: true` plus the hash of the exact text on screen. Without both, nothing is sent. */
const sendBody = z.object({ confirm: z.literal(true), bodyHash: z.string().regex(/^[0-9a-f]{64}$/), acceptNewMessages: z.boolean().default(false) });

@Controller()
export class RepliesController {
  constructor(private readonly replies: RepliesService, private readonly drafts: DraftService) {}

  @Get('threads/:id/draft')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return { draft: await this.replies.get(dbCtx(u), id) };
  }

  /** The assistant writes a draft. It is only saved; nothing is sent. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Post('threads/:id/draft/ai')
  async ai(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(aiBody)) b: z.infer<typeof aiBody>) {
    const ctx = dbCtx(u);
    await this.drafts.draftReply(ctx, id, b.instructions);
    const draft = await this.replies.get(ctx, id);
    if (!draft) throw new NotFoundException();
    return { draft };
  }

  @Put('threads/:id/draft')
  async save(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(saveBody)) b: z.infer<typeof saveBody>) {
    return { draft: await this.replies.save(dbCtx(u), id, b.body) };
  }

  @HttpCode(204) @Delete('threads/:id/draft')
  async discard(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.replies.discard(dbCtx(u), id);
  }

  @Get('drafts/:id/preview')
  preview(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.replies.preview(dbCtx(u), id);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } }) @HttpCode(200) @Post('drafts/:id/send')
  async send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendBody)) b: z.infer<typeof sendBody>) {
    return { draft: await this.replies.send(dbCtx(u), id, { bodyHash: b.bodyHash, acceptNewMessages: b.acceptNewMessages }) };
  }
}
