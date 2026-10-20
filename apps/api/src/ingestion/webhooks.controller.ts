import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Logger, Post, Query, RawBodyRequest, Req, Res, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/guards';
import { ConnectorRegistry } from '../connectors/registry';
import { Channel, ProviderAuthError, WebhookRequest, WebhookResult } from '../connectors/types';
import { CryptoService } from '../crypto/crypto.service';
import { Db } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { MetricsService } from '../observability/metrics.service';
import { SubscriptionService } from './subscription.service';

/**
 * Provider push endpoints. They are unauthenticated by design, so every request is verified by the connector
 * (token signature or per-account secret) before anything is queued. Work is only enqueued, never done inline.
 */
@Public()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(private readonly registry: ConnectorRegistry, private readonly db: Db, private readonly jobs: JobsService, private readonly subs: SubscriptionService, private readonly crypto: CryptoService, private readonly metrics: MetricsService) {}

  @HttpCode(202) @Post('graph')
  async graph(@Headers() headers: WebhookRequest['headers'], @Query() query: Record<string, string>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    // Mail and calendar notifications share one URL; the subscription id identifies the account (and so the channel).
    const r = await this.process(['outlook', 'microsoft_calendar'], { headers, query, body });
    if (r.response !== undefined) {
      res.status(200).type('text/plain');
      return r.response;
    }
    return '';
  }

  @HttpCode(204) @Post('google-pubsub')
  async pubsub(@Headers() headers: WebhookRequest['headers'], @Body() body: unknown) {
    await this.process(['gmail'], { headers, query: {}, body });
  }

  @HttpCode(204) @Post('google-calendar')
  async gcal(@Headers() headers: WebhookRequest['headers'], @Body() body: unknown) {
    await this.process(['google_calendar'], { headers, query: {}, body });
  }

  @HttpCode(200) @Post('slack')
  async slack(@Req() req: RawBodyRequest<Request>, @Headers() headers: WebhookRequest['headers'], @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.process(['slack'], { headers, query: {}, body, rawBody: req.rawBody });
    if (r.response !== undefined) {
      res.type('text/plain');
      return r.response;
    }
    return '';
  }

  /** Meta subscription handshake. */
  @Get('whatsapp')
  whatsappVerify(@Query() query: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    try {
      const challenge = this.registry.get('whatsapp')?.verifyHandshake?.(query);
      if (challenge === undefined) throw new ForbiddenException();
      res.type('text/plain');
      return challenge;
    } catch {
      throw new ForbiddenException();
    }
  }

  @HttpCode(200) @Post('whatsapp')
  async whatsapp(@Req() req: RawBodyRequest<Request>, @Headers() headers: WebhookRequest['headers'], @Body() body: unknown) {
    await this.process(['whatsapp'], { headers, query: {}, body, rawBody: req.rawBody });
    return '';
  }

  private async process(channels: Channel[], req: WebhookRequest): Promise<{ response?: string }> {
    let result: WebhookResult | undefined;
    let lastError: unknown;
    for (const ch of channels) {
      const connector = this.registry.get(ch);
      if (!connector?.handleWebhook) continue;
      try {
        result = await connector.handleWebhook(req);
        break;
      } catch (e) {
        lastError = e;
        if (e instanceof ProviderAuthError) this.metrics.webhooks.inc({ channel: ch, result: 'rejected' });
      }
    }
    if (!result) {
      if (lastError instanceof ProviderAuthError || !lastError) throw new UnauthorizedException();
      throw lastError;
    }
    this.metrics.webhooks.inc({ channel: channels[0], result: 'accepted' });
    if (result.response !== undefined) return { response: result.response };

    for (const l of result.lookups) {
      for (const ch of channels) {
        const found = l.externalIdPrefix
          ? await this.db.system((c) => c.query('SELECT id FROM sys_find_accounts_prefix($1, $2)', [ch, l.externalIdPrefix]))
          : await this.db.system((c) => c.query('SELECT id FROM sys_find_accounts($1, $2, $3)', [ch, l.externalId ?? null, l.subscriptionId ?? null]));
        for (const row of found.rows) {
          // Push-only channels cannot be re-read from the provider, so the verified content is stored before we answer.
          if (l.payload !== undefined) await this.db.system((c) => c.query('SELECT sys_push_webhook_event($1, $2)', [row.id, this.crypto.encrypt(JSON.stringify(l.payload))]));
          // Subscription-based notifications must echo the secret we generated for that account.
          if (l.subscriptionId && !(l.clientState && this.subs.verifyClientState(row.id, l.clientState))) {
            this.log.warn(`Ignored notification with bad clientState for account ${row.id}`);
            continue;
          }
          await this.jobs.enqueueSync(row.id);
        }
      }
    }
    return {};
  }
}
