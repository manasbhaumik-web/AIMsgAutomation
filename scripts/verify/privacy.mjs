// Phase 6: data export, account erasure and retention on embedded Postgres, as the restricted role.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';

const ROOT = process.argv[2] ?? process.cwd();
const require = createRequire(ROOT + '/apps/api/package.json');
require('reflect-metadata');
const dist = (p) => require(`${ROOT}/apps/api/dist/${p}`);
const { PrivacyService } = dist('privacy/privacy.service.js');
const { AuditService } = dist('common/audit.service.js');
const { CryptoService } = dist('crypto/crypto.service.js');

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
const fails = async (p, pred) => { try { await p; return false; } catch (e) { return pred ? pred(e) : true; } };
const codeOf = (e) => e.getResponse?.()?.code ?? e.status ?? e.message;

const crypto = new CryptoService({ MASTER_KEY: randomBytes(32).toString('base64') });
const revoked = [];
const registry = { get: (c) => ({ revoke: async (a) => { revoked.push({ c, token: a.tokens.accessToken }); } }) };
let pw = 'none';
const auth = { passwordCheck: async () => pw };
const privacy = new PrivacyService(fakeDb, crypto, registry, auth, new AuditService(fakeDb));

const mkUser = async (label, role = 'user') => {
  const id = (await db.query(`SELECT auth_create_user($1,$2,'$hash',$3) AS id`, [`${label}@t.local`, label, role])).rows[0].id;
  const m = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [id])).rows[0];
  return { id, userId: id, tenantId: m.tenant_id, role, tenantRole: 'tenant_admin', email: `${label}@t.local` };
};
const tokens = Buffer.from(crypto.encrypt(JSON.stringify({ accessToken: 'SECRET-TOKEN', refreshToken: 'r', expiresAt: Date.now() + 3600_000 })));
const seed = async (u, n) => {
  const acct = (await db.query(`INSERT INTO connected_accounts(tenant_id,user_id,channel,external_id,enc_tokens) VALUES ($1,$2,'gmail',$3,$4) RETURNING id`, [u.tenantId, u.id, `${u.email}-g`, tokens])).rows[0].id;
  const th = (await db.query(`INSERT INTO threads(tenant_id,user_id,account_id,channel,external_id,subject,last_message_at) VALUES ($1,$2,$3,'gmail','t1','Subj',now()) RETURNING id`, [u.tenantId, u.id, acct])).rows[0].id;
  await db.query(`INSERT INTO messages(tenant_id,user_id,account_id,thread_id,channel,external_id,body_text,"timestamp",direction) SELECT $1,$2,$3,$4,'gmail','m'||g,'body '||g||' of ${u.email}',now() - make_interval(secs => g),'inbound' FROM generate_series(1,${n}) g`, [u.tenantId, u.id, acct, th]);
  await db.query(`INSERT INTO reply_drafts(tenant_id,user_id,thread_id,account_id,body,body_hash) VALUES ($1,$2,$3,$4,'draft','h')`, [u.tenantId, u.id, th, acct]);
  await db.query(`INSERT INTO consents(user_id,purpose) VALUES ($1,'ai_processing')`, [u.id]);
  await db.query(`INSERT INTO notifications(tenant_id,user_id,kind,ref,thread_id) VALUES ($1,$2,'new_message','r1',$3)`, [u.tenantId, u.id, th]);
  await db.query(`INSERT INTO device_sessions(user_id,refresh_hash,expires_at) VALUES ($1,$2,now() + interval '1 day')`, [u.id, 'h' + u.id]);
  await db.query(`INSERT INTO audit_log(tenant_id,actor_id,action) VALUES ($1,$2,'account.connect')`, [u.tenantId, u.id]);
  return { acct, th };
};

const alice = await mkUser('alice'), bob = await mkUser('bob'), root = await mkUser('root', 'admin');
const a = await seed(alice, 1100); // more than one export page
await seed(bob, 5);

