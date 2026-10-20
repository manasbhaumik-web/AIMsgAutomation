import { Module } from '@nestjs/common';
import { CalendarActionsController } from '../calendar/calendar-actions.controller';
import { CalendarActionsService } from '../calendar/calendar-actions.service';
import { AccountsController } from '../connectors/accounts.controller';
import { AccountsService } from '../connectors/accounts.service';
import { ConnectorRegistry } from '../connectors/registry';
import { ENV, Env } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { FcmPush } from '../notifications/fcm';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationsService, PUSH } from '../notifications/notifications.service';
import { PrivacyController } from '../privacy/privacy.controller';
import { PrivacyService } from '../privacy/privacy.service';
import { RepliesController } from '../replies/replies.controller';
import { RepliesService } from '../replies/replies.service';
import { InboxController } from './inbox.controller';
import { IngestionService } from './ingestion.service';
import { SubscriptionService } from './subscription.service';
import { SyncService } from './sync.service';
import { WebhooksController } from './webhooks.controller';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';

/** Connectors, ingestion and background jobs form one cycle (connect -> enqueue -> sync -> store), so they share a module. */
@Module({
  imports: [AuthModule, AiModule],
  controllers: [AccountsController, InboxController, WebhooksController, RepliesController, CalendarActionsController, NotificationsController, PrivacyController],
  providers: [
    ConnectorRegistry, AccountsService, IngestionService, SyncService, SubscriptionService, JobsService, RepliesService, CalendarActionsService, NotificationsService, PrivacyService,
    { provide: PUSH, inject: [ENV], useFactory: (env: Env) => FcmPush.fromEnv(env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_JSON) },
  ],
})
export class ChannelsModule {}
