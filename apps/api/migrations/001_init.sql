-- Phase 1 foundation: identity, tenancy, LLM admin config, audit. Run as the owner role.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','org')),
  retention_days int CHECK (retention_days IS NULL OR retention_days > 0),
  ai_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  name text,
  password_hash text,
  locale text NOT NULL DEFAULT 'en',
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  settings jsonb NOT NULL DEFAULT '{}',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','microsoft')),
  subject text NOT NULL,
  email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('tenant_admin','user')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  prev_refresh_hash text,
  device_name text,
  push_token text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_sessions_prev_idx ON device_sessions(prev_refresh_hash);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);

CREATE TABLE llm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('anthropic','openai','azure-openai','google','xai','ollama')),
  base_url text,
  enc_api_key bytea,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_routes (
  task text PRIMARY KEY CHECK (task IN ('classify','topic-tag','summarize','chat','draft-reply','embed')),
  provider_id uuid NOT NULL REFERENCES llm_providers(id),
  model text NOT NULL,
  temperature real NOT NULL DEFAULT 0.2 CHECK (temperature BETWEEN 0 AND 2),
  max_tokens int NOT NULL DEFAULT 1024 CHECK (max_tokens > 0),
  timeout_ms int NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
  retries int NOT NULL DEFAULT 2 CHECK (retries BETWEEN 0 AND 5),
  fallback_provider_id uuid REFERENCES llm_providers(id),
  fallback_model text,
  price_in_per_mtok numeric,
  price_out_per_mtok numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prompt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task text NOT NULL,
  version int NOT NULL,
  system text,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task, version)
);
CREATE UNIQUE INDEX one_active_prompt ON prompt_templates(task) WHERE active;

CREATE TABLE quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global','tenant','user')),
  scope_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  tokens_per_day bigint CHECK (tokens_per_day IS NULL OR tokens_per_day >= 0),
  requests_per_min int CHECK (requests_per_min IS NULL OR requests_per_min > 0),
  UNIQUE (scope, scope_id)
);

CREATE TABLE usage_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  task text NOT NULL,
  provider_kind text NOT NULL,
  model text NOT NULL,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  cost numeric,
  latency_ms int,
  ok boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_user_at ON usage_ledger(user_id, at DESC);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_id uuid,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

-- Request context helpers (set per transaction by the application)
CREATE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_tid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.role', true), '') $$;
CREATE FUNCTION app_trole() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_role', true), '') $$;

-- Pre-authentication lookups must run before a user context exists. They are the only
-- code paths that read across users, and each returns at most what login needs.
CREATE FUNCTION auth_find_user(p_email citext) RETURNS SETOF users
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM users WHERE email = p_email $$;

CREATE FUNCTION auth_find_user_by_id(p_id uuid) RETURNS SETOF users
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM users WHERE id = p_id $$;

CREATE FUNCTION auth_find_user_by_identity(p_provider text, p_subject text) RETURNS SETOF users
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.* FROM users u JOIN user_identities i ON i.user_id = u.id
  WHERE i.provider = p_provider AND i.subject = p_subject $$;