// ---- session liveness (access tokens die with their session)
const sid = (await db.query(`INSERT INTO device_sessions(user_id,refresh_hash,expires_at) VALUES ($1,'live-1',now() + interval '1 day') RETURNING id`, [bob.id])).rows[0].id;
const alive = async (s, u) => (await db.query(`SELECT auth_session_alive($1,$2) AS ok`, [s, u])).rows[0].ok;
ok('a live session is alive', await alive(sid, bob.id));
ok('a session id presented with another user id is not alive', !(await alive(sid, root.id)));
await db.query(`UPDATE device_sessions SET revoked_at = now() WHERE id=$1`, [sid]);
ok('a revoked session is not alive', !(await alive(sid, bob.id)));
await db.query(`UPDATE device_sessions SET revoked_at = NULL, expires_at = now() - interval '1 second' WHERE id=$1`, [sid]);
ok('an expired session is not alive', !(await alive(sid, bob.id)));
await db.query(`UPDATE device_sessions SET expires_at = now() + interval '1 day' WHERE id=$1`, [sid]);
await db.query(`UPDATE users SET disabled = true WHERE id=$1`, [bob.id]);
ok('the session of a disabled user is not alive', !(await alive(sid, bob.id)));
await db.query(`UPDATE users SET disabled = false WHERE id=$1`, [bob.id]);
await db.query(`DELETE FROM device_sessions WHERE id=$1`, [sid]);

