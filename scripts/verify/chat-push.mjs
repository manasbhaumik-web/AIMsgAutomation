// Phase 4 end to end on embedded Postgres, as the restricted role: signed webhooks -> durable storage -> sync -> messages.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { createHmac, randomBytes } from 'crypto';

const ROOT = process.argv[2] ?? process.cwd();
const require = createRequire(ROOT + '/apps/api/package.json');
require('reflect-metadata');
const dist = (p) => require(`${ROOT}/apps/api/dist/${p}`);
const { WebhooksController } = dist('ingestion/webhooks.controller.js');
const { ConnectorRegistry } = dist('connectors/registry.js');
const { IngestionService } = dist('ingestion/ingestion.service.js');
const { SyncService } = dist('ingestion/sync.service.js');
const { CryptoService } = dist('crypto/crypto.service.js');
const { MetricsService } = dist('observability/metrics.service.js');

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

const crypto = new CryptoService({ MASTER_KEY: randomBytes(32).toString('base64') });
const env = {
  WHATSAPP_APP_ID: 'app', WHATSAPP_APP_SECRET: 'wa-secret', WHATSAPP_CONFIG_ID: 'cfg', WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_API_VERSION: 'v21.0',
  SLACK_CLIENT_ID: 'c', SLACK_CLIENT_SECRET: 's', SLACK_SIGNING_SECRET: 'slack-secret', LINKEDIN_ENABLED: 'false',
};
const registry = new ConnectorRegistry(env);
const sync = new SyncService(fakeDb, crypto, registry, new IngestionService(fakeDb));
const queued = [];
const ctrl = new WebhooksController(registry, fakeDb, { enqueueSync: async (id) => { queued.push(id); } }, { verifyClientState: () => false }, crypto, new MetricsService());

