import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { isValidTimeZone, neutralize, truncate } from '../ai/helpers';
import { ActivityService } from '../common/activity.service';
import { Db, DbCtx } from '../db/db.service';

const policyKey = z.enum(['gmail', 'outlook', 'slack', 'teams', 'whatsapp']);

/** Everything the person says about how they work. Stored as typed columns plus small JSON documents. */
const profileBase = z.object({
    businessRole: z.string().max(120).nullable().default(null),
    businessGoals: z.string().max(1000).nullable().default(null),
    tone: z.string().min(1).max(80).default('neutral'),
    language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en or pt-BR').default('en'),
    signature: z.string().max(500).nullable().default(null),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
    workDays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
    workStart: z.number().int().min(0).max(23).default(9),
    workEnd: z.number().int().min(1).max(24).default(17),
    /** Master switch for automatic sending. Off unless the person turns it on; a workflow must also be set to "auto". */
    autoRepliesEnabled: z.boolean().default(false),
    /** When to involve the person immediately, whatever the schedule says. */
    escalationRules: z
      .object({
        urgentSenders: z.array(z.string().max(200)).max(50).default([]),
        keywords: z.array(z.string().max(60)).max(50).default([]),
        notifyOutsideHours: z.boolean().default(false),
      })
      .default({}),
    /** Per-channel rules for automated replies. */
    responsePolicies: z.record(policyKey, z.object({ allowAuto: z.boolean().default(false), maxPerDay: z.number().int().min(0).max(100).default(10) })).default({}),
    reportPrefs: z.object({ defaultFormat: z.enum(['pdf', 'docx', 'xlsx']).default('pdf'), rangeDays: z.number().int().min(1).max(90).default(7) }).default({}),
  });
export const profileSchema = profileBase.refine((v) => v.workEnd > v.workStart, { message: 'The working day must end after it starts', path: ['workEnd'] });
export type Profile = z.infer<typeof profileSchema>;

const rowToProfile = (r: Record<string, any>): Profile => ({
  businessRole: r.business_role, businessGoals: r.business_goals, tone: r.tone, language: r.language, signature: r.signature, timezone: r.timezone,
  workDays: r.work_days, workStart: r.work_start, workEnd: r.work_end, autoRepliesEnabled: r.auto_replies_enabled,
  escalationRules: profileBase.shape.escalationRules.parse(r.escalation_rules ?? {}),
  responsePolicies: profileBase.shape.responsePolicies.parse(r.response_policies ?? {}),
  reportPrefs: profileBase.shape.reportPrefs.parse(r.report_prefs ?? {}),
});

@Injectable()
export class ProfileService {
  constructor(private readonly db: Db, private readonly activity: ActivityService) {}

  async get(ctx: DbCtx): Promise<Profile> {
    const r = (await this.db.tx(ctx, (c) => c.query('SELECT * FROM user_profiles WHERE user_id = $1', [ctx.userId]))).rows[0];
    return r ? rowToProfile(r) : profileSchema.parse({});
  }

  async save(ctx: DbCtx, p: Profile): Promise<Profile> {
    await this.db.tx(ctx, (c) =>
      c.query(
        `INSERT INTO user_profiles(user_id, tenant_id, business_role, business_goals, tone, language, signature, timezone, work_days, work_start, work_end,
                                   auto_replies_enabled, escalation_rules, response_policies, report_prefs, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         ON CONFLICT (user_id) DO UPDATE SET business_role = EXCLUDED.business_role, business_goals = EXCLUDED.business_goals, tone = EXCLUDED.tone,
           language = EXCLUDED.language, signature = EXCLUDED.signature, timezone = EXCLUDED.timezone, work_days = EXCLUDED.work_days,
           work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end, auto_replies_enabled = EXCLUDED.auto_replies_enabled,
           escalation_rules = EXCLUDED.escalation_rules, response_policies = EXCLUDED.response_policies, report_prefs = EXCLUDED.report_prefs, updated_at = now()`,
        [
          ctx.userId, ctx.tenantId, p.businessRole, p.businessGoals, p.tone, p.language, p.signature, p.timezone, p.workDays, p.workStart, p.workEnd,
          p.autoRepliesEnabled, JSON.stringify(p.escalationRules), JSON.stringify(p.responsePolicies), JSON.stringify(p.reportPrefs),
        ],
      ),
    );
    await this.activity.log(ctx, { actor: 'user', kind: 'profile.update', summary: p.autoRepliesEnabled ? 'Updated preferences (automatic replies allowed)' : 'Updated preferences' });
    return this.get(ctx);
  }

  /** True when `at` falls inside the person's working days and hours, in their time zone. */
  inWorkingHours(p: Profile, at: Date): boolean {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: p.timezone, hourCycle: 'h23', weekday: 'short', hour: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    const hour = Number(parts.hour);
    return p.workDays.includes(day) && hour >= p.workStart && hour < p.workEnd;
  }

  /**
   * One short paragraph for the reply-drafting prompt: who the person is and how they write. It is plain data
   * (neutralized like all other prompt input), never an instruction the model is told to obey over its system rules.
   */
  async promptHints(ctx: DbCtx): Promise<string> {
    // Nothing is assumed for someone who never saved a profile: drafts keep matching the conversation's own language and tone.
    const saved = (await this.db.tx(ctx, (c) => c.query('SELECT 1 FROM user_profiles WHERE user_id = $1', [ctx.userId]))).rowCount;
    if (!saved) return '';
    const p = await this.get(ctx);
    const parts = [
      `Preferred language: ${p.language} (match the conversation if it is clearly in another language).`,
      p.tone && p.tone !== 'neutral' ? `Tone: ${p.tone}.` : '',
      p.businessRole ? `The user's role: ${p.businessRole}.` : '',
      p.signature ? `End with this signature: ${p.signature.replace(/\s+/g, ' ')}` : '',
    ].filter(Boolean);
    return neutralize(truncate(parts.join(' '), 400));
  }
}
