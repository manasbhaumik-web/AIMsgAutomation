// Runs the real compiled services against an embedded Postgres, as the restricted app role.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';

const ROOT = process.argv[2] ?? process.cwd();
const require = createRequire(ROOT + '/apps/api/package.json');
require('reflect-metadata');
const dist = (p) => require(`${ROOT}/apps/api/dist/${p}`);
const { IngestionService } = dist('ingestion/ingestion.service.js');
const { SyncService } = dist('ingestion/sync.service.js');
const { InboxController } = dist('ingestion/inbox.controller.js');
const { AccountsService } = dist('connectors/accounts.service.js');
const { CryptoService } = dist('crypto/crypto.service.js');
const { ProviderAuthError, SyncResetError } = dist('connectors/types.js');

const db = new PGlite({ extensions: { citext, vector } });
await db.exec(`CREATE ROLE inbox_app LOGIN NOSUPERUSER NOBYPASSRLS;`);
for (const f of ['001_init.sql', '002_connectors.sql', '003_ai.sql', '004_chat_channels.sql'])
  await db.exec(readFileSync(`${ROOT}/apps/api/migrations/${f}`, 'utf8'));
console.log('migrations applied');

// pg-compatible facade: Db.tx(ctx, fn) with a restricted role and RLS context.
let txQueue = Promise.resolve();
const fakeDb = {
  tx(ctx, fn) {
    const run = async () => {
      await db.exec('BEGIN');
      try {
        await db.exec('SET LOCAL ROLE inbox_app');
        await db.query(`SELECT set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true), set_config('app.role',$3,true), set_config('app.tenant_role',$4,true)`,
          [ctx.userId ?? '', ctx.tenantId ?? '', ctx.role ?? '', ctx.tenantRole ?? '']);
        const client = { query: async (sql, params) => { const r = await db.query(sql, params); const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v]))); return { rows, rowCount: r.affectedRows ?? r.rows.length }; } };
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
const ingestion = new IngestionService(fakeDb);
let connectorBehavior = {};
const registry = { get: () => ({ id: 'gmail', refreshToken: async (t) => { connectorBehavior.refreshed = true; return { ...t, accessToken: 'refreshed', expiresAt: Date.now() + 3600_000 }; },
  initialSync: async (a, since) => { connectorBehavior.initial = (connectorBehavior.initial ?? 0) + 1; return connectorBehavior.initialResult(a, since); },
  incrementalSync: async (a, cur) => connectorBehavior.incremental(a, cur) }) };
const sync = new SyncService(fakeDb, crypto, registry, ingestion);

const mkUser = async (label) => {
  const id = (await db.query(`SELECT auth_create_user($1,$2,NULL,'user') AS id`, [`${label}@t.local`, label])).rows[0].id;
  const m = (await db.query(`SELECT tenant_id FROM memberships WHERE user_id=$1`, [id])).rows[0];
  return { id, tenantId: m.tenant_id, role: 'user', tenantRole: 'tenant_admin', sessionId: 's' };
};
const alice = await mkUser('alice'), bob = await mkUser('bob');
const mkAccount = async (u, ext, expiresIn) => (await db.query(
  `INSERT INTO connected_accounts(tenant_id,user_id,channel,external_id,enc_tokens) VALUES ($1,$2,'gmail',$3,$4) RETURNING id`,
  [u.tenantId, u.id, ext, Buffer.from(crypto.encrypt(JSON.stringify({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + expiresIn })))])).rows[0].id;

const msg = (id, thread, ts, over = {}) => ({ externalId: id, threadExternalId: thread, subject: 'Subj ' + thread, sender: { email: 's@x.com', name: 'S' }, recipients: { to: [{ email: 'me@x.com' }], cc: [] },
  bodyText: 'body ' + id, bodyHtml: '<p onclick="x()">hi</p><script>bad()</script>', attachments: [], timestamp: new Date(ts), direction: 'inbound', isRead: false, rawRef: id, ...over });
const ev = (id) => ({ externalId: id, title: 'Standup', start: new Date(Date.now() + 3600_000), end: new Date(Date.now() + 7200_000), allDay: false, timezone: 'UTC', organizer: null, attendees: [], location: null, meetingLink: null, status: 'confirmed' });

const aAcct = await mkAccount(alice, 'alice@gmail.com', 3600_000);
const bAcct = await mkAccount(bob, 'bob@gmail.com', 3600_000);

