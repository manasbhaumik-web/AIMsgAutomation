// Phase 7 end to end on embedded Postgres, as the restricted role: profile, teams, workflows with approvals and limited
// auto-send, calendar writes, reports, schedules, and isolation between people.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { createHash, randomBytes } from 'crypto';

const ROOT = process.argv[2] ?? process.cwd();
const require = createRequire(ROOT + '/apps/api/package.json');
require('reflect-metadata');
const dist = (p) => require(`${ROOT}/apps/api/dist/${p}`);
const { RepliesService } = dist('replies/replies.service.js');
const { DraftService } = dist('ai/draft.service.js');
const { ConsentService } = dist('ai/consent.service.js');
const { CalendarActionsService } = dist('calendar/calendar-actions.service.js');
const { IngestionService } = dist('ingestion/ingestion.service.js');
const { SyncService } = dist('ingestion/sync.service.js');
const { AuditService } = dist('common/audit.service.js');
const { ActivityService } = dist('common/activity.service.js');
const { CryptoService } = dist('crypto/crypto.service.js');
const { ProfileService, profileSchema } = dist('profile/profile.service.js');
const { WorkflowsService } = dist('workflows/workflows.service.js');
const { WorkflowEngine } = dist('workflows/engine.service.js');
const { ApprovalsService } = dist('workflows/approvals.service.js');
const { workflowInput, workflowDefinition } = dist('workflows/workflow.schema.js');
const { TeamsService } = dist('teams/teams.service.js');
const { ReportService } = dist('reports/report.service.js');

const db = new PGlite({ extensions: { citext, vector } });
await db.exec(`CREATE ROLE inbox_app LOGIN NOSUPERUSER NOBYPASSRLS;`);
for (const f of readdirSync(`${ROOT}/apps/api/migrations`).sort()) await db.exec(readFileSync(`${ROOT}/apps/api/migrations/${f}`, 'utf8'));

let txQueue = Promise.resolve();
const fakeDb = {
  tx(ctx, fn) {
    const run = async () => {
      await db.exec('BEGIN');
      try {
        await db.exec('SET LOCAL ROLE inbox_app');
        await db.query(`SELECT set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true), set_config('app.role',$3,true), set_config('app.tenant_role',$4,true)`,
          [ctx.userId ?? '', ctx.tenantId ?? '', ctx.role ?? '', ctx.tenantRole ?? '']);
        const client = { query: async (sql, params) => { const r = await db.query(sql, params); const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v]))); return { rows, rowCount: r.affectedRows || rows.length }; } };
        const out = await fn(client);
        await db.exec('COMMIT');
        return out;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    };
    const p = txQueue.then(run, run); txQueue = p.catch(() => {}); return p;
  },
  system(fn) { return this.tx({}, fn); },
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + extra)); };
const codeOf = (e) => e?.getResponse?.()?.code ?? e?.status ?? e?.message;
const rejects = async (p, code) => { try { await p; return false; } catch (e) { return code === undefined || codeOf(e) === code || e.constructor?.name === code; } };
const sha = (s) => createHash('sha256').update(s).digest('hex');

const crypto = new CryptoService({ MASTER_KEY: randomBytes(32).toString('base64') });
const audit = new AuditService(fakeDb);
const activity = new ActivityService(fakeDb);
const profiles = new ProfileService(fakeDb, activity);

