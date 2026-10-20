// Checks that load/seed.sql runs, is repeatable, and produces data the restricted role can only read per user.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'fs';

const ROOT = process.argv[2] ?? process.cwd();
const db = new PGlite({ extensions: { citext, vector } });
await db.exec(`CREATE ROLE inbox_app LOGIN NOSUPERUSER NOBYPASSRLS;`);
for (const f of readdirSync(`${ROOT}/apps/api/migrations`).sort()) await db.exec(readFileSync(`${ROOT}/apps/api/migrations/${f}`, 'utf8'));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + x)); };

// psql substitutes :'var' and runs the file; here the same three settings are applied directly.
const sql = readFileSync(`${ROOT}/load/seed.sql`, 'utf8').replace(/^SELECT set_config\(.*$/m, `SELECT set_config('seed.users','5',false), set_config('seed.msgs','30',false), set_config('seed.pwhash','hash',false);`);
await db.exec(sql);
const n = async (q, p = []) => (await db.query(q, p)).rows[0].n;
ok('5 users, one account each', (await n(`SELECT count(*)::int n FROM users WHERE email LIKE 'loaduser%@load.test'`)) === 5 && (await n(`SELECT count(*)::int n FROM connected_accounts`)) === 5);
ok('30 messages and 10 threads per user, with a priority on every thread', (await n(`SELECT count(*)::int n FROM messages`)) === 150 && (await n(`SELECT count(*)::int n FROM threads`)) === 50 && (await n(`SELECT count(*)::int n FROM thread_analysis`)) === 50);
await db.exec(sql);
ok('running it again adds nothing', (await n(`SELECT count(*)::int n FROM messages`)) === 150 && (await n(`SELECT count(*)::int n FROM users WHERE email LIKE 'loaduser%'`)) === 5);
const u = (await db.query(`SELECT u.id, m.tenant_id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = 'loaduser0@load.test'`)).rows[0];
await db.exec('BEGIN'); await db.exec('SET LOCAL ROLE inbox_app');
await db.query(`SELECT set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true), set_config('app.role','user',true), set_config('app.tenant_role','tenant_admin',true)`, [u.id, u.tenant_id]);
const own = (await db.query(`SELECT count(*)::int n, count(DISTINCT user_id)::int d FROM messages`)).rows[0];
await db.exec('ROLLBACK');
ok('the restricted role sees only one user\'s 30 messages', own.n === 30 && own.d === 1, JSON.stringify(own));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
