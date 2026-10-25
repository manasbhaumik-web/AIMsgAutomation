import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { applyCtx } from './db.service';
import { migrate } from './migrate';

/**
 * Tenant-isolation suite. Needs a real Postgres: set TEST_DATABASE_ADMIN_URL (owner) and
 * TEST_DATABASE_URL (the non-owner runtime role). Skipped otherwise; CI always provides both.
 */
const ADMIN = process.env.TEST_DATABASE_ADMIN_URL;
const APP = process.env.TEST_DATABASE_URL;
const d = ADMIN && APP ? describe : describe.skip;

d('row-level security isolation', () => {
  let admin: Client;
  let app: Pool;
  const ids = { a: '', b: '', ta: '', tb: '', adminUser: '' };

  beforeAll(async () => {
    await migrate(ADMIN!);
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    app = new Pool({ connectionString: APP });
    const mk = async (label: string, role = 'user') =>
      (await admin.query('SELECT auth_create_user($1, $2, NULL, $3) AS id', [`${label}-${randomUUID()}@test.local`, label, role])).rows[0].id as string;
    ids.a = await mk('alice');
    ids.b = await mk('bob');
    ids.adminUser = await mk('root', 'admin');
    ids.ta = (await admin.query('SELECT tenant_id FROM memberships WHERE user_id = $1', [ids.a])).rows[0].tenant_id;
    ids.tb = (await admin.query('SELECT tenant_id FROM memberships WHERE user_id = $1', [ids.b])).rows[0].tenant_id;
    for (const [u, t] of [[ids.a, ids.ta], [ids.b, ids.tb]]) {
      await admin.query(`INSERT INTO device_sessions(user_id, refresh_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [u, randomUUID()]);
      await admin.query(`INSERT INTO usage_ledger(user_id, tenant_id, task, provider_kind, model, ok) VALUES ($1,$2,'chat','anthropic','m',true)`, [u, t]);
      await admin.query(`INSERT INTO consents(user_id, purpose) VALUES ($1,'ai_processing')`, [u]);
      const acct = (await admin.query(`INSERT INTO connected_accounts(tenant_id, user_id, channel, external_id) VALUES ($1,$2,'gmail',$3) RETURNING id`, [t, u, `${u}@gmail.com`])).rows[0].id;
      const th = (await admin.query(`INSERT INTO threads(tenant_id, user_id, account_id, channel, external_id, subject, last_message_at) VALUES ($1,$2,$3,'gmail','t1','s',now()) RETURNING id`, [t, u, acct])).rows[0].id;
      const msg = (await admin.query(`INSERT INTO messages(tenant_id, user_id, account_id, thread_id, channel, external_id, "timestamp", direction, body_text) VALUES ($1,$2,$3,$4,'gmail','m1',now(),'inbound','secret ${u}') RETURNING id`, [t, u, acct, th])).rows[0].id;
      // Phase 3 derived data
      await admin.query(`INSERT INTO message_embeddings(message_id, tenant_id, user_id, model, embedding) VALUES ($1,$2,$3,'m', array_fill(0.1::real, ARRAY[1536])::vector)`, [msg, t, u]);
      const topic = (await admin.query(`INSERT INTO topics(tenant_id, user_id, name) VALUES ($1,$2,'Topic') RETURNING id`, [t, u])).rows[0].id;
      await admin.query(`INSERT INTO thread_topics(thread_id, topic_id, user_id) VALUES ($1,$2,$3)`, [th, topic, u]);
      await admin.query(`INSERT INTO thread_analysis(thread_id, tenant_id, user_id, priority, status, analyzed_through) VALUES ($1,$2,$3,'fyi','done',now())`, [th, t, u]);
      await admin.query(`INSERT INTO action_items(tenant_id, user_id, thread_id, text) VALUES ($1,$2,$3,'do it')`, [t, u, th]);
      await admin.query(`INSERT INTO summaries(tenant_id, user_id, scope, ref, text, input_hash) VALUES ($1,$2,'thread','r','s','h')`, [t, u]);
      await admin.query(`INSERT INTO digests(tenant_id, user_id, digest_date, text) VALUES ($1,$2,current_date,'d')`, [t, u]);
      const conv = (await admin.query(`INSERT INTO conversations(tenant_id, user_id) VALUES ($1,$2) RETURNING id`, [t, u])).rows[0].id;
      await admin.query(`INSERT INTO chat_turns(conversation_id, tenant_id, user_id, role, content) VALUES ($1,$2,$3,'user','q')`, [conv, t, u]);
      await admin.query(`INSERT INTO calendar_events(tenant_id, user_id, account_id, channel, external_id, start_at, end_at) VALUES ($1,$2,$3,'gmail','e1',now(),now())`, [t, u, acct]);
      // Phase 4: a stored (encrypted) webhook event, written the way the webhook endpoint writes it
      await admin.query('SELECT sys_push_webhook_event($1, $2)', [acct, Buffer.from('ciphertext')]);
      // Phase 5: drafts, preferences, devices, notifications
      await admin.query(`INSERT INTO reply_drafts(tenant_id, user_id, thread_id, account_id, body, body_hash) VALUES ($1,$2,$3,$4,'draft text','h')`, [t, u, th, acct]);
      await admin.query(`INSERT INTO notification_prefs(user_id, tenant_id) VALUES ($1,$2)`, [u, t]);
      await admin.query(`INSERT INTO push_devices(tenant_id, user_id, platform, enc_token, token_hash) VALUES ($1,$2,'fcm',decode('00','hex'),$3)`, [t, u, randomUUID()]);
      await admin.query(`INSERT INTO notifications(tenant_id, user_id, kind, ref, thread_id) VALUES ($1,$2,'new_message',$3,$4)`, [t, u, randomUUID(), th]);
      // Phase 7: profile, workflows, runs, approvals, activity, reports
      await admin.query(`INSERT INTO user_profiles(user_id, tenant_id) VALUES ($1,$2)`, [u, t]);
      const wf = (await admin.query(`INSERT INTO workflows(tenant_id, user_id, name, trigger, actions) VALUES ($1,$2,'w','{"type":"manual"}','[{"type":"generate_report"}]') RETURNING id`, [t, u])).rows[0].id;
      const run = (await admin.query(`INSERT INTO workflow_runs(tenant_id, user_id, workflow_id, trigger_type, dedupe_key) VALUES ($1,$2,$3,'manual','k1') RETURNING id`, [t, u, wf])).rows[0].id;
      await admin.query(`INSERT INTO approvals(tenant_id, user_id, workflow_id, run_id, kind, summary, payload, payload_hash) VALUES ($1,$2,$3,$4,'send_reply','s','{}','h')`, [t, u, wf, run]);
      await admin.query(`INSERT INTO activity_log(tenant_id, user_id, actor, kind, summary) VALUES ($1,$2,'user','x','y')`, [t, u]);
      await admin.query(`INSERT INTO reports(tenant_id, user_id, title, kind, format, size_bytes, sha256, enc_body) VALUES ($1,$2,'r','weekly','pdf',1,'h',decode('00','hex'))`, [t, u]);
    }
  });

  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  async function as(ctx: Parameters<typeof applyCtx>[1], sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await applyCtx(c, ctx);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const alice = () => ({ userId: ids.a, tenantId: ids.ta, role: 'user' as const, tenantRole: 'tenant_admin' as const });

  it('the runtime role cannot bypass RLS or own tables', async () => {
    const r = await as({}, `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it.each(['users', 'device_sessions', 'usage_ledger', 'consents', 'memberships', 'tenants'])('with no context, %s returns zero rows', async (table) => {
    expect((await as({}, `SELECT * FROM ${table}`)).rows).toHaveLength(0);
  });

  it("a user sees only their own rows in every personal table", async () => {
    for (const [table, col] of [['users', 'id'], ['device_sessions', 'user_id'], ['usage_ledger', 'user_id'], ['consents', 'user_id']]) {
      const rows = (await as(alice(), `SELECT ${col} AS owner FROM ${table}`)).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.owner === ids.a)).toBe(true);
    }
    expect((await as(alice(), 'SELECT id FROM tenants')).rows.map((r) => r.id)).toEqual([ids.ta]);
  });

  it("cannot read another user's row by id", async () => {
    expect((await as(alice(), 'SELECT * FROM users WHERE id = $1', [ids.b])).rows).toHaveLength(0);
    expect((await as(alice(), 'SELECT * FROM device_sessions WHERE user_id = $1', [ids.b])).rows).toHaveLength(0);
  });

  it("cannot update or delete another user's rows", async () => {
    expect((await as(alice(), `UPDATE users SET name = 'pwned' WHERE id = $1`, [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), 'UPDATE device_sessions SET revoked_at = now() WHERE user_id = $1', [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), 'DELETE FROM consents WHERE user_id = $1', [ids.b])).rowCount).toBe(0);
  });

  it("cannot insert rows owned by someone else", async () => {
    await expect(as(alice(), `INSERT INTO usage_ledger(user_id, task, provider_kind, model, ok) VALUES ($1,'chat','anthropic','m',true)`, [ids.b])).rejects.toThrow(/row-level security/);
    await expect(as(alice(), `INSERT INTO device_sessions(user_id, refresh_hash, expires_at) VALUES ($1,'x',now())`, [ids.b])).rejects.toThrow(/row-level security/);
  });

  it('a user cannot escalate their own role', async () => {
    await expect(as(alice(), `UPDATE users SET role = 'admin' WHERE id = $1`, [ids.a])).rejects.toThrow(/permission denied/);
  });

  it('a spoofed admin role in the context cannot be forged by a plain user via SQL they cannot write', async () => {
    // The app sets app.role from the verified JWT only; this checks that admin policies depend on it.
    await expect(as(alice(), `INSERT INTO llm_providers(name, kind) VALUES ('x','anthropic')`)).rejects.toThrow(/row-level security/);
    const ok = await as({ userId: ids.adminUser, role: 'admin' }, `INSERT INTO llm_providers(name, kind) VALUES ($1,'anthropic') RETURNING id`, [`p-${randomUUID()}`]);
    expect(ok.rows).toHaveLength(1);
  });

  it('a non-admin cannot change prompts, routes or quotas', async () => {
    await expect(as(alice(), `INSERT INTO prompt_templates(task, version, body) VALUES ('chat', 999, 'x')`)).rejects.toThrow(/row-level security/);
    await expect(as(alice(), `INSERT INTO quotas(scope, tokens_per_day) VALUES ('global', 1)`)).rejects.toThrow(/row-level security/);
  });

  it("a tenant admin cannot see another tenant's usage or audit log", async () => {
    await admin.query(`INSERT INTO audit_log(tenant_id, action) VALUES ($1,'t.b.event')`, [ids.tb]);
    const audit = await as(alice(), 'SELECT * FROM audit_log WHERE tenant_id = $1', [ids.tb]);
    expect(audit.rows).toHaveLength(0);
    const usage = await as(alice(), 'SELECT * FROM usage_ledger WHERE tenant_id = $1', [ids.tb]);
    expect(usage.rows).toHaveLength(0);
  });

  it.each(['connected_accounts', 'threads', 'messages', 'calendar_events'])('with no context, %s returns zero rows', async (table) => {
    expect((await as({}, `SELECT * FROM ${table}`)).rows).toHaveLength(0);
  });

  it("mailbox data is invisible to other users, including full-text search over message bodies", async () => {
    for (const table of ['connected_accounts', 'threads', 'messages', 'calendar_events']) {
      const rows = (await as(alice(), `SELECT user_id FROM ${table}`)).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.user_id === ids.a)).toBe(true);
    }
    const hit = await as(alice(), `SELECT user_id FROM messages WHERE tsv @@ plainto_tsquery('simple', $1)`, ['secret']);
    expect(hit.rows.every((r) => r.user_id === ids.a)).toBe(true);
    expect((await as(alice(), 'SELECT * FROM messages WHERE user_id = $1', [ids.b])).rows).toHaveLength(0);
  });

  it("cannot modify, delete, or plant mailbox rows for another user", async () => {
    expect((await as(alice(), `UPDATE connected_accounts SET status = 'paused' WHERE user_id = $1`, [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), 'DELETE FROM messages WHERE user_id = $1', [ids.b])).rowCount).toBe(0);
    const acctB = (await admin.query('SELECT id FROM connected_accounts WHERE user_id = $1', [ids.b])).rows[0].id;
    await expect(as(alice(), `INSERT INTO threads(tenant_id, user_id, account_id, channel, external_id, last_message_at) VALUES ($1,$2,$3,'gmail','evil',now())`, [ids.ta, ids.b, acctB])).rejects.toThrow(/row-level security/);
  });

  it('the sys_* worker functions are not callable by PUBLIC but are by the runtime role', async () => {
    const r = await as({}, `SELECT count(*)::int AS n FROM sys_find_accounts('gmail', $1, NULL)`, [`${ids.a}@gmail.com`]);
    expect(r.rows[0].n).toBe(1);
    const priv = await admin.query(`SELECT has_function_privilege('public', 'sys_account_ctx(uuid)', 'EXECUTE') AS p`);
    expect(priv.rows[0].p).toBe(false);
  });

  const AI_TABLES = ['message_embeddings', 'topics', 'thread_topics', 'thread_analysis', 'action_items', 'summaries', 'digests', 'conversations', 'chat_turns'];

  it.each(AI_TABLES)('AI table %s: no context -> zero rows; a user sees only their own', async (table) => {
    expect((await as({}, `SELECT * FROM ${table}`)).rows).toHaveLength(0);
    const rows = (await as(alice(), `SELECT user_id FROM ${table}`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === ids.a)).toBe(true);
  });

  it("vector search can never return another user's embeddings, even when theirs is the nearest", async () => {
    // Both users' vectors are identical, so distance cannot separate them: only RLS can.
    const r = await as(alice(), `SELECT user_id FROM message_embeddings ORDER BY embedding <=> array_fill(0.1::real, ARRAY[1536])::vector LIMIT 10`);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.user_id === ids.a)).toBe(true);
  });

  it('a user cannot plant AI rows for someone else', async () => {
    await expect(as(alice(), `INSERT INTO action_items(tenant_id, user_id, thread_id, text) SELECT tenant_id, user_id, id, 'evil' FROM threads WHERE user_id = $1`, [ids.b])).resolves.toMatchObject({ rowCount: 0 });
    await expect(as(alice(), `INSERT INTO summaries(tenant_id, user_id, scope, ref, text, input_hash) VALUES ($1,$2,'thread','x','evil','h')`, [ids.ta, ids.b])).rejects.toThrow(/row-level security/);
    await expect(as(alice(), `INSERT INTO conversations(tenant_id, user_id) VALUES ($1,$2)`, [ids.ta, ids.b])).rejects.toThrow(/row-level security/);
  });

  it('worker lookup functions are not callable by PUBLIC', async () => {
    for (const fn of ['sys_user_ctx(uuid)', 'sys_accounts_pending_ai()', 'sys_digest_candidates()']) {
      const p = await admin.query(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS p`);
      expect(p.rows[0].p).toBe(false);
    }
  });

  it('webhook_inbox: no context -> zero rows; a user sees only their own; nobody can insert or update directly', async () => {
    expect((await as({}, 'SELECT * FROM webhook_inbox')).rows).toHaveLength(0);
    const rows = (await as(alice(), 'SELECT user_id FROM webhook_inbox')).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === ids.a)).toBe(true);
    const acctA = (await admin.query('SELECT id FROM connected_accounts WHERE user_id = $1', [ids.a])).rows[0].id;
    await expect(as(alice(), `INSERT INTO webhook_inbox(tenant_id, user_id, account_id, enc_payload) VALUES ($1,$2,$3,decode('00','hex'))`, [ids.ta, ids.a, acctA])).rejects.toThrow(/permission denied/);
    await expect(as(alice(), `UPDATE webhook_inbox SET enc_payload = decode('01','hex')`)).rejects.toThrow(/permission denied/);
    expect((await as(alice(), 'DELETE FROM webhook_inbox WHERE user_id = $1', [ids.b])).rowCount).toBe(0);
  });

  it('the webhook writer only writes into the owner of an active account, and the new lookups are not callable by PUBLIC', async () => {
    const before = (await admin.query('SELECT count(*)::int n FROM webhook_inbox')).rows[0].n;
    await as({}, 'SELECT sys_push_webhook_event($1, $2)', [randomUUID(), Buffer.from('x')]); // unknown account: nothing
    expect((await admin.query('SELECT count(*)::int n FROM webhook_inbox')).rows[0].n).toBe(before);
    const acctB = (await admin.query('SELECT id FROM connected_accounts WHERE user_id = $1', [ids.b])).rows[0].id;
    await as({}, 'SELECT sys_push_webhook_event($1, $2)', [acctB, Buffer.from('x')]);
    const last = (await admin.query('SELECT user_id, tenant_id FROM webhook_inbox ORDER BY id DESC LIMIT 1')).rows[0];
    expect(last).toEqual({ user_id: ids.b, tenant_id: ids.tb });
    for (const fn of ['sys_find_accounts_prefix(text, text)', 'sys_push_webhook_event(uuid, bytea)']) {
      expect((await admin.query(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS p`)).rows[0].p).toBe(false);
    }
  });

  const PHASE5_TABLES = ['reply_drafts', 'notification_prefs', 'push_devices', 'notifications'];

  it.each(PHASE5_TABLES)('Phase 5 table %s: no context -> zero rows; a user sees only their own', async (table) => {
    expect((await as({}, `SELECT * FROM ${table}`)).rows).toHaveLength(0);
    const rows = (await as(alice(), `SELECT user_id FROM ${table}`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === ids.a)).toBe(true);
  });

  it("a user cannot plant a draft in someone else's thread or change their drafts", async () => {
    const th = (await admin.query('SELECT id, account_id FROM threads WHERE user_id = $1', [ids.b])).rows[0];
    await expect(as(alice(), `INSERT INTO reply_drafts(tenant_id, user_id, thread_id, account_id, body, body_hash) VALUES ($1,$2,$3,$4,'x','h')`, [ids.tb, ids.b, th.id, th.account_id])).rejects.toThrow(/row-level security/);
    expect((await as(alice(), `UPDATE reply_drafts SET status = 'sent' WHERE user_id = $1`, [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), 'DELETE FROM notifications WHERE user_id = $1', [ids.b])).rowCount).toBe(0);
    await expect(as(alice(), `INSERT INTO reply_drafts(tenant_id, user_id, thread_id, account_id, body, body_hash, status) VALUES ($1,$2,$3,$4,'',  'h','draft')`, [ids.ta, ids.a, th.id, th.account_id])).rejects.toThrow();
  });

  it('only one open draft can exist per thread', async () => {
    const th = (await admin.query('SELECT id, account_id FROM threads WHERE user_id = $1', [ids.a])).rows[0];
    await expect(as(alice(), `INSERT INTO reply_drafts(tenant_id, user_id, thread_id, account_id, body, body_hash) VALUES ($1,$2,$3,$4,'second','h2')`, [ids.ta, ids.a, th.id, th.account_id])).rejects.toThrow(/duplicate key|unique/);
  });

  it('privacy and operations functions are not callable by PUBLIC, and refuse to act on another user', async () => {
    for (const fn of ['sys_user_audit(uuid)', 'sys_delete_user(uuid)', 'sys_purge_expired(int, int, int, int, int, int)', 'sys_account_stats()', 'auth_session_alive(uuid, uuid)']) {
      expect((await admin.query(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS p`)).rows[0].p).toBe(false);
    }
    await expect(as(alice(), 'SELECT sys_delete_user($1)', [ids.b])).rejects.toThrow(/not allowed/);
    await expect(as(alice(), 'SELECT * FROM sys_user_audit($1)', [ids.b])).rejects.toThrow(/not allowed/);
    expect((await admin.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [ids.b])).rows[0].n).toBe(1);
  });

  const PHASE7_TABLES = ['user_profiles', 'workflows', 'workflow_runs', 'approvals', 'activity_log', 'reports'];

  it.each(PHASE7_TABLES)('Phase 7 table %s: no context -> zero rows; a user sees only their own', async (table) => {
    expect((await as({}, `SELECT * FROM ${table}`)).rows).toHaveLength(0);
    const rows = (await as(alice(), `SELECT user_id FROM ${table}`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === ids.a)).toBe(true);
  });

  it('a user cannot plant or change workflows, approvals, reports or preferences for someone else', async () => {
    await expect(as(alice(), `INSERT INTO workflows(tenant_id, user_id, name, trigger, actions) VALUES ($1,$2,'x','{"type":"manual"}','[{"type":"generate_report"}]')`, [ids.tb, ids.b])).rejects.toThrow(/row-level security/);
    expect((await as(alice(), `UPDATE approvals SET status = 'executed' WHERE user_id = $1`, [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), `DELETE FROM reports WHERE user_id = $1`, [ids.b])).rowCount).toBe(0);
    expect((await as(alice(), `UPDATE user_profiles SET auto_replies_enabled = true WHERE user_id = $1`, [ids.b])).rowCount).toBe(0);
  });

  it('teams: only members see a team; nobody can add themselves; an invitation cannot be taken by another address', async () => {
    const team = (await as(alice(), 'SELECT create_team($1) AS id', ['Team A'])).rows[0].id;
    const bob = () => ({ userId: ids.b, tenantId: ids.tb, role: 'user' as const, tenantRole: 'tenant_admin' as const });
    expect((await as(bob(), 'SELECT * FROM teams WHERE id = $1', [team])).rows).toHaveLength(0);
    expect((await as(bob(), 'SELECT * FROM team_members WHERE team_id = $1', [team])).rows).toHaveLength(0);
    expect((await as(bob(), 'SELECT * FROM team_roster($1)', [team])).rows).toHaveLength(0);
    await expect(as(bob(), `INSERT INTO team_members(team_id, user_id, role) VALUES ($1,$2,'owner')`, [team, ids.b])).rejects.toThrow(/permission denied|row-level security/);
    await expect(as(bob(), `INSERT INTO team_invites(team_id, email, role, invited_by) VALUES ($1,'x@y.z','member',$2)`, [team, ids.b])).rejects.toThrow(/row-level security/);
    const inv = (await as(alice(), `INSERT INTO team_invites(team_id, email, role, invited_by) VALUES ($1,'someone-else@test.local','member',$2) RETURNING id`, [team, ids.a])).rows[0].id;
    expect((await as(bob(), 'SELECT accept_team_invite($1) AS id', [inv])).rows[0].id).toBeNull();
    expect((await as(bob(), 'SELECT * FROM team_invites WHERE id = $1', [inv])).rows).toHaveLength(0);
    expect((await as({}, 'SELECT * FROM teams')).rows).toHaveLength(0);
  });

  it('the Phase 7 worker functions and team helpers are not callable by PUBLIC', async () => {
    for (const fn of ['sys_users_with_schedules()', 'sys_expire_approvals()', 'sys_purge_reports()', 'create_team(text)', 'accept_team_invite(uuid)', 'team_roster(uuid)', 'my_team_invites()']) {
      expect((await admin.query(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS p`)).rows[0].p).toBe(false);
    }
  });

  it('context does not leak between pooled connections', async () => {
    await as(alice(), 'SELECT 1');
    expect((await as({}, 'SELECT * FROM users')).rows).toHaveLength(0);
  });
});
