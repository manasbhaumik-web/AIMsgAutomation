import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../common/activity.service';
import { AuditService } from '../common/audit.service';
import { Db, DbCtx } from '../db/db.service';
import { WorkflowDefinition, workflowInput } from '../workflows/workflow.schema';
import { WorkflowsService } from '../workflows/workflows.service';

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';
const RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Teams share things, not data. A team holds people with roles and a library of workflow templates; each member installs
 * a template as their own workflow on their own accounts. Nobody on a team can read another member's messages, drafts,
 * approvals or reports: those stay behind per-user row-level security.
 */
@Injectable()
export class TeamsService {
  constructor(private readonly db: Db, private readonly workflows: WorkflowsService, private readonly activity: ActivityService, private readonly audit: AuditService) {}

  private async myRole(ctx: DbCtx, teamId: string): Promise<TeamRole> {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT team_role($1) AS role', [teamId]))).rows[0]?.role as TeamRole | null;
    if (!r) throw new NotFoundException('Team not found'); // same answer for "does not exist" and "not yours"
    return r;
  }
  private async need(ctx: DbCtx, teamId: string, min: TeamRole): Promise<TeamRole> {
    const role = await this.myRole(ctx, teamId);
    if (RANK[role] < RANK[min]) throw new ForbiddenException(`This needs the ${min} role or higher`);
    return role;
  }

  async list(ctx: DbCtx) {
    return (
      await this.db.tx(ctx, (c) =>
        c.query(`SELECT t.id, t.name, t.created_at, team_role(t.id) AS role, (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS members FROM teams t ORDER BY t.created_at`),
      )
    ).rows;
  }

  async create(ctx: DbCtx, name: string) {
    const id = (await this.db.tx(ctx, (c) => c.query('SELECT create_team($1) AS id', [name]))).rows[0].id as string;
    await this.audit.log(ctx, 'team.create', id);
    await this.activity.log(ctx, { actor: 'user', kind: 'team.create', summary: `Created team "${name}"` });
    return this.get(ctx, id);
  }

  async get(ctx: DbCtx, id: string) {
    const role = await this.myRole(ctx, id);
    const team = (await this.db.tx(ctx, (c) => c.query('SELECT id, name, created_at FROM teams WHERE id = $1', [id]))).rows[0];
    const members = (await this.db.tx(ctx, (c) => c.query('SELECT * FROM team_roster($1)', [id]))).rows;
    const invites = RANK[role] >= RANK.admin ? (await this.db.tx(ctx, (c) => c.query('SELECT id, email, role, created_at, expires_at FROM team_invites WHERE team_id = $1 ORDER BY created_at DESC', [id]))).rows : [];
    return { ...team, role, members, invites };
  }

  async rename(ctx: DbCtx, id: string, name: string) {
    await this.need(ctx, id, 'admin');
    await this.db.tx(ctx, (c) => c.query('UPDATE teams SET name = $2 WHERE id = $1', [id, name]));
    return this.get(ctx, id);
  }

  async remove(ctx: DbCtx, id: string): Promise<void> {
    await this.need(ctx, id, 'owner');
    await this.db.tx(ctx, (c) => c.query('DELETE FROM teams WHERE id = $1', [id]));
    await this.audit.log(ctx, 'team.delete', id);
    await this.activity.log(ctx, { actor: 'user', kind: 'team.delete', summary: 'Deleted a team' });
  }

