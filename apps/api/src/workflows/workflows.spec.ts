import { payloadHash, reasonOf, stableStringify } from './approvals.service';
import { Facts, GateInput, WorkflowEngine, autoSendHold, matchConditions } from './engine.service';
import { policySchema, workflowDefinition, workflowInput } from './workflow.schema';
import { ConflictException } from '@nestjs/common';
import { profileSchema } from '../profile/profile.service';

const facts = (over: Partial<Facts> = {}): Facts => ({ channel: 'gmail', sender: { name: 'Dana Whitfield', email: 'dana@northwind.example' }, subject: 'Invoice 2417 is due', body: 'Please confirm the PO number.', priority: 'needs_reply', topics: ['Invoices'], ...over });

describe('workflow conditions', () => {
  it('no conditions always match', () => expect(matchConditions([], facts())).toBe(true));

  it('every condition must hold', () => {
    expect(matchConditions([{ field: 'channel', op: 'is', value: 'gmail' }, { field: 'subject', op: 'contains', value: 'invoice' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'channel', op: 'is', value: 'gmail' }, { field: 'subject', op: 'contains', value: 'refund' }], facts())).toBe(false);
  });

  it('sender matches the name, the address or the handle, ignoring case', () => {
    expect(matchConditions([{ field: 'sender', op: 'contains', value: 'NORTHWIND' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'sender', op: 'is', value: 'Dana@northwind.example' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'sender', op: 'is', value: 'northwind' }], facts())).toBe(false);
    expect(matchConditions([{ field: 'sender', op: 'is', value: '+6591234567' }], facts({ sender: { handle: '+6591234567' } }))).toBe(true);
    expect(matchConditions([{ field: 'sender', op: 'contains', value: 'x' }], facts({ sender: null }))).toBe(false);
  });

  it('priority and topic need the analysis to exist', () => {
    expect(matchConditions([{ field: 'priority', op: 'is', value: 'needs_reply' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'priority', op: 'is', value: 'urgent' }], facts({ priority: null }))).toBe(false);
    expect(matchConditions([{ field: 'topic', op: 'is', value: 'invoices' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'topic', op: 'contains', value: 'trav' }], facts())).toBe(false);
  });

  it('"is" on text fields is an exact, case-insensitive match', () => {
    expect(matchConditions([{ field: 'subject', op: 'is', value: 'invoice 2417 is due' }], facts())).toBe(true);
    expect(matchConditions([{ field: 'subject', op: 'is', value: 'invoice' }], facts())).toBe(false);
    expect(matchConditions([{ field: 'body', op: 'contains', value: 'po number' }], facts())).toBe(true);
  });
});

describe('automatic sending limits', () => {
  const profile = profileSchema.parse({ autoRepliesEnabled: true, responsePolicies: { gmail: { allowAuto: true, maxPerDay: 3 } } });
  const policy = policySchema.parse({ allowedChannels: ['gmail'], dailyCap: 2, onlyInWorkingHours: true });
  const gate = (over: Partial<GateInput> = {}): GateInput => ({
    serverAllowsAuto: true, policy, profile, channel: 'gmail', priority: 'needs_reply', senderEmail: 'dana@northwind.example', draft: 'Thanks, I will confirm today.',
    inWorkingHours: true, sentByWorkflow24h: 0, sentOnChannel24h: 0, ...over,
  });

  it('allows a send only when every limit is met', () => expect(autoSendHold(gate())).toBeNull());

  it.each([
    ['the operator has not enabled automatic sending', { serverAllowsAuto: false }, /switched off on this server/],
    ['the profile switch is off', { profile: profileSchema.parse({ responsePolicies: { gmail: { allowAuto: true } } }) }, /switched off/],
    ['the channel is not in the workflow policy', { policy: policySchema.parse({ allowedChannels: ['slack'] }) }, /may not send on gmail/],
    ['the profile does not allow the channel', { profile: profileSchema.parse({ autoRepliesEnabled: true }) }, /do not allow automatic replies on gmail/],
    ['the conversation is urgent', { priority: 'urgent' }, /always waits/],
    ['it is outside working hours', { inWorkingHours: false }, /working hours/],
    ['the draft has a placeholder', { draft: 'Send the [PO number] over.' }, /placeholder/],
    ['the draft is very long', { draft: 'x'.repeat(1600) }, /long/],
    ['the workflow cap is reached', { sentByWorkflow24h: 2 }, /limit for the last 24 hours/],
    ['the channel cap is reached', { sentOnChannel24h: 3 }, /on gmail was reached/],
  ] as [string, Partial<GateInput>, RegExp][])('holds the reply back when %s', (_n, over, why) => {
    expect(autoSendHold(gate(over))).toMatch(why);
  });

  it('a sender-domain list limits who may be answered automatically', () => {
    const p = policySchema.parse({ allowedChannels: ['gmail'], allowedSenderDomains: ['northwind.example'] });
    expect(autoSendHold(gate({ policy: p }))).toBeNull();
    expect(autoSendHold(gate({ policy: p, senderEmail: 'eve@evil.example' }))).toMatch(/allowed domain/);
    expect(autoSendHold(gate({ policy: p, senderEmail: undefined }))).toMatch(/allowed domain/);
  });

  it('urgent is blocked by default, even when nothing else is configured', () => {
    expect(policySchema.parse({}).blockPriorities).toEqual(['urgent']);
    expect(policySchema.parse({}).allowedChannels).toEqual([]);
  });
});

