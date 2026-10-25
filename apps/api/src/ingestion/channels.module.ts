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
import { AssistantCommandsController } from '../assistant/assistant-commands.controller';
import { AssistantCommandsService } from '../assistant/assistant-commands.service';
import { DemoController } from '../demo/demo.controller';
import { DemoService } from '../demo/demo.service';
import { ProfileModule } from '../profile/profile.module';
import { ReportService } from '../reports/report.service';
import { ReportsController } from '../reports/reports.controller';
import { TeamsController } from '../teams/teams.controller';
import { TeamsService } from '../teams/teams.service';
import { ApprovalsService } from '../workflows/approvals.service';
import { WorkflowEngine } from '../workflows/engine.service';
import { WorkflowsController } from '../workflows/workflows.controller';
import { WorkflowsService } from '../workflows/workflows.service';

/** Connectors, ingestion and background jobs form one cycle (connect -> enqueue -> sync -> store), so they share a module. */
@Module({
  imports: [AuthModule, AiModule, ProfileModule],
  controllers: [AccountsController, InboxController, WebhooksController, RepliesController, CalendarActionsController, NotificationsController, PrivacyController,
    WorkflowsController, TeamsController, ReportsController, DemoController, AssistantCommandsController],
  providers: [
    ConnectorRegistry, AccountsService, IngestionService, SyncService, SubscriptionService, JobsService, RepliesService, CalendarActionsService, NotificationsService, PrivacyService,
    WorkflowsService, WorkflowEngine, ApprovalsService, TeamsService, ReportService, DemoService, AssistantCommandsService,
    { provide: PUSH, inject: [ENV], useFactory: (env: Env) => FcmPush.fromEnv(env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_JSON) },
  ],
})
export class ChannelsModule {}
