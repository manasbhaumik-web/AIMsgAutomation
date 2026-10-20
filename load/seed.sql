-- Synthetic data for load tests. Run as the OWNER role against a test database, never production:
--   psql "$DATABASE_ADMIN_URL" -v pwhash="$(node load/make-hash.mjs LoadTest-Pass-123)" -v users=200 -v msgs=400 -f load/seed.sql
-- Creates loaduser0..loaduser{users-1}@load.test, each with a Gmail-like account, many threads and messages, and priorities.
SELECT set_config('seed.users', :'users', false), set_config('seed.msgs', :'msgs', false), set_config('seed.pwhash', :'pwhash', false);
DO $seed$
DECLARE
  v_user uuid; v_tenant uuid; v_acct uuid; i int;
  n_users int := current_setting('seed.users')::int;
  n_msgs int := current_setting('seed.msgs')::int;
BEGIN
  FOR i IN 0..n_users - 1 LOOP
    SELECT id INTO v_user FROM users WHERE email = format('loaduser%s@load.test', i);
    IF v_user IS NULL THEN
      v_user := auth_create_user(format('loaduser%s@load.test', i)::citext, format('Load User %s', i), current_setting('seed.pwhash'), 'user');
    END IF;
    SELECT tenant_id INTO v_tenant FROM memberships WHERE user_id = v_user;
    INSERT INTO connected_accounts(tenant_id, user_id, channel, external_id, status, sync_cursor, last_sync_at)
      VALUES (v_tenant, v_user, 'gmail', format('loaduser%s@gmail.example', i), 'active', 'C0', now())
      ON CONFLICT (user_id, channel, external_id) DO UPDATE SET last_sync_at = now() RETURNING id INTO v_acct;
    INSERT INTO threads(tenant_id, user_id, account_id, channel, external_id, subject, last_message_at)
      SELECT v_tenant, v_user, v_acct, 'gmail', 't' || g, 'Subject ' || g, now() - make_interval(mins => g)
      FROM generate_series(1, n_msgs / 3) g ON CONFLICT (account_id, external_id) DO NOTHING;
    INSERT INTO messages(tenant_id, user_id, account_id, thread_id, channel, external_id, sender, subject, body_text, "timestamp", direction, is_read)
      SELECT v_tenant, v_user, v_acct, t.id, 'gmail', 'm' || t.external_id || '-' || k,
             jsonb_build_object('email', 'sender' || (k % 5) || '@example.com', 'name', 'Sender ' || (k % 5)),
             t.subject, 'Message ' || k || ' about ' || t.subject || ' lorem ipsum dolor sit amet consectetur adipiscing elit',
             t.last_message_at - make_interval(secs => k), 'inbound', (k % 2 = 0)
      FROM threads t, generate_series(1, 3) k WHERE t.user_id = v_user ON CONFLICT (account_id, external_id) DO NOTHING;
    INSERT INTO thread_analysis(thread_id, tenant_id, user_id, priority, status, analyzed_through)
      SELECT id, v_tenant, v_user, (ARRAY['urgent','needs_reply','fyi','low'])[1 + (abs(hashtext(id::text)) % 4)], 'done', now()
      FROM threads WHERE user_id = v_user ON CONFLICT DO NOTHING;
  END LOOP;
END
$seed$;
