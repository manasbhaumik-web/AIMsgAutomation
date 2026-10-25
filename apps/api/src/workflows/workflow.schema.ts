import { z } from 'zod';
import { PRIORITIES, isValidTimeZone } from '../ai/helpers';

export const MESSAGE_CHANNELS = ['gmail', 'outlook', 'slack', 'teams', 'whatsapp'] as const;

export const triggerSchema = z.discriminatedUnion('type', [
  /** A new inbound message arrived (after the workflow was enabled) and the thread has been analysed. */
  z.object({ type: z.literal('message_received') }),
  /** Runs at a set hour, daily or weekly, in the given time zone. */
  z.object({
    type: z.literal('schedule'),
    every: z.enum(['day', 'week']),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
  }),
  /** Only runs when the person presses "Run now". */
  z.object({ type: z.literal('manual') }),
]);

export const conditionSchema = z.object({
  field: z.enum(['channel', 'sender', 'subject', 'body', 'priority', 'topic']),
  op: z.enum(['is', 'contains']),
  value: z.string().min(1).max(200),
});

export const actionSchema = z.discriminatedUnion('type', [
  /** AI writes a reply and saves it as a draft (needs the AI switch on). */
  z.object({ type: z.literal('draft_reply'), instructions: z.string().max(500).optional() }),
  /** Sends the thread's open draft: after approval, or on its own only for an "auto" workflow inside its policy. */
  z.object({ type: z.literal('send_reply') }),
  /** Always waits for approval, whatever the autonomy: calendar changes are never automatic. */
  z.object({
    type: z.literal('create_event'),
    title: z.string().min(1).max(200),
    startInHours: z.number().min(0).max(24 * 60).default(24),
    durationMin: z.number().int().min(15).max(480).default(30),
    location: z.string().max(200).optional(),
    attendees: z.array(z.string().email().max(200)).max(20).default([]),
  }),
  z.object({
    type: z.literal('generate_report'),
    kind: z.enum(['inbox', 'actions', 'calendar', 'weekly']).default('weekly'),
    format: z.enum(['pdf', 'docx', 'xlsx']).default('pdf'),
    rangeDays: z.number().int().min(1).max(90).default(7),
  }),
]);

/** Limits that apply to automatic sending (and are shown to the person when they pick "auto"). */
export const policySchema = z
  .object({
    /** Most automatic sends per day for this workflow. */
    dailyCap: z.number().int().min(1).max(50).default(5),
    /** Channels the workflow may send on by itself. Required for "auto". */
    allowedChannels: z.array(z.enum(MESSAGE_CHANNELS)).max(5).default([]),
    /** Threads with these priorities always wait for a person, even in "auto". */
    blockPriorities: z.array(z.enum(PRIORITIES)).max(4).default(['urgent']),
    /** Only send automatically during the person's working hours (from their profile). */
    onlyInWorkingHours: z.boolean().default(true),
    /** When not empty, send automatically only to senders at these domains. */
    allowedSenderDomains: z.array(z.string().min(3).max(100)).max(20).default([]),
  })
  .default({});

const base = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
  enabled: z.boolean().default(false),
  autonomy: z.enum(['suggest', 'ask', 'auto']).default('ask'),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(6),
  policy: policySchema,
});

type Shape = { trigger: z.infer<typeof triggerSchema>; actions: z.infer<typeof actionSchema>[]; autonomy: 'suggest' | 'ask' | 'auto'; policy: z.infer<typeof policySchema> };

/** Rules that tie the parts together: which actions make sense for which trigger, and what "auto" requires. */
function consistent(v: Shape, ctx: z.RefinementCtx): void {
  const needsThread = v.actions.some((a) => a.type === 'draft_reply' || a.type === 'send_reply');
  if (needsThread && v.trigger.type === 'schedule') ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Replying needs a message. Use the "message received" trigger.' });
  const send = v.actions.findIndex((a) => a.type === 'send_reply');
  const draft = v.actions.findIndex((a) => a.type === 'draft_reply');
  if (send >= 0 && draft > send) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Write the draft before sending it.' });
  if (v.autonomy === 'auto' && !v.policy.allowedChannels.length) ctx.addIssue({ code: 'custom', path: ['policy', 'allowedChannels'], message: 'Choose the channels the workflow may send on by itself.' });
  if (v.autonomy === 'auto' && !v.actions.some((a) => a.type === 'send_reply')) ctx.addIssue({ code: 'custom', path: ['autonomy'], message: '"Auto" only matters for workflows that send a reply.' });
  if (v.trigger.type === 'schedule' && v.trigger.every === 'week' && v.trigger.weekday === undefined) ctx.addIssue({ code: 'custom', path: ['trigger', 'weekday'], message: 'Pick the day of the week.' });
}

export const workflowInput = base.superRefine(consistent);
export const workflowDefinition = base.omit({ name: true, description: true, enabled: true }).superRefine(consistent);
export type WorkflowInput = z.infer<typeof workflowInput>;
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export type Action = z.infer<typeof actionSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Trigger = z.infer<typeof triggerSchema>;