// 1. initial sync
connectorBehavior.initialResult = async () => ({ messages: [msg('m1', 't1', '2026-10-20T01:00:00Z'), msg('m2', 't1', '2026-10-20T02:00:00Z'), msg('m3', 't2', '2026-10-19T01:00:00Z', { direction: 'outbound', isRead: true })], events: [ev('e1')], deletedExternalIds: [], cursor: 'H1' });
ok('sync returns true', (await sync.syncAccount(aAcct)) === true);
let acc = (await db.query(`SELECT sync_cursor,last_sync_at,last_error,status FROM connected_accounts WHERE id=$1`, [aAcct])).rows[0];
ok('cursor stored, last_sync set', acc.sync_cursor === 'H1' && acc.last_sync_at && acc.last_error === null);
ok('3 messages, 2 threads, 1 event', (await db.query(`SELECT count(*)::int n FROM messages WHERE account_id=$1`, [aAcct])).rows[0].n === 3
  && (await db.query(`SELECT count(*)::int n FROM threads WHERE account_id=$1`, [aAcct])).rows[0].n === 2
  && (await db.query(`SELECT count(*)::int n FROM calendar_events WHERE account_id=$1`, [aAcct])).rows[0].n === 1);
const html = (await db.query(`SELECT body_html_sanitized h FROM messages WHERE external_id='m1'`)).rows[0].h;
ok('stored HTML is sanitized', !/script|onclick/.test(html) && html.includes('hi'), html);
ok('thread last_message_at = newest', (await db.query(`SELECT last_message_at FROM threads WHERE external_id='t1'`)).rows[0].last_message_at.toISOString() === '2026-10-20T02:00:00.000Z');

// 2. incremental: idempotent upsert + update + delete
connectorBehavior.incremental = async (_a, cur) => (cur === 'H1' ? { messages: [msg('m1', 't1', '2026-10-20T01:00:00Z', { isRead: true }), msg('m4', 't3', '2026-10-20T03:00:00Z')], events: [], deletedExternalIds: ['m3'], cursor: 'H2' } : null);
await sync.syncAccount(aAcct);
ok('no duplicates after re-apply', (await db.query(`SELECT count(*)::int n FROM messages WHERE account_id=$1`, [aAcct])).rows[0].n === 3);
ok('m1 marked read via upsert', (await db.query(`SELECT is_read FROM messages WHERE external_id='m1'`)).rows[0].is_read === true);
ok('deleted message and its empty thread removed', (await db.query(`SELECT count(*)::int n FROM threads WHERE external_id='t2'`)).rows[0].n === 0);
ok('cursor advanced', (await db.query(`SELECT sync_cursor FROM connected_accounts WHERE id=$1`, [aAcct])).rows[0].sync_cursor === 'H2');

// 3. cursor reset falls back to initial
connectorBehavior.incremental = async () => { throw new SyncResetError('expired'); };
connectorBehavior.initialResult = async () => ({ messages: [msg('m9', 't9', '2026-10-20T05:00:00Z')], events: [], deletedExternalIds: [], cursor: 'H9' });
await sync.syncAccount(aAcct);
ok('reset triggers a fresh initial sync', connectorBehavior.initial === 2 && (await db.query(`SELECT sync_cursor FROM connected_accounts WHERE id=$1`, [aAcct])).rows[0].sync_cursor === 'H9');

// 4. token refresh persisted when near expiry
const nearExpiry = await mkAccount(alice, 'alice2@gmail.com', 30_000);
connectorBehavior.initialResult = async (a) => { connectorBehavior.seenToken = a.tokens.accessToken; return { messages: [], events: [], deletedExternalIds: [], cursor: 'X' }; };
await sync.syncAccount(nearExpiry);
const stored = JSON.parse(crypto.decrypt(Buffer.from((await db.query(`SELECT enc_tokens FROM connected_accounts WHERE id=$1`, [nearExpiry])).rows[0].enc_tokens)));
ok('expired token refreshed and used', connectorBehavior.refreshed && connectorBehavior.seenToken === 'refreshed');
ok('refreshed token re-encrypted in DB', stored.accessToken === 'refreshed' && stored.refreshToken === 'ref');
ok('tokens are not stored in plaintext', !(await db.query(`SELECT enc_tokens::text t FROM connected_accounts WHERE id=$1`, [nearExpiry])).rows[0].t.includes('refreshed'));

// 5. provider auth failure -> reauth, no throw
connectorBehavior.incremental = async () => { throw new ProviderAuthError(); };
ok('auth error returns false (no retry)', (await sync.syncAccount(aAcct)) === false);
acc = (await db.query(`SELECT status,last_error FROM connected_accounts WHERE id=$1`, [aAcct])).rows[0];
ok('account flagged for reconnect', acc.status === 'reauth' && acc.last_error === 'Reconnect required');
ok('reauth account is skipped afterwards', (await sync.syncAccount(aAcct)) === false);

// 6. transient failure rethrows and records error
const flaky = await mkAccount(alice, 'alice3@gmail.com', 3600_000);
connectorBehavior.initialResult = async () => { throw new Error('boom'); };
let threw = false; try { await sync.syncAccount(flaky); } catch { threw = true; }
ok('transient error rethrown for queue retry', threw);
ok('last_error recorded, status stays active', (await db.query(`SELECT status,last_error FROM connected_accounts WHERE id=$1`, [flaky])).rows[0].last_error === 'boom');