// ---- export
const lines = [];
for await (const l of privacy.export(alice)) lines.push(l);
const by = (s) => lines.filter((l) => l.section === s);
ok('export streams all of alice\'s 1100 messages across pages', by('messages').length === 1100, String(by('messages').length));
ok('export has profile, accounts, threads, drafts, notifications, consents, audit', ['profile', 'accounts', 'threads', 'reply_drafts', 'notifications', 'consents', 'audit_log'].every((s) => by(s).length >= 1));
const text = JSON.stringify(lines);
ok("export contains none of bob's data", !text.includes('bob@t.local') && by('messages').every((m) => m.data.body_text.endsWith('alice@t.local')));
ok('export never includes provider tokens or password hashes', !text.includes('SECRET-TOKEN') && !text.includes('enc_tokens') && !text.includes('password_hash') && !text.includes('$hash'));
ok('export is audited', (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='data.export' AND actor_id=$1`, [alice.id])).rows[0].n === 1);
const bobLines = []; for await (const l of privacy.export(bob)) bobLines.push(l);
ok('bob\'s export has only bob\'s messages', bobLines.filter((l) => l.section === 'messages').length === 5 && !JSON.stringify(bobLines).includes('alice@t.local'));
ok('sys_user_audit refuses to answer for someone else', await fails(fakeDb.tx(bob, (c) => c.query('SELECT * FROM sys_user_audit($1)', [alice.id]))));

// ---- erasure safeguards
ok('wrong confirmation email is refused', await fails(privacy.deleteAccount(alice, 'someone@else.com'), (e) => e.status === 400));
pw = 'wrong';
ok('wrong password is refused and nothing is deleted', (await fails(privacy.deleteAccount(alice, alice.email, 'x'), (e) => e.status === 403)) && (await db.query(`SELECT count(*)::int n FROM users WHERE id=$1`, [alice.id])).rows[0].n === 1);
pw = 'missing';
ok('password users must supply it', await fails(privacy.deleteAccount(alice, alice.email), (e) => e.status === 400));
ok('sys_delete_user refuses to delete someone else', await fails(fakeDb.tx(bob, (c) => c.query('SELECT sys_delete_user($1)', [alice.id]))));
pw = 'ok';
ok('the last platform admin cannot delete themselves', await fails(privacy.deleteAccount(root, root.email), (e) => codeOf(e) === 'last_admin'));

// a shared workspace where alice is the only admin
const shared = (await db.query(`INSERT INTO tenants(name, kind) VALUES ('Team','org') RETURNING id`)).rows[0].id;
await db.query(`INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'tenant_admin'), ($1,$3,'user')`, [shared, alice.id, bob.id]);
ok('the only admin of a shared workspace cannot leave it behind headless', await fails(privacy.deleteAccount(alice, alice.email), (e) => codeOf(e) === 'last_tenant_admin'));
await db.query(`UPDATE memberships SET role='tenant_admin' WHERE tenant_id=$1 AND user_id=$2`, [shared, bob.id]);

// ---- erasure
pw = 'ok';
await privacy.deleteAccount(alice, alice.email.toUpperCase(), 'right');
const gone = async (t, col = 'user_id') => (await db.query(`SELECT count(*)::int n FROM ${t} WHERE ${col}=$1`, [alice.id])).rows[0].n === 0;
const allGone = (await Promise.all([gone('users', 'id'), gone('connected_accounts'), gone('threads'), gone('messages'), gone('reply_drafts'), gone('notifications'), gone('consents'), gone('device_sessions'), gone('memberships')])).every(Boolean);
ok('every table row owned by alice is gone', allGone);
ok('provider access was revoked before deletion', revoked.length === 1 && revoked[0].token === 'SECRET-TOKEN');
ok('her personal workspace is deleted, the shared one remains', (await db.query(`SELECT count(*)::int n FROM tenants WHERE id=$1`, [alice.tenantId])).rows[0].n === 0 && (await db.query(`SELECT count(*)::int n FROM tenants WHERE id=$1`, [shared])).rows[0].n === 1);
ok('bob\'s data is untouched', (await db.query(`SELECT count(*)::int n FROM messages WHERE user_id=$1`, [bob.id])).rows[0].n === 5);
ok('audit trail kept but no longer points at alice', (await db.query(`SELECT count(*)::int n FROM audit_log WHERE actor_id=$1`, [alice.id])).rows[0].n === 0 && (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='account.deleted'`)).rows[0].n === 1 && (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='account.connect'`)).rows[0].n >= 2);
ok('deletion left no readable trace of her email in audit rows', !(await db.query(`SELECT meta::text t FROM audit_log`)).rows.some((r) => r.t.includes('alice@')));

// ---- retention
const carol = await mkUser('carol'), dave = await mkUser('dave');
const c = await seed(carol, 3), d = await seed(dave, 3);
await db.query(`UPDATE tenants SET retention_days = 30 WHERE id = $1`, [carol.tenantId]);
await db.query(`UPDATE messages SET "timestamp" = now() - interval '40 days' WHERE user_id IN ($1,$2) AND external_id = 'm1'`, [carol.id, dave.id]);
await db.query(`INSERT INTO device_sessions(user_id,refresh_hash,expires_at) VALUES ($1,'old',now() - interval '30 days')`, [carol.id]);
await db.query(`INSERT INTO notifications(tenant_id,user_id,kind,ref,thread_id,created_at) VALUES ($1,$2,'new_message','old',$3,now() - interval '200 days')`, [carol.tenantId, carol.id, c.th]);
await db.query(`INSERT INTO webhook_inbox(tenant_id,user_id,account_id,enc_payload,received_at) VALUES ($1,$2,$3,decode('00','hex'), now() - interval '20 days')`, [carol.tenantId, carol.id, c.acct]);
await db.query(`UPDATE reply_drafts SET status='discarded', updated_at = now() - interval '60 days' WHERE user_id = $1`, [dave.id]);
await db.query(`INSERT INTO audit_log(action, at) VALUES ('ancient', now() - interval '800 days')`);
const counts = await privacy.purge({ sessionsDays: 7, notificationsDays: 90, webhookDays: 7, draftsDays: 30, auditDays: 400, usageDays: 400 });
ok('tenant retention deletes only that tenant\'s old messages', (await db.query(`SELECT count(*)::int n FROM messages WHERE user_id=$1`, [carol.id])).rows[0].n === 2 && (await db.query(`SELECT count(*)::int n FROM messages WHERE user_id=$1`, [dave.id])).rows[0].n === 3, JSON.stringify(counts));
ok('expired sessions, old notifications, stale webhook events, old discarded drafts and ancient audit rows are swept', counts.sessions === 1 && counts.notifications === 1 && counts.webhook_inbox === 1 && counts.drafts === 1 && counts.audit_log >= 1, JSON.stringify(counts));
ok('fresh data survives the sweep', (await db.query(`SELECT count(*)::int n FROM device_sessions WHERE user_id=$1 AND refresh_hash <> 'old'`, [carol.id])).rows[0].n === 1 && (await db.query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1`, [carol.id])).rows[0].n === 1);
const again = await privacy.purge({ sessionsDays: 7, notificationsDays: 90, webhookDays: 7, draftsDays: 30, auditDays: 400, usageDays: 400 });
ok('a second sweep finds nothing to do', Object.values(again).every((n) => n === 0), JSON.stringify(again));
const stats = (await db.query(`SELECT * FROM sys_account_stats()`)).rows;
ok('account stats are aggregates without identities', stats.length > 0 && stats.every((r) => Object.keys(r).join() === 'channel,status,n,oldest_sync_age_s'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
