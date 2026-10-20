-- Phase 2: connected accounts, normalized messages/threads/events. Run as the owner role.

CREATE TABLE connected_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('gmail','google_calendar','outlook','microsoft_calendar')),
  external_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','reauth','error','revoked')),
  enc_tokens bytea,
  scopes text[] NOT NULL DEFAULT '{}',
  sync_cursor text,
  backfill_days int NOT NULL DEFAULT 14 CHECK (backfill_days BETWEEN 1 AND 365),
  ai_enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}',
  subscription_id text,
  subscription_expiry timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, external_id)
);
CREATE INDEX connected_accounts_sub_idx ON connected_accounts(subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX connected_accounts_ext_idx ON connected_accounts(channel, external_id);

CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text NOT NULL,
  subject text,
  last_message_at timestamptz NOT NULL,
  UNIQUE (account_id, external_id)
);
CREATE INDEX threads_user_recent ON threads(user_id, last_message_at DESC);
CREATE INDEX threads_account_recent ON threads(account_id, last_message_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text NOT NULL,
  sender jsonb,
  recipients jsonb NOT NULL DEFAULT '{}',
  subject text,
  body_text text NOT NULL DEFAULT '',
  body_html_sanitized text,
  attachments_meta jsonb NOT NULL DEFAULT '[]',
  "timestamp" timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  is_read boolean NOT NULL DEFAULT false,
  raw_ref text,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body_text, ''))) STORED,
  UNIQUE (account_id, external_id)
);
CREATE INDEX messages_thread_time ON messages(thread_id, "timestamp");
CREATE INDEX messages_user_time ON messages(user_id, "timestamp" DESC);
CREATE INDEX messages_tsv ON messages USING gin(tsv);

CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  timezone text,
  organizer jsonb,
  attendees jsonb NOT NULL DEFAULT '[]',
  location text,
  meeting_link text,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative','cancelled')),
  UNIQUE (account_id, external_id)
);
CREATE INDEX calendar_events_user_start ON calendar_events(user_id, start_at);

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_all ON connected_accounts FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY threads_all ON threads FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY messages_all ON messages FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY events_all ON calendar_events FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());

-- Background workers have no user until they look the account up. These definer functions are the
-- only cross-user reads for sync: they return ids and the minimum context needed to impersonate the owner.
CREATE FUNCTION sys_account_ctx(p_account uuid)
  RETURNS TABLE(user_id uuid, tenant_id uuid, role text, tenant_role text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a.user_id, a.tenant_id, u.role, coalesce(m.role, 'user')
  FROM connected_accounts a JOIN users u ON u.id = a.user_id
  LEFT JOIN memberships m ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
  WHERE a.id = p_account AND NOT u.disabled $$;

CREATE FUNCTION sys_accounts_to_poll(p_before timestamptz) RETURNS SETOF uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM connected_accounts WHERE status = 'active' AND (last_sync_at IS NULL OR last_sync_at < p_before) $$;

CREATE FUNCTION sys_accounts_to_renew(p_before timestamptz) RETURNS SETOF uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM connected_accounts WHERE status = 'active' AND (subscription_expiry IS NULL OR subscription_expiry < p_before) $$;

CREATE FUNCTION sys_find_accounts(p_channel text, p_external_id text, p_subscription text) RETURNS TABLE(id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id FROM connected_accounts a
  WHERE a.status = 'active' AND a.channel = p_channel
    AND ((p_external_id IS NOT NULL AND lower(a.external_id) = lower(p_external_id))
      OR (p_subscription IS NOT NULL AND a.subscription_id = p_subscription)) $$;

REVOKE ALL ON FUNCTION sys_account_ctx(uuid), sys_accounts_to_poll(timestamptz), sys_accounts_to_renew(timestamptz),
  sys_find_accounts(text, text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON connected_accounts, threads, messages, calendar_events TO inbox_app;
    GRANT EXECUTE ON FUNCTION sys_account_ctx(uuid), sys_accounts_to_poll(timestamptz), sys_accounts_to_renew(timestamptz),
      sys_find_accounts(text, text, text) TO inbox_app;
  END IF;
END $$;
