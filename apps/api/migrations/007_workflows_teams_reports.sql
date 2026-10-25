-- Phase 7: user profile and preferences, teams, workflows with approvals, activity log, reports. Run as the owner role.
-- Every table with personal data cascades from users and is protected by row-level security.

-- ---------------------------------------------------------------- profile and preferences
CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_role text CHECK (business_role IS NULL OR length(business_role) <= 120),
  business_goals text CHECK (business_goals IS NULL OR length(business_goals) <= 1000),
  tone text NOT NULL DEFAULT 'neutral' CHECK (length(tone) <= 80),
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  signature text CHECK (signature IS NULL OR length(signature) <= 500),
  timezone text NOT NULL DEFAULT 'UTC',
  work_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  work_start smallint NOT NULL DEFAULT 9 CHECK (work_start BETWEEN 0 AND 23),
  work_end smallint NOT NULL DEFAULT 17 CHECK (work_end BETWEEN 1 AND 24),
  -- Global switch: no workflow may send on its own unless this is on (and the workflow itself is set to auto).
  auto_replies_enabled boolean NOT NULL DEFAULT false,
  escalation_rules jsonb NOT NULL DEFAULT '{}',
  response_policies jsonb NOT NULL DEFAULT '{}',
  report_prefs jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (work_end > work_start)
);

-- ---------------------------------------------------------------- teams
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

-- Invitations go to an email address and exist whether or not that person has an account, so inviting never reveals who is registered.
CREATE TABLE team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member','viewer')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  UNIQUE (team_id, email)
);

CREATE TABLE workflow_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  definition jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The caller's role in a team (NULL when not a member). Definer, so policies on team_members can use it without recursing.
CREATE FUNCTION team_role(p_team uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM team_members WHERE team_id = p_team AND user_id = app_uid() $$;

CREATE FUNCTION my_email() RETURNS citext
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT email FROM users WHERE id = app_uid() $$;

CREATE FUNCTION create_team(p_name text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  IF app_uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  INSERT INTO teams(name, created_by) VALUES (p_name, app_uid()) RETURNING id INTO v;
  INSERT INTO team_members(team_id, user_id, role, added_by) VALUES (v, app_uid(), 'owner', app_uid());
  RETURN v;
END $$;

CREATE FUNCTION accept_team_invite(p_invite uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i team_invites%ROWTYPE;
BEGIN
  SELECT * INTO i FROM team_invites WHERE id = p_invite AND email = my_email() AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO team_members(team_id, user_id, role, added_by) VALUES (i.team_id, app_uid(), i.role, i.invited_by)
    ON CONFLICT (team_id, user_id) DO NOTHING;
  DELETE FROM team_invites WHERE id = p_invite;
  RETURN i.team_id;
END $$;

-- Names and emails of the people on a team, for members of that team only (the users table itself stays private).
CREATE FUNCTION team_roster(p_team uuid) RETURNS TABLE(user_id uuid, role text, name text, email citext, joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.user_id, m.role, u.name, u.email, m.created_at FROM team_members m JOIN users u ON u.id = m.user_id
  WHERE m.team_id = p_team AND team_role(p_team) IS NOT NULL ORDER BY m.created_at $$;

-- Invitations addressed to the caller's own email, with the team name (which a non-member cannot otherwise read).
CREATE FUNCTION my_team_invites() RETURNS TABLE(id uuid, team_id uuid, team_name text, role text, invited_by_name text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.team_id, t.name, i.role, u.name, i.expires_at FROM team_invites i JOIN teams t ON t.id = i.team_id
  LEFT JOIN users u ON u.id = i.invited_by WHERE i.email = my_email() AND i.expires_at > now() ORDER BY i.created_at DESC $$;

-- A team with no owner left (its last owner deleted their account) is removed rather than left unmanaged.
CREATE FUNCTION team_drop_orphans() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM teams WHERE id = OLD.team_id AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = OLD.team_id AND m.role = 'owner');
  RETURN NULL;
END $$;
CREATE TRIGGER team_members_orphans AFTER DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION team_drop_orphans();

-- ---------------------------------------------------------------- workflows, runs, approvals, activity
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  enabled boolean NOT NULL DEFAULT false,
  -- suggest: draft only. ask: every send or calendar change waits for approval. auto: replies may send within the policy.
  autonomy text NOT NULL DEFAULT 'ask' CHECK (autonomy IN ('suggest','ask','auto')),
  trigger jsonb NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}',
  template_id uuid REFERENCES workflow_templates(id) ON DELETE SET NULL,
  -- Message triggers only look at mail that arrived after this instant, so enabling a workflow never acts on old mail.
  scan_from timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_user ON workflows(user_id, enabled);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_type text NOT NULL,
  -- A message or schedule slot starts at most one run per workflow.
  dedupe_key text NOT NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','waiting_approval','failed')),
  steps jsonb NOT NULL DEFAULT '[]',
  error text,
  manual boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workflow_id, dedupe_key)
);
CREATE INDEX workflow_runs_user ON workflow_runs(user_id, started_at DESC);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('send_reply','create_event')),
  summary text NOT NULL,
  -- Exactly what will happen. The user approves by presenting the hash of this payload as they saw it.
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executed','rejected','expired','failed')),
  error text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_user_status ON approvals(user_id, status, created_at DESC);