  async invite(ctx: DbCtx, teamId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const mine = await this.need(ctx, teamId, 'admin');
    if (role === 'admin' && mine !== 'owner') throw new ForbiddenException('Only the owner can invite an admin');
    const r = await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO team_invites(team_id, email, role, invited_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (team_id, email) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, expires_at = now() + interval '14 days'
         RETURNING id, email, role, expires_at`,
        [teamId, email, role, ctx.userId],
      ),
    );
    await this.audit.log(ctx, 'team.invite', teamId, { role }); // never the address: audit meta stays free of personal data
    await this.activity.log(ctx, { actor: 'user', kind: 'team.invite', summary: `Invited someone to a team as ${role}` });
    return r.rows[0]; // the same reply whether or not that address has an account
  }

  async cancelInvite(ctx: DbCtx, teamId: string, inviteId: string): Promise<void> {
    await this.need(ctx, teamId, 'admin');
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM team_invites WHERE id = $1 AND team_id = $2', [inviteId, teamId]));
    if (!r.rowCount) throw new NotFoundException('Invitation not found');
  }

  async myInvites(ctx: DbCtx) {
    return (await this.db.tx(ctx, (c) => c.query('SELECT * FROM my_team_invites()'))).rows;
  }

  async accept(ctx: DbCtx, inviteId: string) {
    const teamId = (await this.db.tx(ctx, (c) => c.query('SELECT accept_team_invite($1) AS id', [inviteId]))).rows[0]?.id as string | null;
    if (!teamId) throw new NotFoundException('Invitation not found or expired');
    await this.activity.log(ctx, { actor: 'user', kind: 'team.join', summary: 'Joined a team' });
    return this.get(ctx, teamId);
  }

  async decline(ctx: DbCtx, inviteId: string): Promise<void> {
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM team_invites WHERE id = $1 AND email = my_email()', [inviteId]));
    if (!r.rowCount) throw new NotFoundException('Invitation not found');
  }

  async setRole(ctx: DbCtx, teamId: string, userId: string, role: 'admin' | 'member' | 'viewer') {
    const mine = await this.need(ctx, teamId, 'admin');
    if (role === 'admin' && mine !== 'owner') throw new ForbiddenException('Only the owner can make someone an admin');
    const r = await this.db.tx(ctx, (c) => c.query('UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2', [teamId, userId, role]));
    if (!r.rowCount) throw new ConflictException('That role change is not allowed');
    await this.audit.log(ctx, 'team.role', teamId, { role });
    return this.get(ctx, teamId);
  }

  /** Members can leave; owners and admins can remove people below them. The owner row can never be removed this way. */
  async removeMember(ctx: DbCtx, teamId: string, userId: string): Promise<void> {
    await this.myRole(ctx, teamId);
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]));
    if (!r.rowCount) throw new ConflictException('That member cannot be removed. The owner must delete the team instead.');
    await this.audit.log(ctx, 'team.member_remove', teamId);
    await this.activity.log(ctx, { actor: 'user', kind: 'team.member_remove', summary: userId === ctx.userId ? 'Left a team' : 'Removed a team member' });
  }

  // ---- shared workflow templates ----
  async templates(ctx: DbCtx, teamId: string) {
    await this.myRole(ctx, teamId);
    return (await this.db.tx(ctx, (c) => c.query('SELECT id, name, description, definition, created_at, updated_at FROM workflow_templates WHERE team_id = $1 ORDER BY name', [teamId]))).rows;
  }

  async saveTemplate(ctx: DbCtx, teamId: string, t: { id?: string; name: string; description: string | null; definition: WorkflowDefinition }) {
    await this.need(ctx, teamId, 'admin');
    if (t.id) {
      const r = await this.db.tx(ctx, (c) =>
        c.query('UPDATE workflow_templates SET name = $3, description = $4, definition = $5, updated_at = now() WHERE id = $1 AND team_id = $2 RETURNING id, name, description, definition', [t.id, teamId, t.name, t.description, JSON.stringify(t.definition)]),
      );
      if (!r.rowCount) throw new NotFoundException('Template not found');
      return r.rows[0];
    }
    return (
      await this.db.tx(ctx, (c) =>
        c.query('INSERT INTO workflow_templates(team_id, name, description, definition, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, definition', [teamId, t.name, t.description, JSON.stringify(t.definition), ctx.userId]),
      )
    ).rows[0];
  }

  async deleteTemplate(ctx: DbCtx, teamId: string, id: string): Promise<void> {
    await this.need(ctx, teamId, 'admin');
    const r = await this.db.tx(ctx, (c) => c.query('DELETE FROM workflow_templates WHERE id = $1 AND team_id = $2', [id, teamId]));
    if (!r.rowCount) throw new NotFoundException('Template not found');
  }

  /**
   * Copies a template into the caller's own workflows, switched off. Installing never carries over "auto": the person
   * re-chooses autonomy for their own accounts, so a team admin cannot turn on automatic sending for someone else.
   */
  async install(ctx: DbCtx, templateId: string) {
    const t = (await this.db.tx(ctx, (c) => c.query('SELECT id, team_id, name, description, definition FROM workflow_templates WHERE id = $1', [templateId]))).rows[0];
    if (!t) throw new NotFoundException('Template not found');
    const parsed = workflowInput.safeParse({ ...t.definition, name: t.name, description: t.description, enabled: false, autonomy: t.definition.autonomy === 'auto' ? 'ask' : t.definition.autonomy });
    if (!parsed.success) throw new ConflictException('This template is not valid any more. Ask a team admin to fix it.');
    return this.workflows.create(ctx, parsed.data, t.id);
  }
}
