import { Controller, Get, Header, Inject, NotFoundException, UnauthorizedException, Headers, Module, Global, Injectable, NestMiddleware } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Public } from '../auth/guards';
import { ENV, Env } from '../config/env';
import { Db } from '../db/db.service';
import { MetricsService } from './metrics.service';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Gives every request an id (echoed in `x-request-id`), records its duration and writes one structured access-log line. */
@Injectable()
export class RequestObservability implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    const id = inbound && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('x-request-id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // The matched route pattern, never the raw URL: ids and tokens in paths and queries stay out of metrics and logs.
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      this.metrics.http.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
      if (!route.endsWith('/metrics') && !route.includes('/health')) {
        process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : 'info', msg: 'http', reqId: id, method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000) })}\n`);
      }
    });
    next();
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(ENV) private readonly env: Env, private readonly metrics: MetricsService, private readonly db: Db) {}

  /**
   * Prometheus scrape target. Disabled (404) unless METRICS_TOKEN is set; then it needs `Authorization: Bearer <token>`.
   * Keep it off the public internet anyway: bind it behind your ingress or scrape it from inside the network.
   */
  @Public() @SkipThrottle() @Get() @Header('content-type', 'text/plain; version=0.0.4')
  async scrape(@Headers('authorization') auth?: string): Promise<string> {
    const token = this.env.METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    const given = Buffer.from((auth ?? '').replace(/^Bearer /i, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new UnauthorizedException();
    await this.refreshGauges();
    return this.metrics.render();
  }

  private async refreshGauges(): Promise<void> {
    try {
      const r = await this.db.system((c) => c.query('SELECT * FROM sys_account_stats()'));
      this.metrics.accounts.reset();
      let oldest = 0;
      for (const row of r.rows) {
        this.metrics.accounts.set({ channel: row.channel, status: row.status }, Number(row.n));
        oldest = Math.max(oldest, Number(row.oldest_sync_age_s ?? 0));
      }
      this.metrics.syncLag.set(oldest);
    } catch {
      // Metrics must never take the endpoint down; stale gauges are better than a failed scrape.
    }
  }
}

@Global()
@Module({ controllers: [MetricsController], providers: [MetricsService, RequestObservability], exports: [MetricsService, RequestObservability] })
export class ObservabilityModule {}