-- What the user can read about everything the system did for them.
CREATE TABLE activity_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  actor text NOT NULL CHECK (actor IN ('user','workflow','system')),
  kind text NOT NULL,
  summary text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_user_at ON activity_log(user_id, at DESC);

-- ---------------------------------------------------------------- reports
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inbox','actions','calendar','weekly')),
  format text NOT NULL CHECK (format IN ('pdf','docx','xlsx')),
  params jsonb NOT NULL DEFAULT '{}',
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  -- The file is encrypted with the same envelope scheme as provider tokens.
  enc_body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX reports_user ON reports(user_id, created_at DESC);

-- ---------------------------------------------------------------- row-level security
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_all ON user_profiles FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY workflows_all ON workflows FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY runs_all ON workflow_runs FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY approvals_all ON approvals FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY activity_all ON activity_log FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
CREATE POLICY reports_all ON reports FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());

CREATE POLICY teams_sel ON teams FOR SELECT USING (team_role(id) IS NOT NULL);
CREATE POLICY teams_upd ON teams FOR UPDATE USING (team_role(id) IN ('owner','admin'));
CREATE POLICY teams_del ON teams FOR DELETE USING (team_role(id) = 'owner');

CREATE POLICY members_sel ON team_members FOR SELECT USING (team_role(team_id) IS NOT NULL);
-- Only the owner sets admins; an admin manages members and viewers; nobody edits an owner row.
CREATE POLICY members_upd ON team_members FOR UPDATE
  USING (role <> 'owner' AND (team_role(team_id) = 'owner' OR (team_role(team_id) = 'admin' AND role IN ('member','viewer'))))
  WITH CHECK (role IN ('member','viewer') OR (role = 'admin' AND team_role(team_id) = 'owner'));
CREATE POLICY members_del ON team_members FOR DELETE
  USING (role <> 'owner' AND (user_id = app_uid() OR team_role(team_id) = 'owner' OR (team_role(team_id) = 'admin' AND role IN ('member','viewer'))));

CREATE POLICY invites_sel ON team_invites FOR SELECT USING (team_role(team_id) IN ('owner','admin') OR email = my_email());
CREATE POLICY invites_ins ON team_invites FOR INSERT
  WITH CHECK (invited_by = app_uid() AND team_role(team_id) IN ('owner','admin') AND (role IN ('member','viewer') OR (role = 'admin' AND team_role(team_id) = 'owner')));
-- Inviting the same address again refreshes the role and the expiry, so admins need UPDATE too.
CREATE POLICY invites_upd ON team_invites FOR UPDATE USING (team_role(team_id) IN ('owner','admin'))
  WITH CHECK (invited_by = app_uid() AND team_role(team_id) IN ('owner','admin') AND (role IN ('member','viewer') OR (role = 'admin' AND team_role(team_id) = 'owner')));
CREATE POLICY invites_del ON team_invites FOR DELETE USING (team_role(team_id) IN ('owner','admin') OR email = my_email());

CREATE POLICY templates_sel ON workflow_templates FOR SELECT USING (team_role(team_id) IS NOT NULL);
CREATE POLICY templates_ins ON workflow_templates FOR INSERT WITH CHECK (team_role(team_id) IN ('owner','admin') AND created_by = app_uid());
CREATE POLICY templates_upd ON workflow_templates FOR UPDATE USING (team_role(team_id) IN ('owner','admin'));
CREATE POLICY templates_del ON workflow_templates FOR DELETE USING (team_role(team_id) IN ('owner','admin'));

-- ---------------------------------------------------------------- worker lookups (ids only)
-- Users who have an enabled scheduled workflow. The worker then acts as each user through sys_user_ctx.
CREATE FUNCTION sys_users_with_schedules() RETURNS SETOF uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT user_id FROM workflows WHERE enabled AND trigger ->> 'type' = 'schedule' $$;

-- Approvals nobody decided in time are closed, so an old request can never be executed by surprise.
CREATE FUNCTION sys_expire_approvals() RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH e AS (UPDATE approvals SET status = 'expired', decided_at = now() WHERE status = 'pending' AND expires_at < now() RETURNING 1)
  SELECT count(*)::int FROM e $$;

CREATE FUNCTION sys_purge_reports() RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (DELETE FROM reports WHERE expires_at < now() RETURNING 1) SELECT count(*)::int FROM d $$;

REVOKE ALL ON FUNCTION sys_users_with_schedules(), sys_expire_approvals(), sys_purge_reports(), create_team(text), accept_team_invite(uuid), my_email(), team_role(uuid),
  team_roster(uuid), my_team_invites(), team_drop_orphans() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles, workflows, workflow_runs, approvals, activity_log, reports TO inbox_app;
    GRANT SELECT, UPDATE, DELETE ON teams, team_members TO inbox_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON team_invites TO inbox_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_templates TO inbox_app;
    GRANT USAGE ON SEQUENCE activity_log_id_seq TO inbox_app;
    GRANT EXECUTE ON FUNCTION sys_users_with_schedules(), sys_expire_approvals(), sys_purge_reports(), create_team(text), accept_team_invite(uuid), my_email(), team_role(uuid),
      team_roster(uuid), my_team_invites() TO inbox_app;
  END IF;
END $$;
