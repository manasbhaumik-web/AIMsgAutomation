import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { ReportService } from './report.service';

const createBody = z.object({
  kind: z.enum(['inbox', 'actions', 'calendar', 'weekly']).default('weekly'),
  format: z.enum(['pdf', 'docx', 'xlsx']).default('pdf'),
  rangeDays: z.number().int().min(1).max(90).default(7),
  title: z.string().min(1).max(120).optional(),
});

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportService) {}

  @Get('reports')
  list(@CurrentUser() u: AuthUser) {
    return this.reports.list(dbCtx(u));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(201) @Post('reports')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createBody)) b: z.infer<typeof createBody>) {
    return this.reports.generate(dbCtx(u), b);
  }

  /** The file itself. Fetch it with the bearer token; a plain link would not carry it. */
  @Get('reports/:id/download')
  async download(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const r = await this.reports.download(dbCtx(u), id);
    const name = r.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'report';
    res.setHeader('Content-Type', r.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${r.format}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(r.file);
  }

  @HttpCode(204) @Delete('reports/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.reports.remove(dbCtx(u), id);
  }
}
