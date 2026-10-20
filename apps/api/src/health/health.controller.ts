import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/guards';
import { Db } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Db) {}

  @Public() @Get()
  live() {
    return { status: 'ok' };
  }

  @Public() @Get('ready')
  async ready() {
    try {
      await this.db.system((c) => c.query('SELECT 1'));
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