const mkUser = async (label) => {
  const id = (await db.query(`SELECT auth_create_user($1,$2,NULL,'user') AS id`, [`${label}@t.local`, label])).rows[0].id;
  const m = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [id])).rows[0];
  return { id, userId: id, tenantId: m.tenant_id, role: 'user', tenantRole: 'tenant_admin' };
};
const alice = await mkUser('alice'), bob = await mkUser('bob');
const tokens = Buffer.from(crypto.encrypt(JSON.stringify({ accessToken: 'tok', refreshToken: null, expiresAt: Number.MAX_SAFE_INTEGER })));
const mkAccount = async (u, channel, ext, settings = {}) => (await db.query(
  `INSERT INTO connected_accounts(tenant_id,user_id,channel,external_id,settings,enc_tokens) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [u.tenantId, u.id, channel, ext, JSON.stringify(settings), tokens])).rows[0].id;
const aWa = await mkAccount(alice, 'whatsapp', 'PN1', { wabaId: 'W1' });
const bWa = await mkAccount(bob, 'whatsapp', 'PN2', { wabaId: 'W2' });
const aSl = await mkAccount(alice, 'slack', 'T1:U1');
const bSl = await mkAccount(bob, 'slack', 'T2:U2');
const count = async (sql, p = []) => (await db.query(sql, p)).rows[0].n;

// --- WhatsApp: handshake, signature, durable storage, ingestion
const res = { type() { return this; }, status() { return this; } };
ok('handshake echoes the challenge', ctrl.whatsappVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '777' }, res) === '777');
let forbidden = false;
try { ctrl.whatsappVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '777' }, res); } catch (e) { forbidden = e.status === 403; }
ok('handshake with a wrong token is 403', forbidden);

const value = (pn, id, text) => ({
  metadata: { display_phone_number: '15550001111', phone_number_id: pn }, contacts: [{ wa_id: '6591234567', profile: { name: 'Lee' } }],
  messages: [{ id, from: '6591234567', timestamp: '1760000000', type: 'text', text: { body: text } }],
});
const signedWa = (pn, id, text, key = 'wa-secret') => {
  const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: value(pn, id, text) }] }] };
  const raw = JSON.stringify(body);
  return { req: { rawBody: Buffer.from(raw) }, headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', key).update(raw).digest('hex') }, body };
};
let w = signedWa('PN1', 'wamid.A', 'Is the clinic open?');
await ctrl.whatsapp(w.req, w.headers, w.body);
ok('verified event stored for the owning account only', (await count(`SELECT count(*)::int n FROM webhook_inbox WHERE account_id=$1`, [aWa])) === 1 && (await count(`SELECT count(*)::int n FROM webhook_inbox WHERE account_id=$1`, [bWa])) === 0);
ok('sync job enqueued for that account only', queued.length === 1 && queued[0] === aWa, JSON.stringify(queued));
ok('stored payload is encrypted at rest', !(await db.query(`SELECT enc_payload::text t FROM webhook_inbox`)).rows[0].t.includes('clinic'));
const ownerRow = (await db.query(`SELECT user_id, tenant_id FROM webhook_inbox`)).rows[0];
ok('row is owned by the account owner (resolved server-side)', ownerRow.user_id === alice.id && ownerRow.tenant_id === alice.tenantId);

w = signedWa('PN1', 'wamid.FORGED', 'evil', 'attacker-secret');
let unauth = false;
try { await ctrl.whatsapp(w.req, w.headers, w.body); } catch (e) { unauth = e.status === 401; }
ok('forged signature is 401 and stores nothing', unauth && (await count(`SELECT count(*)::int n FROM webhook_inbox`)) === 1);
w = signedWa('PN-UNKNOWN', 'wamid.X', 'nobody');
await ctrl.whatsapp(w.req, w.headers, w.body);
ok('valid event for an unknown number is dropped', (await count(`SELECT count(*)::int n FROM webhook_inbox`)) === 1);

ok('sync of the push-only account returns true', (await sync.syncAccount(aWa)) === true);
const m = (await db.query(`SELECT m.body_text, m.sender, m.user_id, t.subject, t.external_id te FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.account_id=$1`, [aWa])).rows;
ok('message ingested under the owner, thread per customer', m.length === 1 && m[0].user_id === alice.id && m[0].te === '6591234567' && m[0].subject === 'Lee (+6591234567)' && m[0].sender.handle === '+6591234567', JSON.stringify(m));
ok('inbox row deleted once ingested', (await count(`SELECT count(*)::int n FROM webhook_inbox`)) === 0);
ok('nothing leaked into the other tenant', (await count(`SELECT count(*)::int n FROM messages WHERE user_id=$1`, [bob.id])) === 0);

w = signedWa('PN1', 'wamid.A', 'Is the clinic open?');
await ctrl.whatsapp(w.req, w.headers, w.body);
await sync.syncAccount(aWa);
ok('Meta redelivery is idempotent', (await count(`SELECT count(*)::int n FROM messages WHERE account_id=$1`, [aWa])) === 1);
w = signedWa('PN2', 'wamid.B', 'hi bob');
await ctrl.whatsapp(w.req, w.headers, w.body);
await sync.syncAccount(bWa);
ok("bob's number delivers to bob", (await count(`SELECT count(*)::int n FROM messages WHERE account_id=$1 AND user_id=$2`, [bWa, bob.id])) === 1);

await db.exec(`INSERT INTO webhook_inbox(tenant_id,user_id,account_id,enc_payload) VALUES ('${alice.tenantId}','${alice.id}','${aWa}',decode('00','hex'))`);
const seenByBob = await fakeDb.tx(bob, (c) => c.query('SELECT id FROM webhook_inbox'));
ok("bob cannot read alice's queued events", seenByBob.rows.length === 0);
await db.exec('DELETE FROM webhook_inbox');

// --- Slack: signature, replay window, workspace routing
const signedSlack = (body, ts = String(Math.floor(Date.now() / 1000)), forceSig) => {
  const raw = JSON.stringify(body);
  const sig = forceSig ?? 'v0=' + createHmac('sha256', 'slack-secret').update(`v0:${ts}:${raw}`).digest('hex');
  return { req: { rawBody: Buffer.from(raw) }, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body };
};
const evt = (team) => ({ type: 'event_callback', team_id: team, event: { type: 'message' } });
queued.length = 0;
let s = signedSlack(evt('T1'));
await ctrl.slack(s.req, s.headers, s.body, res);
ok('team T1 event syncs only the T1 account', queued.length === 1 && queued[0] === aSl, JSON.stringify(queued));
queued.length = 0;
s = signedSlack(evt('T2'));
await ctrl.slack(s.req, s.headers, s.body, res);
ok('team T2 event syncs only the T2 account', queued.length === 1 && queued[0] === bSl);
queued.length = 0;
s = signedSlack(evt('T9'));
await ctrl.slack(s.req, s.headers, s.body, res);
ok('unknown workspace syncs nothing', queued.length === 0);
s = signedSlack({ type: 'url_verification', challenge: 'chal-1' });
ok('url_verification returns the challenge', (await ctrl.slack(s.req, s.headers, s.body, res)) === 'chal-1');
const attempts = [['bad signature', signedSlack(evt('T1'), undefined, 'v0=00')], ['replayed (validly signed, old timestamp)', signedSlack(evt('T1'), String(Math.floor(Date.now() / 1000) - 3600))]];
for (const [label, a] of attempts) {
  let r401 = false;
  try { await ctrl.slack(a.req, a.headers, a.body, res); } catch (e) { r401 = e.status === 401; }
  ok(`${label} is 401 and queues nothing`, r401 && queued.length === 0);
}
ok('prefix lookup treats % and empty as literal/no match', (await count(`SELECT count(*)::int n FROM sys_find_accounts_prefix('slack','%')`)) === 0 && (await count(`SELECT count(*)::int n FROM sys_find_accounts_prefix('slack','')`)) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
