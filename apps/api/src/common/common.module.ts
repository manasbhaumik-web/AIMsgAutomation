import { Global, Module } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService, ActivityService], exports: [AuditService, ActivityService] })
export class CommonModule {}