CREATE FUNCTION auth_user_context(p_user uuid) RETURNS TABLE(tenant_id uuid, tenant_role text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user ORDER BY (t.kind = 'personal') DESC, t.created_at LIMIT 1 $$;

CREATE FUNCTION auth_create_user(p_email citext, p_name text, p_hash text, p_role text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  INSERT INTO users(email, name, password_hash, role) VALUES (p_email, p_name, p_hash, p_role) RETURNING id INTO v_user;
  INSERT INTO tenants(name, kind) VALUES (coalesce(p_name, p_email::text), 'personal') RETURNING id INTO v_tenant;
  INSERT INTO memberships(tenant_id, user_id, role) VALUES (v_tenant, v_user, 'tenant_admin');
  RETURN v_user;
END $$;

CREATE FUNCTION auth_link_identity(p_user uuid, p_provider text, p_subject text, p_email citext) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO user_identities(user_id, provider, subject, email) VALUES (p_user, p_provider, p_subject, p_email)
  ON CONFLICT (provider, subject) DO NOTHING $$;

CREATE FUNCTION auth_find_session(p_hash text) RETURNS SETOF device_sessions
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM device_sessions WHERE refresh_hash = p_hash OR prev_refresh_hash = p_hash $$;

REVOKE ALL ON FUNCTION auth_find_user(citext), auth_find_user_by_id(uuid), auth_find_user_by_identity(text, text),
  auth_user_context(uuid), auth_create_user(citext, text, text, text), auth_link_identity(uuid, text, text, citext),
  auth_find_session(text) FROM PUBLIC;

-- Row-level security. The runtime role does not own these tables, so policies always apply to it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_sel ON tenants FOR SELECT USING (id = app_tid() OR app_role() = 'admin');
CREATE POLICY tenants_upd ON tenants FOR UPDATE USING (id = app_tid() AND app_trole() = 'tenant_admin');

CREATE POLICY users_sel ON users FOR SELECT USING (id = app_uid() OR app_role() = 'admin');
CREATE POLICY users_upd ON users FOR UPDATE USING (id = app_uid());
CREATE POLICY users_del ON users FOR DELETE USING (id = app_uid());

CREATE POLICY identities_sel ON user_identities FOR SELECT USING (user_id = app_uid());
CREATE POLICY identities_del ON user_identities FOR DELETE USING (user_id = app_uid());

CREATE POLICY memberships_sel ON memberships FOR SELECT
  USING (user_id = app_uid() OR (tenant_id = app_tid() AND app_trole() = 'tenant_admin'));

CREATE POLICY sessions_all ON device_sessions FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY consents_all ON consents FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());

CREATE POLICY providers_sel ON llm_providers FOR SELECT USING (true);
CREATE POLICY providers_mod ON llm_providers FOR ALL USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');
CREATE POLICY routes_sel ON llm_routes FOR SELECT USING (true);
CREATE POLICY routes_mod ON llm_routes FOR ALL USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');
CREATE POLICY prompts_sel ON prompt_templates FOR SELECT USING (true);
CREATE POLICY prompts_mod ON prompt_templates FOR ALL USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');
CREATE POLICY quotas_sel ON quotas FOR SELECT USING (true);
CREATE POLICY quotas_mod ON quotas FOR ALL USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY ledger_sel ON usage_ledger FOR SELECT
  USING (user_id = app_uid() OR app_role() = 'admin' OR (tenant_id = app_tid() AND app_trole() = 'tenant_admin'));
CREATE POLICY ledger_ins ON usage_ledger FOR INSERT WITH CHECK (user_id = app_uid());

CREATE POLICY audit_sel ON audit_log FOR SELECT
  USING (app_role() = 'admin' OR (tenant_id = app_tid() AND app_trole() = 'tenant_admin'));
CREATE POLICY audit_ins ON audit_log FOR INSERT WITH CHECK (true);

-- Grants for the runtime role (created outside migrations; skipped if absent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN
    GRANT USAGE ON SCHEMA public TO inbox_app;
    GRANT SELECT, INSERT, DELETE ON device_sessions, consents, llm_providers, llm_routes, prompt_templates, quotas, usage_ledger, audit_log TO inbox_app;
    GRANT UPDATE ON device_sessions, consents, llm_providers, llm_routes, prompt_templates, quotas TO inbox_app;
    GRANT SELECT ON tenants, users, user_identities, memberships TO inbox_app;
    GRANT DELETE ON users, user_identities TO inbox_app;
    -- Column-level grants prevent self-service role escalation.
    GRANT UPDATE (name, locale, settings) ON users TO inbox_app;
    GRANT UPDATE (name, retention_days, ai_enabled) ON tenants TO inbox_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO inbox_app;
    GRANT EXECUTE ON FUNCTION app_uid(), app_tid(), app_role(), app_trole(),
      auth_find_user(citext), auth_find_user_by_id(uuid), auth_find_user_by_identity(text, text),
      auth_user_context(uuid), auth_create_user(citext, text, text, text), auth_link_identity(uuid, text, text, citext),
      auth_find_session(text) TO inbox_app;
  END IF;
END $$;
