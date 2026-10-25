import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ActivityService } from '../common/activity.service';
import { ZodPipe } from '../common/zod.pipe';
import { ApprovalsService } from './approvals.service';
import { WorkflowEngine } from './engine.service';
import { WorkflowInput, workflowInput } from './workflow.schema';
import { WorkflowsService } from './workflows.service';

const enabledBody = z.object({ enabled: z.boolean() });
const runBody = z.object({ threadId: z.string().uuid().optional() });
const approveBody = z.object({ payloadHash: z.string().length(64), acceptNewMessages: z.boolean().optional(), acceptConflicts: z.boolean().optional() });
const approvalsQuery = z.object({ status: z.enum(['pending', 'executed', 'rejected', 'expired', 'failed']).optional() });
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional(), kind: z.string().max(40).optional() });

@Controller()
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly engine: WorkflowEngine,
    private readonly approvals: ApprovalsService,
    private readonly activity: ActivityService,
  ) {}

  @Get('workflows')
  list(@CurrentUser() u: AuthUser) {
    return this.workflows.list(dbCtx(u));
  }

  @HttpCode(201) @Post('workflows')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(workflowInput)) b: WorkflowInput) {
    return this.workflows.create(dbCtx(u), b);
  }

  @Get('workflows/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(dbCtx(u), id);
  }

  @Put('workflows/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(workflowInput)) b: WorkflowInput) {
    return this.workflows.update(dbCtx(u), id, b);
  }

  @HttpCode(200) @Post('workflows/:id/enabled')
  setEnabled(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(enabledBody)) b: z.infer<typeof enabledBody>) {
    return this.workflows.setEnabled(dbCtx(u), id, b.enabled);
  }

  @HttpCode(204) @Delete('workflows/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.workflows.remove(dbCtx(u), id);
  }

  /** "Run now": runs once on the chosen conversation, ignoring the conditions. Sends and calendar changes still need approval or the policy. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(200) @Post('workflows/:id/run')
  run(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(runBody)) b: z.infer<typeof runBody>) {
    return this.engine.runManual(dbCtx(u), id, b.threadId);
  }

  @Get('workflows/:id/runs')
  runs(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.runs(dbCtx(u), id);
  }

  // ---- approvals ----
  @Get('approvals')
  listApprovals(@CurrentUser() u: AuthUser, @Query(new ZodPipe(approvalsQuery)) q: z.infer<typeof approvalsQuery>) {
    return this.approvals.list(dbCtx(u), q.status);
  }

  @Get('approvals/:id')
  getApproval(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.view(dbCtx(u), id);
  }

  /** The body must carry the hash the screen showed; if the request changed since, nothing happens. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) @HttpCode(200) @Post('approvals/:id/approve')
  approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(approveBody)) b: z.infer<typeof approveBody>) {
    return this.approvals.approve(dbCtx(u), id, b);
  }

  @HttpCode(200) @Post('approvals/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.reject(dbCtx(u), id);
  }

  // ---- what the system did for me ----
  @Get('activity')
  activityLog(@CurrentUser() u: AuthUser, @Query(new ZodPipe(activityQuery)) q: z.infer<typeof activityQuery>) {
    return this.activity.list(dbCtx(u), q);
  }
}