describe('workflow definitions', () => {
  const base = { name: 'W', trigger: { type: 'message_received' }, actions: [{ type: 'draft_reply' }, { type: 'send_reply' }] };

  it('defaults are the cautious ones: off, ask first', () => {
    const w = workflowInput.parse(base);
    expect(w).toMatchObject({ enabled: false, autonomy: 'ask', conditions: [] });
  });

  it('"auto" needs allowed channels and a reply to send', () => {
    expect(workflowInput.safeParse({ ...base, autonomy: 'auto' }).success).toBe(false);
    expect(workflowInput.safeParse({ ...base, autonomy: 'auto', policy: { allowedChannels: ['gmail'] } }).success).toBe(true);
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'manual' }, autonomy: 'auto', policy: { allowedChannels: ['gmail'] }, actions: [{ type: 'generate_report' }] }).success).toBe(false);
  });

  it('replying needs a message, and a draft must come before the send', () => {
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'schedule', every: 'day', hour: 8 }, actions: [{ type: 'draft_reply' }] }).success).toBe(false);
    expect(workflowInput.safeParse({ ...base, actions: [{ type: 'send_reply' }, { type: 'draft_reply' }] }).success).toBe(false);
  });

  it('a weekly schedule names its day; hours and time zones are checked', () => {
    const rep = [{ type: 'generate_report' }];
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'schedule', every: 'week', hour: 8 }, actions: rep }).success).toBe(false);
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'schedule', every: 'week', weekday: 1, hour: 8 }, actions: rep }).success).toBe(true);
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'schedule', every: 'day', hour: 24 }, actions: rep }).success).toBe(false);
    expect(workflowInput.safeParse({ name: 'W', trigger: { type: 'schedule', every: 'day', hour: 8, timezone: 'Nowhere/Land' }, actions: rep }).success).toBe(false);
  });

  it('limits the size of what a workflow can hold', () => {
    expect(workflowInput.safeParse({ ...base, conditions: Array.from({ length: 11 }, () => ({ field: 'subject', op: 'contains', value: 'x' })) }).success).toBe(false);
    expect(workflowInput.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(workflowInput.safeParse({ ...base, actions: [{ type: 'create_event', title: 'x', attendees: ['not-an-email'] }] }).success).toBe(false);
  });

  it('a template definition has no name or on/off switch of its own', () => {
    const d = workflowDefinition.parse({ trigger: { type: 'manual' }, actions: [{ type: 'generate_report' }] });
    expect(d).not.toHaveProperty('enabled');
    expect(d.autonomy).toBe('ask');
  });
});

describe('approvals', () => {
  it('hashes the same content the same way, whatever the key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('any change to the content changes the hash', () => {
    expect(payloadHash({ draftId: 'd1', bodyHash: 'x' })).not.toBe(payloadHash({ draftId: 'd1', bodyHash: 'y' }));
    expect(payloadHash({ attendees: ['a'] })).not.toBe(payloadHash({ attendees: ['a', 'b'] }));
    expect(payloadHash({ a: 1 })).toHaveLength(64);
  });

  it('explains a failure in words, never a stack or an internal message', () => {
    expect(reasonOf(new ConflictException({ code: 'x', message: 'Reconnect this calendar first.' }))).toBe('Reconnect this calendar first.');
    expect(reasonOf(new Error('connection string postgres://user:pw@host'))).toBe('An unexpected error stopped this step.');
  });
});

describe('schedules', () => {
  const key = (t: any, at: string) => WorkflowEngine.prototype.scheduleKey.call({}, t, new Date(at));

  it('a daily schedule fires from its hour onward, once per local day', () => {
    const t = { type: 'schedule', every: 'day', hour: 8, timezone: 'UTC' };
    expect(key(t, '2026-10-27T07:59:00Z')).toBeNull();
    expect(key(t, '2026-10-27T08:00:00Z')).toBe('sched-2026-10-27');
    expect(key(t, '2026-10-27T17:30:00Z')).toBe('sched-2026-10-27'); // a missed minute still runs, and the key keeps it to once
    expect(key(t, '2026-10-28T08:00:00Z')).toBe('sched-2026-10-28');
  });

  it('follows the time zone, not the server clock', () => {
    const t = { type: 'schedule', every: 'day', hour: 8, timezone: 'Asia/Singapore' };
    expect(key(t, '2026-10-27T00:00:00Z')).toBe('sched-2026-10-27'); // 08:00 in Singapore
    expect(key(t, '2026-10-26T23:00:00Z')).toBeNull(); // 07:00 in Singapore
  });

  it('other trigger types never schedule', () => {
    expect(key({ type: 'manual' }, '2026-10-27T10:00:00Z')).toBeNull();
    expect(key({ type: 'message_received' }, '2026-10-27T10:00:00Z')).toBeNull();
  });
});
