import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync } from 'fs';

const migration = readFileSync((process.argv[2] ?? process.cwd()) + '/apps/api/migrations/001_init.sql', 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','');
const db = new PGlite({ extensions: { citext } });
await db.exec(`CREATE ROLE inbox_app LOGIN NOSUPERUSER NOBYPASSRLS;`);
await db.exec(migration);
console.log('migration applied');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };

const mk = async (label, role = 'user') =>
  (await db.query(`SELECT auth_create_user($1, $2, NULL, $3) AS id`, [`${label}@t.local`, label, role])).rows[0].id;
const a = await mk('alice'), b = await mk('bob'), root = await mk('root', 'admin');
const ta = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [a])).rows[0].tenant_id;
const tb = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [b])).rows[0].tenant_id;
for (const [u, t] of [[a, ta], [b, tb]]) {
  await db.query(`INSERT INTO device_sessions(user_id, refresh_hash, expires_at) VALUES ($1,$2,now()+interval '1 day')`, [u, 'h' + u]);
  await db.query(`INSERT INTO usage_ledger(user_id,tenant_id,task,provider_kind,model,ok) VALUES ($1,$2,'chat','anthropic','m',true)`, [u, t]);
  await db.query(`INSERT INTO consents(user_id,purpose) VALUES ($1,'ai')`, [u]);
}
await db.query(`INSERT INTO audit_log(tenant_id, action) VALUES ($1,'b.event')`, [tb]);

async function as(ctx, sql, params = []) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE inbox_app');
    await db.query(`SELECT set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true), set_config('app.role',$3,true), set_config('app.tenant_role',$4,true)`,
      [ctx.userId ?? '', ctx.tenantId ?? '', ctx.role ?? '', ctx.tenantRole ?? '']);
    const r = await db.query(sql, params);
    await db.exec('COMMIT');
    return r;
  } catch (e) { await db.exec('ROLLBACK'); throw e; }
}
const fails = async (ctx, sql, params, re) => { try { await as(ctx, sql, params); return false; } catch (e) { return re.test(e.message); } };
const alice = { userId: a, tenantId: ta, role: 'user', tenantRole: 'tenant_admin' };

for (const t of ['users', 'device_sessions', 'usage_ledger', 'consents', 'memberships', 'tenants'])
  ok(`no context -> ${t} empty`, (await as({}, `SELECT * FROM ${t}`)).rows.length === 0);

for (const [t, c] of [['users', 'id'], ['device_sessions', 'user_id'], ['usage_ledger', 'user_id'], ['consents', 'user_id']]) {
  const rows = (await as(alice, `SELECT ${c} AS o FROM ${t}`)).rows;
  ok(`alice sees only her ${t}`, rows.length > 0 && rows.every((r) => r.o === a));
}
ok('alice sees only her tenant', (await as(alice, 'SELECT id FROM tenants')).rows.map((r) => r.id).join() === ta);
ok('cannot read bob by id', (await as(alice, 'SELECT * FROM users WHERE id=$1', [b])).rows.length === 0);
ok('cannot update bob', (await as(alice, `UPDATE users SET name='x' WHERE id=$1`, [b])).affectedRows === 0);
ok('cannot revoke bob session', (await as(alice, `UPDATE device_sessions SET revoked_at=now() WHERE user_id=$1`, [b])).affectedRows === 0);
ok('cannot delete bob consent', (await as(alice, `DELETE FROM consents WHERE user_id=$1`, [b])).affectedRows === 0);
ok('cannot insert ledger for bob', await fails(alice, `INSERT INTO usage_ledger(user_id,task,provider_kind,model,ok) VALUES ($1,'chat','anthropic','m',true)`, [b], /row-level security/));
ok('cannot insert session for bob', await fails(alice, `INSERT INTO device_sessions(user_id,refresh_hash,expires_at) VALUES ($1,'x',now())`, [b], /row-level security/));
ok('cannot self-escalate role', await fails(alice, `UPDATE users SET role='admin' WHERE id=$1`, [a], /permission denied/));
ok('non-admin cannot add provider', await fails(alice, `INSERT INTO llm_providers(name,kind) VALUES ('x','anthropic')`, [], /row-level security/));
ok('non-admin cannot add prompt', await fails(alice, `INSERT INTO prompt_templates(task,version,body) VALUES ('chat',1,'x')`, [], /row-level security/));
ok('non-admin cannot add quota', await fails(alice, `INSERT INTO quotas(scope,tokens_per_day) VALUES ('global',1)`, [], /row-level security/));
ok('admin can add provider', (await as({ userId: root, role: 'admin' }, `INSERT INTO llm_providers(name,kind) VALUES ('p','anthropic') RETURNING id`)).rows.length === 1);
ok("tenant admin cannot see other tenant audit", (await as(alice, 'SELECT * FROM audit_log WHERE tenant_id=$1', [tb])).rows.length === 0);
ok("tenant admin cannot see other tenant usage", (await as(alice, 'SELECT * FROM usage_ledger WHERE tenant_id=$1', [tb])).rows.length === 0);
ok('alice can delete own consent', (await as(alice, `DELETE FROM consents WHERE user_id=$1`, [a])).affectedRows === 1);
ok('auth fn: find by email', (await as({}, `SELECT * FROM auth_find_user('alice@t.local')`)).rows.length === 1);
ok('cascade delete own account', (await as(alice, `DELETE FROM users WHERE id=$1`, [a])).affectedRows === 1);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
