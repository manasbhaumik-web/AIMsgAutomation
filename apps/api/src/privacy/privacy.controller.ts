import { Body, Controller, Get, HttpCode, Delete, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { PrivacyService } from './privacy.service';

const deleteBody = z.object({ confirmEmail: z.string().email().max(254), password: z.string().max(200).optional() });

@Controller('me')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** GDPR Art. 15/20 and PDPA access: everything we hold about you, as newline-delimited JSON. Provider tokens are not included. */
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) @Get('export')
  async export(@CurrentUser() u: AuthUser, @Res() res: Response): Promise<void> {
    const it = this.privacy.export(dbCtx(u));
    // Pull the first line before sending headers so an early failure is a normal error response.
    const first = await it.next();
    res.status(200).set({ 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': 'attachment; filename="inbox-export.ndjson"', 'cache-control': 'no-store' });
    let aborted = false;
    res.on('close', () => { aborted = true; });
    let cur = first;
    while (!cur.done && !aborted) {
      if (!res.write(`${JSON.stringify(cur.value)}\n`)) await new Promise((r) => res.once('drain', r));
      cur = await it.next();
    }
    if (aborted) await it.return(undefined);
    res.end();
  }

  /** Erasure. Needs the account email typed again, and the password for accounts that have one. */
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } }) @HttpCode(204) @Delete()
  async remove(@CurrentUser() u: AuthUser, @Body(new ZodPipe(deleteBody)) b: z.infer<typeof deleteBody>): Promise<void> {
    await this.privacy.deleteAccount(dbCtx(u), b.confirmEmail, b.password);
  }
}