// --- fake connectors: every outward call is recorded
const sends = [];
const calls = { create: [], update: [], cancel: [] };
const normEvent = (id, e) => ({ externalId: id, title: e.title ?? 't', start: e.start, end: e.end, allDay: false, timezone: 'UTC', organizer: null, attendees: [], location: e.location ?? null, meetingLink: null, status: 'confirmed' });
const connectors = {
  gmail: { id: 'gmail', writeScope: 'gmail.send', refreshToken: async (t) => t, sendReply: async (a, req) => { sends.push(req); const id = 'sent-' + sends.length; return { externalId: id, message: { externalId: id, threadExternalId: req.threadExternalId, subject: '', sender: null, recipients: { to: req.to, cc: [] }, bodyText: req.text, bodyHtml: null, attachments: [], timestamp: new Date(), direction: 'outbound', isRead: true, rawRef: id } }; } },
  google_calendar: {
    id: 'google_calendar', writeScope: 'calendar.events', refreshToken: async (t) => t,
    createEvent: async (a, e) => { calls.create.push(e); const id = 'ev-' + calls.create.length; return { externalId: id, event: normEvent(id, e) }; },
    updateEvent: async (a, id, p) => { calls.update.push({ id, p }); return { externalId: id, event: null }; },
    cancelEvent: async (a, id) => { calls.cancel.push(id); },
  },
};
const registry = { get: (c) => connectors[c] };
const ingestion = new IngestionService(fakeDb);
const sync = new SyncService(fakeDb, crypto, registry, ingestion);
const replies = new RepliesService(fakeDb, registry, sync, ingestion, audit);
const consent = new ConsentService(fakeDb, audit);
const gatewayCalls = [];
let draftText = 'Thanks, I will get back to you today.';
const gateway = { run: async (_c, task, vars) => { gatewayCalls.push({ task, vars }); return { text: draftText, model: 'm1', promptVersion: 1 }; } };
const drafts = new DraftService(fakeDb, gateway, consent, profiles);
const calendar = new CalendarActionsService(fakeDb, registry, sync, audit, ingestion, activity);
const approvals = new ApprovalsService(fakeDb, replies, calendar, activity, audit);
const reports = new ReportService(fakeDb, crypto, audit, activity, { REPORT_MAX_MB: 10 });
const workflows = new WorkflowsService(fakeDb, activity);
const env = { AUTO_SEND_ENABLED: 'false', REPORT_MAX_MB: 10 };
const engine = new WorkflowEngine(fakeDb, drafts, replies, approvals, reports, profiles, activity, audit, env);
const teams = new TeamsService(fakeDb, workflows, activity, audit);

const mkUser = async (label) => {
  const id = (await db.query(`SELECT auth_create_user($1,$2,NULL,'user') AS id`, [`${label}@t.local`, label])).rows[0].id;
  const m = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [id])).rows[0];
  return { id, userId: id, tenantId: m.tenant_id, role: 'user', tenantRole: 'tenant_admin' };
};
const alice = await mkUser('alice'), bob = await mkUser('bob'), carol = await mkUser('carol');
const tokens = Buffer.from(crypto.encrypt(JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 })));
const mkAccount = async (u, channel, ext, scopes) => (await db.query(
  `INSERT INTO connected_accounts(tenant_id,user_id,channel,external_id,enc_tokens,scopes,sync_cursor) VALUES ($1,$2,$3,$4,$5,$6,'C0') RETURNING id`, [u.tenantId, u.id, channel, ext, tokens, scopes])).rows[0].id;
const ago = (min) => new Date(Date.now() - min * 60_000);
let n = 0;
const mkThread = async (u, acct, subject, text, { sender = { email: 'client@acme.com', name: 'Client' }, priority = 'needs_reply', at = ago(10) } = {}) => {
  const t = (await db.query(`INSERT INTO threads(tenant_id,user_id,account_id,channel,external_id,subject,last_message_at) VALUES ($1,$2,$3,'gmail',$4,$5,$6) RETURNING id`, [u.tenantId, u.id, acct, `th${++n}`, subject, at])).rows[0].id;
  await db.query(`INSERT INTO messages(tenant_id,user_id,account_id,thread_id,channel,external_id,sender,subject,body_text,"timestamp",direction) VALUES ($1,$2,$3,$4,'gmail',$5,$6,$7,$8,$9,'inbound')`, [u.tenantId, u.id, acct, t, `m${++n}`, JSON.stringify(sender), subject, text, at]);
  if (priority) await db.query(`INSERT INTO thread_analysis(thread_id,tenant_id,user_id,priority,status,analyzed_through) VALUES ($1,$2,$3,$4,'done',$5)`, [t, u.tenantId, u.id, priority, at]);
  return t;
};
const aGmail = await mkAccount(alice, 'gmail', 'alice@gmail.com', ['openid', 'gmail.send']);
const aCal = await mkAccount(alice, 'google_calendar', 'alice@gmail.com', ['calendar.events']);
const bCalRO = await mkAccount(bob, 'google_calendar', 'bob@gmail.com', ['calendar.readonly']);
await consent.grant(alice);

const wf = (over = {}) => workflowInput.parse({ name: 'WF', enabled: true, autonomy: 'ask', trigger: { type: 'message_received' }, conditions: [], actions: [{ type: 'draft_reply' }, { type: 'send_reply' }], ...over });
const mkWf = async (u, over) => { const w = await workflows.create(u, wf(over)); await db.query(`UPDATE workflows SET scan_from = now() - interval '2 hours' WHERE id = $1`, [w.id]); return w; };
const runsOf = async (id) => (await db.query(`SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at`, [id])).rows;
const pending = async (u) => (await approvals.list(u, 'pending'));

