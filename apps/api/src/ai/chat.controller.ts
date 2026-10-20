import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { ChatEvent, ChatService } from './chat.service';
import { DigestService } from './digest.service';

const messageBody = z.object({ content: z.string().trim().min(1).max(2000) });

@Controller('chat/conversations')
export class ChatController {
  constructor(private readonly chat: ChatService, private readonly digests: DigestService) {}

  @Post()
  create(@CurrentUser() u: AuthUser) {
    return this.chat.create(dbCtx(u));
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.chat.list(dbCtx(u));
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.get(dbCtx(u), id);
  }

  @HttpCode(204) @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.chat.remove(dbCtx(u), id);
  }

  /**
   * Server-sent events: `token` (text deltas), `citations`, `done`, or `error`. Consent, ownership and
   * validation errors surface as ordinary HTTP errors because the first event is awaited before headers are sent.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post(':id/messages')
  async ask(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(messageBody)) b: z.infer<typeof messageBody>, @Res() res: Response) {
    const ctx = dbCtx(u);
    const tz = (await this.digests.schedule(ctx)).timezone;
    const it = this.chat.ask(ctx, id, b.content, tz)[Symbol.asyncIterator]();
    let first: IteratorResult<ChatEvent>;
    try {
      first = await it.next();
    } catch (e) {
      await it.return?.(undefined);
      throw e;
    }

    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (ev: ChatEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    try {
      let step = first;
      while (!step.done && !closed) {
        send(step.value);
        step = await it.next();
      }
    } catch {
      if (!closed) send({ type: 'error', code: 'internal', message: 'The assistant stopped unexpectedly. Please try again.' });
    } finally {
      if (closed) await it.return?.(undefined);
      res.end();
    }
  }
}
