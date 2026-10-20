// Development database without Docker: embedded Postgres (PGlite + pgvector) served over the Postgres wire protocol.
//   node scripts/dev-db.mjs            # data persists in .devdb/
// It applies the migrations as the owner, creates a dev admin, then switches the session to the restricted runtime role
// (inbox_app, no BYPASSRLS), so the API runs under row-level security exactly as in production. Not for production use.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'dev-admin-password-1';

const db = await PGlite.create({ dataDir: `${ROOT}/.devdb`, extensions: { citext, vector } });
await db.exec('RESET ROLE');
await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN CREATE ROLE inbox_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const f of readdirSync(`${ROOT}/apps/api/migrations`).filter((x) => x.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  await db.exec(readFileSync(`${ROOT}/apps/api/migrations/${f}`, 'utf8'));
  await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
  console.log(`applied ${f}`);
}

const require = createRequire(`${ROOT}/apps/api/package.json`);
const { hashPassword } = require(`${ROOT}/apps/api/dist/auth/password.js`);
const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [ADMIN_EMAIL]);
if (!existing.rows.length) {
  await db.query(`SELECT auth_create_user($1, $2, $3, 'admin')`, [ADMIN_EMAIL, 'Dev Admin', await hashPassword(ADMIN_PASSWORD)]);
  console.log(`created platform admin ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}

await db.exec('SET ROLE inbox_app');
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 4 });
await server.start();
console.log(`dev database ready on postgres://inbox_app@127.0.0.1:${PORT}/postgres (restricted role, RLS enforced)`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await server.stop(); await db.close(); process.exit(0); });
