import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.service';
import { ConsentService } from './consent.service';
import { DigestService } from './digest.service';
import { isValidTimeZone } from './helpers';
import { SummaryService, SummaryTarget } from './summary.service';

const consentBody = z.object({ aiProcessing: z.boolean(), eraseDerived: z.boolean().default(true) });
const scheduleBody = z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23), timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone') });
const summaryBody = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('thread'), threadId: z.string().uuid(), refresh: z.boolean().optional() }),
  z.object({ scope: z.literal('channel'), channel: z.enum(['gmail', 'outlook', 'slack', 'teams', 'whatsapp']).optional(), accountId: z.string().uuid().optional(), days: z.number().int().min(1).max(30).default(7), refresh: z.boolean().optional() }),
  z.object({ scope: z.literal('topic'), topicId: z.string().uuid(), refresh: z.boolean().optional() }),
]);
const digestBody = z.object({}).passthrough();
const itemsQuery = z.object({ status: z.enum(['open', 'done']).default('open') });
const itemPatch = z.object({ done: z.boolean() });

@Controller()
export class AiController {
  constructor(private readonly db: Db, private readonly consent: ConsentService, private readonly summaries: SummaryService, private readonly digests: DigestService) {}

  @Get('me/ai')
  async settings(@CurrentUser() u: AuthUser) {
    return { aiProcessing: await this.consent.has(dbCtx(u)), digest: await this.digests.schedule(dbCtx(u)) };
  }

  /** GDPR/PDPA: AI processing is opt-in, withdrawable at any time, and withdrawal erases derived data by default. */
  @Put('me/consents')
  async setConsent(@CurrentUser() u: AuthUser, @Body(new ZodPipe(consentBody)) b: z.infer<typeof consentBody>) {
    if (b.aiProcessing) await this.consent.grant(dbCtx(u));
    else await this.consent.withdraw(dbCtx(u), b.eraseDerived);
    return { aiProcessing: b.aiProcessing };
  }

  @HttpCode(204) @Delete('me/ai-data')
  async erase(@CurrentUser() u: AuthUser) {
    await this.consent.eraseDerived(dbCtx(u));
  }

  @Put('me/digest-schedule')
  setSchedule(@CurrentUser() u: AuthUser, @Body(new ZodPipe(scheduleBody)) b: z.infer<typeof scheduleBody>) {
    return this.digests.setSchedule(dbCtx(u), b);
  }

  @Get('topics')
  async topics(@CurrentUser() u: AuthUser) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(`SELECT tp.id, tp.name::text AS name, count(tt.thread_id)::int AS threads FROM topics tp JOIN thread_topics tt ON tt.topic_id = tp.id
               GROUP BY tp.id ORDER BY threads DESC, tp.name LIMIT 200`),
    );
    return r.rows;
  }

  @Get('action-items')
  async items(@CurrentUser() u: AuthUser, @Query(new ZodPipe(itemsQuery)) q: z.infer<typeof itemsQuery>) {
    const r = await this.db.tx(dbCtx(u), (c) =>
      c.query(
        `SELECT ai.id, ai.text, ai.due_at, ai.status, ai.thread_id, th.subject FROM action_items ai JOIN threads th ON th.id = ai.thread_id
         WHERE ai.status = $1 ORDER BY ai.due_at NULLS LAST, ai.created_at DESC LIMIT 100`,
        [q.status],
      ),
    );
    return r.rows;
  }

  @Patch('action-items/:id')
  async patchItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(itemPatch)) b: z.infer<typeof itemPatch>) {
    const r = await this.db.tx(dbCtx(u), (c) => c.query('UPDATE action_items SET status = $2 WHERE id = $1 RETURNING id, status', [id, b.done ? 'done' : 'open']));
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  /** Generating costs tokens, so it is a POST with a tight rate limit. Unchanged content returns the cached summary. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Post('summaries')
  summarize(@CurrentUser() u: AuthUser, @Body(new ZodPipe(summaryBody)) b: z.infer<typeof summaryBody>) {
    const target: SummaryTarget =
      b.scope === 'thread' ? { scope: 'thread', threadId: b.threadId } : b.scope === 'topic' ? { scope: 'topic', topicId: b.topicId } : { scope: 'channel', channel: b.channel, accountId: b.accountId, days: b.days };
    return this.summaries.summarize(dbCtx(u), target, b.refresh ?? false);
  }

  @Get('digests/latest')
  latest(@CurrentUser() u: AuthUser) {
    return this.digests.latest(dbCtx(u));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(200) @Post('digests')
  generate(@CurrentUser() u: AuthUser, @Body(new ZodPipe(digestBody)) _b: unknown) {
    return this.digests.generate(dbCtx(u));
  }
}