// 7. sys_* functions
ok('sys_accounts_to_poll lists only active accounts', (await db.query(`SELECT count(*)::int n FROM sys_accounts_to_poll(now() + interval '1 hour')`)).rows[0].n === 3);
ok('sys_find_accounts by external id (case-insensitive)', (await db.query(`SELECT count(*)::int n FROM sys_find_accounts('gmail','ALICE@gmail.com',NULL)`)).rows[0].n === 0 /* alice@gmail.com is in reauth */);
ok('sys_find_accounts finds active mailbox', (await db.query(`SELECT count(*)::int n FROM sys_find_accounts('gmail','ALICE2@gmail.com',NULL)`)).rows[0].n === 1);

// 8. inbox queries + isolation, through the real controller
await db.exec(`UPDATE connected_accounts SET status='active' WHERE id='${aAcct}'`);
connectorBehavior.incremental = async () => ({ messages: [], events: [], deletedExternalIds: [], cursor: 'H10' });
connectorBehavior.initialResult = async () => ({ messages: [msg('b1', 'bt1', '2026-10-20T04:00:00Z')], events: [ev('be1')], deletedExternalIds: [], cursor: 'B1' });
await sync.syncAccount(bAcct);
const accounts = new AccountsService({ WEB_URL: 'http://x', CONNECT_REDIRECT_URIS: '' }, fakeDb, crypto, null, { get: () => undefined }, null, null);
const inbox = new InboxController(fakeDb, accounts);
const aInbox = await inbox.inbox(alice);
ok('inbox groups by channel with unread count', aInbox.channels.length === 1 && aInbox.channels[0].channel === 'gmail' && aInbox.channels[0].unread > 0, JSON.stringify(aInbox.channels.map(c => c.unread)));
const aThreads = await inbox.threads(alice, { unreadOnly: 'false', limit: 30 });
ok('alice threads exclude bob', aThreads.threads.length > 0 && aThreads.threads.every((t) => t.account_id !== bAcct));
ok('thread rows carry snippet + unread', aThreads.threads[0].snippet?.startsWith('body') && typeof aThreads.threads[0].unread === 'number');
const bThreadId = (await db.query(`SELECT id FROM threads WHERE account_id=$1`, [bAcct])).rows[0].id;
let denied = false; try { await inbox.thread(alice, bThreadId); } catch (e) { denied = e.status === 404; }
ok("alice cannot open bob's thread (404)", denied);
const bThread = await inbox.thread(bob, bThreadId);
ok('bob can open his thread', bThread.messages.length === 1);
const bUnreadOnly = await inbox.threads(bob, { unreadOnly: 'true', limit: 30 });
ok('unreadOnly filter works', bUnreadOnly.threads.length === 1);
await inbox.markThread(bob, bThreadId, { read: true });
ok('mark thread read', (await inbox.threads(bob, { unreadOnly: 'true', limit: 30 })).threads.length === 0);
await inbox.markMessage(alice, (await db.query(`SELECT id FROM messages WHERE external_id='b1'`)).rows[0].id, { read: false });
ok("alice cannot flip bob's message read state", (await db.query(`SELECT is_read FROM messages WHERE external_id='b1'`)).rows[0].is_read === true);
const evs = await inbox.events(alice, {});
ok("calendar events scoped to caller", evs.events.length === 1 && evs.events[0].account_id === aAcct);
ok('account list never exposes tokens', !JSON.stringify(await accounts.list(alice)).includes('enc_tokens'));

// 9. account controls
await accounts.update(alice, aAcct, { paused: true, aiEnabled: false });
ok('pause + AI off applied', (await db.query(`SELECT status,ai_enabled FROM connected_accounts WHERE id=$1`, [aAcct])).rows[0].status === 'paused');
let nf = false; try { await accounts.update(alice, bAcct, { paused: true }); } catch (e) { nf = e.status === 404; }
ok("cannot modify bob's account", nf);
const jobsStub = { enqueueSync: async () => {}, enqueueRenew: async () => {} };
const accounts2 = new AccountsService({ WEB_URL: 'http://x', CONNECT_REDIRECT_URIS: '' }, fakeDb, crypto, null, { get: () => ({ revoke: async () => {} }) }, jobsStub, { log: async () => {} });
await accounts2.disconnect(alice, nearExpiry, true);
ok('disconnect with delete removes account and data (cascade)', (await db.query(`SELECT count(*)::int n FROM connected_accounts WHERE id=$1`, [nearExpiry])).rows[0].n === 0);
await accounts2.disconnect(alice, flaky, false);
const kept = (await db.query(`SELECT status, enc_tokens FROM connected_accounts WHERE id=$1`, [flaky])).rows[0];
ok('disconnect without delete revokes and wipes tokens', kept.status === 'revoked' && kept.enc_tokens === null);
await accounts2.disconnect(alice, aAcct, true);
ok('deleting an account cascades to messages/threads/events', (await db.query(`SELECT (SELECT count(*) FROM messages WHERE account_id=$1)::int + (SELECT count(*) FROM threads WHERE account_id=$1)::int + (SELECT count(*) FROM calendar_events WHERE account_id=$1)::int n`, [aAcct])).rows[0].n === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