// ============================ profile and preferences
ok('a new person has safe defaults (no automatic replies)', (await profiles.get(alice)).autoRepliesEnabled === false && (await profiles.get(alice)).tone === 'neutral');
ok('a working day that ends before it starts is refused', !profileSchema.safeParse({ workStart: 17, workEnd: 9 }).success);
ok('an unknown time zone is refused', !profileSchema.safeParse({ timezone: 'Mars/Base' }).success);
ok('no profile means no drafting hints (drafts keep matching the conversation)', (await profiles.promptHints(alice)) === '');
const t0 = await mkThread(alice, aGmail, 'Hints', 'Hello there', { priority: null, sender: { email: 'hints@other.org' }, at: ago(300) });
await profiles.save(alice, profileSchema.parse({ language: 'pt-BR', tone: 'warm and concise', businessRole: 'Founder', signature: 'Alice', timezone: 'UTC', workStart: 0, workEnd: 24 }));
ok('a saved profile round-trips', (await profiles.get(alice)).language === 'pt-BR' && (await profiles.get(alice)).businessRole === 'Founder');
await drafts.draftReply(alice, t0, 'Be brief');
const hint = gatewayCalls.at(-1).vars.instructions;
ok('drafting uses the saved language, tone, role and signature plus the guidance for this reply', /pt-BR/.test(hint) && /warm and concise/.test(hint) && /Founder/.test(hint) && /Be brief/.test(hint), hint);
ok("bob's profile is his own", (await profiles.get(bob)).language === 'en' && (await db.query(`SELECT count(*)::int n FROM user_profiles`)).rows[0].n === 1);

// ============================ teams
const team = await teams.create(alice, 'Sales');
ok('creating a team makes the creator its owner', team.role === 'owner' && team.members.length === 1);
ok('outsiders do not see the team', (await teams.list(carol)).length === 0 && (await rejects(teams.get(carol, team.id), 'NotFoundException')));
const unknown = await teams.invite(alice, team.id, 'nobody@t.local', 'member');
ok('inviting an address with no account works the same way (no way to learn who is registered)', !!unknown.id);
const invBob = await teams.invite(alice, team.id, 'bob@t.local', 'member');
const mine = await teams.myInvites(bob);
ok('the invited person sees the invitation with the team name', mine.length === 1 && mine[0].team_name === 'Sales' && (await teams.myInvites(carol)).length === 0);
ok("someone else cannot accept another person's invitation", await rejects(teams.accept(carol, invBob.id), 'NotFoundException'));
const joined = await teams.accept(bob, invBob.id);
ok('accepting joins as the invited role and the roster shows names', joined.role === 'member' && joined.members.some((m) => m.name === 'alice') && joined.members.some((m) => m.name === 'bob'));
ok('a member cannot invite, rename or delete', (await rejects(teams.invite(bob, team.id, 'x@t.local', 'member'), 'ForbiddenException')) && (await rejects(teams.rename(bob, team.id, 'X'), 'ForbiddenException')) && (await rejects(teams.remove(bob, team.id), 'ForbiddenException')));
await teams.setRole(alice, team.id, bob.id, 'admin');
ok('an admin cannot create another admin', await rejects(teams.invite(bob, team.id, 'carol@t.local', 'admin'), 'ForbiddenException'));
const invCarol = await teams.invite(bob, team.id, 'carol@t.local', 'viewer');
ok('an admin can invite members and viewers', !!invCarol.id);
ok('nobody can demote or remove the owner', (await rejects(teams.setRole(bob, team.id, alice.id, 'member'), 'ConflictException')) && (await rejects(teams.removeMember(bob, team.id, alice.id), 'ConflictException')));
const def = workflowDefinition.parse({ autonomy: 'auto', trigger: { type: 'message_received' }, conditions: [], actions: [{ type: 'draft_reply' }, { type: 'send_reply' }], policy: { allowedChannels: ['gmail'] } });
const tpl = await teams.saveTemplate(alice, team.id, { name: 'Auto reply', description: null, definition: def });
ok('a viewer can read templates but not write them', (await teams.templates(carol, team.id).catch(() => 'blocked')) === 'blocked' /* not joined yet */);
await teams.accept(carol, invCarol.id);
ok('a viewer reads the shared templates but cannot add one', (await teams.templates(carol, team.id)).length === 1 && (await rejects(teams.saveTemplate(carol, team.id, { name: 'x', description: null, definition: def }), 'ForbiddenException')));
const installed = await teams.install(bob, tpl.id);
ok('installing copies the template as a switched-off workflow and never carries "auto" over', installed.enabled === false && installed.autonomy === 'ask' && installed.template_id === tpl.id);
const outsider = await mkUser('dave');
ok('a non-member cannot install a team template', await rejects(teams.install(outsider, tpl.id), 'NotFoundException'));
ok("a team admin sees nothing of a member's own workflows", (await workflows.list(alice)).length === 0 && (await workflows.list(bob)).length === 1);
await teams.removeMember(carol, team.id, carol.id);
ok('a member can leave', (await teams.list(carol)).length === 0);
await teams.remove(alice, team.id);
ok('the owner can delete the team; installed copies stay with their owners', (await teams.list(bob)).length === 0 && (await workflows.list(bob)).length === 1);

