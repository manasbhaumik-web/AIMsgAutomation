import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, dbCtx } from '../auth/guards';
import { AuthUser } from '../auth/token.service';
import { ZodPipe } from '../common/zod.pipe';
import { workflowDefinition } from '../workflows/workflow.schema';
import { TeamsService } from './teams.service';

const nameBody = z.object({ name: z.string().trim().min(1).max(80) });
const inviteBody = z.object({ email: z.string().email().max(200), role: z.enum(['admin', 'member', 'viewer']).default('member') });
const roleBody = z.object({ role: z.enum(['admin', 'member', 'viewer']) });
const templateBody = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable().default(null), definition: workflowDefinition });

@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get('teams')
  list(@CurrentUser() u: AuthUser) {
    return this.teams.list(dbCtx(u));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } }) @HttpCode(201) @Post('teams')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(nameBody)) b: z.infer<typeof nameBody>) {
    return this.teams.create(dbCtx(u), b.name);
  }

  @Get('teams/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.teams.get(dbCtx(u), id);
  }

  @Patch('teams/:id')
  rename(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(nameBody)) b: z.infer<typeof nameBody>) {
    return this.teams.rename(dbCtx(u), id, b.name);
  }

  @HttpCode(204) @Delete('teams/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.teams.remove(dbCtx(u), id);
  }

  /** Always answers the same way, whether or not the address belongs to a registered person. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) @HttpCode(201) @Post('teams/:id/invites')
  invite(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(inviteBody)) b: z.infer<typeof inviteBody>) {
    return this.teams.invite(dbCtx(u), id, b.email, b.role);
  }

  @HttpCode(204) @Delete('teams/:id/invites/:inviteId')
  async cancelInvite(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('inviteId', ParseUUIDPipe) inviteId: string) {
    await this.teams.cancelInvite(dbCtx(u), id, inviteId);
  }

  @Patch('teams/:id/members/:userId')
  setRole(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body(new ZodPipe(roleBody)) b: z.infer<typeof roleBody>) {
    return this.teams.setRole(dbCtx(u), id, userId, b.role);
  }

  @HttpCode(204) @Delete('teams/:id/members/:userId')
  async removeMember(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.teams.removeMember(dbCtx(u), id, userId);
  }

  // ---- invitations addressed to me ----
  @Get('team-invites')
  myInvites(@CurrentUser() u: AuthUser) {
    return this.teams.myInvites(dbCtx(u));
  }

  @HttpCode(200) @Post('team-invites/:id/accept')
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.teams.accept(dbCtx(u), id);
  }

  @HttpCode(204) @Post('team-invites/:id/decline')
  async decline(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.teams.decline(dbCtx(u), id);
  }

  // ---- shared workflow templates ----
  @Get('teams/:id/templates')
  templates(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.teams.templates(dbCtx(u), id);
  }

  @HttpCode(201) @Post('teams/:id/templates')
  createTemplate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(templateBody)) b: z.infer<typeof templateBody>) {
    return this.teams.saveTemplate(dbCtx(u), id, b);
  }

  @Put('teams/:id/templates/:templateId')
  updateTemplate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('templateId', ParseUUIDPipe) templateId: string, @Body(new ZodPipe(templateBody)) b: z.infer<typeof templateBody>) {
    return this.teams.saveTemplate(dbCtx(u), id, { ...b, id: templateId });
  }

  @HttpCode(204) @Delete('teams/:id/templates/:templateId')
  async deleteTemplate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('templateId', ParseUUIDPipe) templateId: string) {
    await this.teams.deleteTemplate(dbCtx(u), id, templateId);
  }

  /** Copies a template into my own workflows, switched off. */
  @HttpCode(201) @Post('workflow-templates/:templateId/install')
  install(@CurrentUser() u: AuthUser, @Param('templateId', ParseUUIDPipe) templateId: string) {
    return this.teams.install(dbCtx(u), templateId);
  }
}
