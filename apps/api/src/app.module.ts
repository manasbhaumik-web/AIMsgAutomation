import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard, RolesGuard } from './auth/guards';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { ChannelsModule } from './ingestion/channels.module';
import { LlmModule } from './llm/llm.module';
import { ObservabilityModule, RequestObservability } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule,
    // In-memory counters for now; move to Redis storage before running more than one instance.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DbModule,
    CryptoModule,
    CommonModule,
    ObservabilityModule,
    LlmModule,
    AuthModule,
    AdminModule,
    ChannelsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestObservability).forRoutes('*');
  }
}