// ============================ workflows: ask, approvals
const wAsk = await mkWf(alice, { name: 'Reply to clients', conditions: [{ field: 'sender', op: 'contains', value: 'acme.com' }] });
const tA = await mkThread(alice, aGmail, 'Invoice 42', 'Can you confirm the PO number?');
await mkThread(alice, aGmail, 'Newsletter', 'Weekly digest', { sender: { email: 'news@other.org' } });
await engine.scanAccount(aGmail);
let runs = await runsOf(wAsk.id);
ok('a matching message starts exactly one run; a non-matching one starts none', runs.length === 1 && runs[0].thread_id === tA, JSON.stringify(runs.map((r) => r.status)));
ok('"ask" writes an AI draft and files an approval; nothing is sent', sends.length === 0 && runs[0].status === 'waiting_approval' && (await pending(alice)).length === 1 && (await db.query(`SELECT source FROM reply_drafts WHERE thread_id=$1`, [tA])).rows[0].source === 'ai');
await engine.scanAccount(aGmail);
ok('scanning again does not run it twice', (await runsOf(wAsk.id)).length === 1);
const ap = (await pending(alice))[0];
ok('a wrong hash cannot approve', (await rejects(approvals.approve(alice, ap.id, { payloadHash: sha('nope') }), 'approval_changed')) && sends.length === 0);
ok('bob cannot see or approve it', (await approvals.list(bob)).length === 0 && (await rejects(approvals.approve(bob, ap.id, { payloadHash: ap.payload_hash }), 'NotFoundException')));
const shown = await approvals.view(alice, ap.id);
ok('the review screen shows the live draft and who it goes to', shown.draft?.canSend === true && shown.draft.to[0].email === 'client@acme.com' && shown.payloadHash === ap.payload_hash);
const done = await approvals.approve(alice, ap.id, { payloadHash: ap.payload_hash });
ok('approving sends exactly that draft once and closes the run', sends.length === 1 && sends[0].text === draftText && done.status === 'executed' && (await runsOf(wAsk.id))[0].status === 'done');
ok('approving twice does nothing more', (await rejects(approvals.approve(alice, ap.id, { payloadHash: ap.payload_hash }), 'not_pending')) && sends.length === 1);
ok('the activity log records the draft path in plain words', (await activity.list(alice, { limit: 50 })).some((a) => a.kind === 'approval.approve' && !a.summary.includes(draftText)));

// reject path and stale approvals
const tB = await mkThread(alice, aGmail, 'Quote 7', 'Please send a quote.');
await engine.scanAccount(aGmail);
const ap2 = (await pending(alice))[0];
const rejected = await approvals.reject(alice, ap2.id);
ok('declining sends nothing and closes the run', rejected.status === 'rejected' && sends.length === 1 && (await runsOf(wAsk.id)).at(-1).status === 'done');
const tC = await mkThread(alice, aGmail, 'Contract', 'Please review.');
await engine.scanAccount(aGmail);
const ap3 = (await pending(alice))[0];
await db.query(`UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ap3.id]);
ok('an expired approval cannot be used', await rejects(approvals.approve(alice, ap3.id, { payloadHash: ap3.payload_hash }), 'expired'));
await db.query('SELECT sys_expire_approvals()');
ok('the tick closes approvals nobody decided in time', (await approvals.list(alice, 'expired')).length >= 1 && (await pending(alice)).length === 0);
await workflows.setEnabled(alice, wAsk.id, false);

// ============================ workflows: suggest, and a person's own draft is never touched
const wSug = await mkWf(alice, { name: 'Suggest', autonomy: 'suggest' });
const tD = await mkThread(alice, aGmail, 'Hello', 'Are you free this week?');
const before = sends.length;
await engine.scanAccount(aGmail);
const sugRun = (await runsOf(wSug.id)).find((r) => r.thread_id === tD);
ok('"suggest" leaves a draft and asks for nothing', sugRun?.status === 'done' && (await pending(alice)).length === 0 && sends.length === before && sugRun.steps.some((s) => s.status === 'skipped'));
await workflows.setEnabled(alice, wSug.id, false);
const tE = await mkThread(alice, aGmail, 'My own draft', 'Thoughts?');
await replies.save(alice, tE, 'My own half-written reply');
const wOwn = await mkWf(alice, { name: 'Own', autonomy: 'ask' });
await engine.scanAccount(aGmail);
ok('a draft the person wrote is left alone', (await db.query(`SELECT body, source FROM reply_drafts WHERE thread_id=$1 AND status='draft'`, [tE])).rows[0].body === 'My own half-written reply');
await workflows.setEnabled(alice, wOwn.id, false);

// ============================ workflows: auto-send and its limits
const wAuto = await mkWf(alice, { name: 'Auto', autonomy: 'auto', policy: { allowedChannels: ['gmail'], dailyCap: 1, onlyInWorkingHours: false } });
const holdReason = async (wfid) => (await runsOf(wfid)).at(-1).steps.find((s) => s.action === 'send_reply')?.message ?? '';
const tF = await mkThread(alice, aGmail, 'Auto 1', 'Quick question one.');
const s0 = sends.length;
await engine.scanAccount(aGmail);
ok('with automatic replies off in the profile, "auto" falls back to an approval', sends.length === s0 && /switched off/i.test(await holdReason(wAuto.id)) && (await pending(alice)).some((a) => a.workflow_id === wAuto.id));
for (const a of await pending(alice)) await approvals.reject(alice, a.id);
await profiles.save(alice, profileSchema.parse({ language: 'en', tone: 'neutral', timezone: 'UTC', workStart: 0, workEnd: 24, autoRepliesEnabled: true, responsePolicies: { gmail: { allowAuto: true, maxPerDay: 5 } } }));
// the server-level switch is off by default: even with the profile and policy allowing it, nothing sends by itself
const tOff = await mkThread(alice, aGmail, 'Auto off', 'Quick question zero.');
await engine.scanAccount(aGmail);
ok('with the server switch off, "auto" still only files an approval', sends.length === s0 && /switched off on this server/i.test(await holdReason(wAuto.id)));
for (const a of await pending(alice)) await approvals.reject(alice, a.id);
env.AUTO_SEND_ENABLED = 'true';
const tG = await mkThread(alice, aGmail, 'Auto 2', 'Quick question two.');
await engine.scanAccount(aGmail);
ok('with the profile, policy and channel all allowing it, the reply goes out by itself', sends.length === s0 + 1 && (await runsOf(wAuto.id)).at(-1).status === 'done' && (await activity.list(alice, { limit: 80 })).some((a) => a.kind === 'workflow.auto_send'), `${sends.length} ${s0}`);
const tH = await mkThread(alice, aGmail, 'Auto 3', 'Quick question three.');
await engine.scanAccount(aGmail);
ok("the workflow's daily cap sends the next one to approval instead", sends.length === s0 + 1 && /limit/i.test(await holdReason(wAuto.id)));
for (const a of await pending(alice)) await approvals.reject(alice, a.id);
await db.query(`UPDATE workflows SET policy = jsonb_set(policy, '{dailyCap}', '50') WHERE id = $1`, [wAuto.id]);
const tU = await mkThread(alice, aGmail, 'Urgent thing', 'This is urgent!', { priority: 'urgent' });
await engine.scanAccount(aGmail);
ok('urgent conversations always wait for a person', /always waits/i.test(await holdReason(wAuto.id)) && sends.length === s0 + 1);
for (const a of await pending(alice)) await approvals.reject(alice, a.id);
draftText = 'Please send the [PO number] over.';
const tP = await mkThread(alice, aGmail, 'Placeholder', 'Quick question four.');
await engine.scanAccount(aGmail);
ok('a draft with a [placeholder] is never sent automatically', /placeholder/i.test(await holdReason(wAuto.id)) && sends.length === s0 + 1);
draftText = 'Thanks, I will get back to you today.';
for (const a of await pending(alice)) await approvals.reject(alice, a.id);
await workflows.setEnabled(alice, wAuto.id, false);
ok('"auto" without allowed channels is refused when the workflow is saved', !workflowInput.safeParse({ name: 'x', autonomy: 'auto', trigger: { type: 'message_received' }, actions: [{ type: 'draft_reply' }, { type: 'send_reply' }] }).success);
ok('a reply action on a schedule trigger is refused', !workflowInput.safeParse({ name: 'x', trigger: { type: 'schedule', every: 'day', hour: 8 }, actions: [{ type: 'draft_reply' }] }).success);

// mail that arrived before a workflow was switched on is never acted on
const wLate = await workflows.create(alice, wf({ name: 'Late', enabled: false }));
await mkThread(alice, aGmail, 'Old mail', 'This arrived earlier.', { at: ago(5) });
await workflows.setEnabled(alice, wLate.id, true);
await engine.scanAccount(aGmail);
ok('enabling a workflow does not act on mail that came in before', (await runsOf(wLate.id)).length === 0);
await workflows.setEnabled(alice, wLate.id, false);

// manual run
const wMan = await mkWf(alice, { name: 'Manual', trigger: { type: 'manual' }, enabled: false });
ok('a reply workflow run by hand needs a conversation', await rejects(engine.runManual(alice, wMan.id), 'BadRequestException'));
const manual = await engine.runManual(alice, wMan.id, tD);
ok('"Run now" works on a switched-off workflow and still needs approval to send', manual.manual === true && manual.status === 'waiting_approval');
for (const a of await pending(alice)) await approvals.reject(alice, a.id);

// ============================ calendar writes
const evAt = (h) => new Date(Date.now() + h * 3_600_000);
const made = await calendar.createEvent(alice, { title: 'Planning', start: evAt(48), end: evAt(49), attendees: ['x@y.com'] });
ok('creating an event reaches the calendar once and appears locally', calls.create.length === 1 && !!made.id && (await db.query(`SELECT title FROM calendar_events WHERE id=$1`, [made.id])).rows[0].title === 'Planning');
ok('an overlapping event is refused until the person accepts the clash', (await rejects(calendar.createEvent(alice, { title: 'Clash', start: evAt(48.5), end: evAt(49.5) }), 'event_conflict')) && calls.create.length === 1);
await calendar.createEvent(alice, { title: 'Clash', start: evAt(48.5), end: evAt(49.5) }, { acceptConflicts: true });
ok('accepting the clash creates it', calls.create.length === 2);
ok('a calendar connected read-only cannot be written to', await rejects(calendar.createEvent(bob, { title: 'No', start: evAt(10), end: evAt(11) }), 'send_not_enabled'));
ok('an event must end after it starts', await rejects(calendar.createEvent(alice, { title: 'Bad', start: evAt(5), end: evAt(4) }), 'BadRequestException'));
await calendar.updateEvent(alice, made.id, { start: evAt(72), end: evAt(73) });
ok('rescheduling updates the provider and the local copy', calls.update.length === 1 && Math.abs(new Date((await db.query(`SELECT start_at FROM calendar_events WHERE id=$1`, [made.id])).rows[0].start_at) - evAt(72)) < 5000);
ok('both start and end are needed to reschedule', await rejects(calendar.updateEvent(alice, made.id, { start: evAt(80) }), 'BadRequestException'));
await calendar.cancelEvent(alice, made.id);
ok('cancelling removes it from the provider and locally', calls.cancel.length === 1 && (await db.query(`SELECT 1 FROM calendar_events WHERE id=$1`, [made.id])).rowCount === 0);
ok("bob cannot change alice's events", await rejects(calendar.updateEvent(bob, (await db.query(`SELECT id FROM calendar_events WHERE account_id=$1 LIMIT 1`, [aCal])).rows[0].id, { title: 'x' }), 'NotFoundException'));
const wEv = await mkWf(alice, { name: 'Follow-up event', trigger: { type: 'manual' }, enabled: false, actions: [{ type: 'create_event', title: 'Follow up: {{subject}}', startInHours: 100, durationMin: 30 }] });
const c0 = calls.create.length;
const evRun = await engine.runManual(alice, wEv.id, tA);
const evAp = (await pending(alice)).find((a) => a.kind === 'create_event');
ok('a workflow never writes to the calendar by itself: it files an approval', evRun.status === 'waiting_approval' && calls.create.length === c0 && /Follow up: Invoice 42/.test(evAp.payload.title));
await approvals.approve(alice, evAp.id, { payloadHash: evAp.payload_hash, acceptConflicts: true });
ok('approving creates the event', calls.create.length === c0 + 1 && calls.create.at(-1).title === 'Follow up: Invoice 42');

// ============================ reports
await db.query(`INSERT INTO action_items(tenant_id,user_id,thread_id,text,due_at) VALUES ($1,$2,$3,'=HYPERLINK("http://evil.example","click")', now() + interval '2 days')`, [alice.tenantId, alice.id, tA]);
const rp = await reports.generate(alice, { kind: 'weekly', format: 'pdf', rangeDays: 7 });
const rd = await reports.generate(alice, { kind: 'inbox', format: 'docx', rangeDays: 7 });
const rx = await reports.generate(alice, { kind: 'actions', format: 'xlsx', rangeDays: 7 });
const f = { pdf: await reports.download(alice, rp.id), docx: await reports.download(alice, rd.id), xlsx: await reports.download(alice, rx.id) };
ok('PDF, Word and Excel files are real documents', f.pdf.file.subarray(0, 4).toString() === '%PDF' && f.docx.file.subarray(0, 2).toString() === 'PK' && f.xlsx.file.subarray(0, 2).toString() === 'PK');
ok('the download is byte-identical to what was stored (hash matches)', sha256(f.pdf.file) === rp.sha256 && f.pdf.contentType === 'application/pdf');
const stored = (await db.query(`SELECT enc_body FROM reports WHERE id=$1`, [rp.id])).rows[0].enc_body;
ok('files are encrypted at rest', !Buffer.from(stored).includes('%PDF'));
ok('another person cannot list or download the report', (await reports.list(bob)).length === 0 && (await rejects(reports.download(bob, rp.id), 'NotFoundException')));
ok('generating a report is logged', (await activity.list(alice, { limit: 100 })).filter((a) => a.kind === 'report.generate').length === 3);
function sha256(b) { return createHash('sha256').update(b).digest('hex'); }

// ============================ schedules
const wSch = await mkWf(alice, { name: 'Daily report', trigger: { type: 'schedule', every: 'day', hour: 0, timezone: 'UTC' }, actions: [{ type: 'generate_report', kind: 'inbox', format: 'xlsx', rangeDays: 3 }] });
await engine.tick();
const schedRuns = await runsOf(wSch.id);
ok('a due scheduled workflow runs once and builds its report', schedRuns.length === 1 && schedRuns[0].status === 'done' && !!schedRuns[0].steps[0].ref?.reportId);
await engine.tick();
ok('the same day does not run it again', (await runsOf(wSch.id)).length === 1);
ok('a weekly schedule only fires on its weekday', engine.scheduleKey({ type: 'schedule', every: 'week', weekday: 1, hour: 0, timezone: 'UTC' }, new Date('2026-10-27T10:00:00Z')) === null && engine.scheduleKey({ type: 'schedule', every: 'week', weekday: 2, hour: 0, timezone: 'UTC' }, new Date('2026-10-27T10:00:00Z')) === 'sched-2026-10-27');
ok('a schedule before its hour does not fire', engine.scheduleKey({ type: 'schedule', every: 'day', hour: 12, timezone: 'UTC' }, new Date('2026-10-27T10:00:00Z')) === null);

// ============================ isolation
ok("bob sees none of alice's workflows, runs, approvals, activity, reports or profile", (await workflows.list(bob)).every((w) => w.name === 'Auto reply') && (await approvals.list(bob)).length === 0 && (await activity.list(bob, { limit: 100 })).every((a) => !/alice/i.test(a.summary)) && (await reports.list(bob)).length === 0);
ok("bob cannot read alice's run history", (await workflows.runs(bob, wAsk.id)).length === 0);
ok("the audit log holds no message text or addresses for approvals", !JSON.stringify((await db.query(`SELECT meta FROM audit_log`)).rows).includes('acme.com'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
