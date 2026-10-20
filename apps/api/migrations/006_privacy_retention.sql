-- Phase 6: data export, account deletion and retention. Run as the owner role.

-- Audit entries written by the user. Normal users cannot read audit_log through RLS, so the export reads them
-- through this function, which only ever answers for the caller.
CREATE FUNCTION sys_user_audit(p_user uuid) RETURNS TABLE(at timestamptz, action text, target text, meta jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_user IS DISTINCT FROM app_uid() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT a.at, a.action, a.target, a.meta FROM audit_log a WHERE a.actor_id = p_user ORDER BY a.id;
END $$;

-- Right to erasure. Everything the user owns is deleted by ON DELETE CASCADE. Personal tenants and tenants where the
-- user is the only member go with them. Audit entries are kept for security, with the actor removed.
-- Refuses when the user is the last administrator of a shared tenant or the last platform admin.
CREATE FUNCTION sys_delete_user(p_user uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t record; v_role text;
BEGIN
  IF p_user IS DISTINCT FROM app_uid() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  SELECT role INTO v_role FROM users WHERE id = p_user;
  IF v_role IS NULL THEN RETURN; END IF;
  IF v_role = 'admin' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND id <> p_user AND NOT disabled) THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'P0001';
  END IF;
  FOR t IN SELECT m.tenant_id, m.role, (SELECT count(*) FROM memberships x WHERE x.tenant_id = m.tenant_id) AS members,
                  (SELECT count(*) FROM memberships x WHERE x.tenant_id = m.tenant_id AND x.role = 'tenant_admin' AND x.user_id <> p_user) AS other_admins
           FROM memberships m WHERE m.user_id = p_user LOOP
    IF t.members > 1 AND t.role = 'tenant_admin' AND t.other_admins = 0 THEN
      RAISE EXCEPTION 'last_tenant_admin' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOR t IN SELECT m.tenant_id FROM memberships m WHERE m.user_id = p_user AND (SELECT count(*) FROM memberships x WHERE x.tenant_id = m.tenant_id) = 1 LOOP
    DELETE FROM tenants WHERE id = t.tenant_id;
  END LOOP;
  UPDATE audit_log SET actor_id = NULL WHERE actor_id = p_user;
  DELETE FROM users WHERE id = p_user;
  INSERT INTO audit_log(tenant_id, actor_id, action, meta) VALUES (NULL, NULL, 'account.deleted', '{}');
END $$;

-- Retention sweep, run hourly by the worker. Ages are arguments so operators can tune them without a migration.
CREATE FUNCTION sys_purge_expired(p_sessions_days int, p_notifications_days int, p_webhook_days int, p_drafts_days int, p_audit_days int, p_usage_days int)
  RETURNS TABLE(what text, n bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c bigint;
BEGIN
  DELETE FROM device_sessions WHERE expires_at < now() - make_interval(days => p_sessions_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'sessions'; n := c; RETURN NEXT;
  DELETE FROM notifications WHERE created_at < now() - make_interval(days => p_notifications_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'notifications'; n := c; RETURN NEXT;
  DELETE FROM webhook_inbox WHERE received_at < now() - make_interval(days => p_webhook_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'webhook_inbox'; n := c; RETURN NEXT;
  DELETE FROM reply_drafts WHERE status IN ('discarded','failed') AND updated_at < now() - make_interval(days => p_drafts_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'drafts'; n := c; RETURN NEXT;
  DELETE FROM audit_log WHERE at < now() - make_interval(days => p_audit_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'audit_log'; n := c; RETURN NEXT;
  DELETE FROM usage_ledger WHERE at < now() - make_interval(days => p_usage_days); GET DIAGNOSTICS c = ROW_COUNT; what := 'usage_ledger'; n := c; RETURN NEXT;
  -- Per-tenant message retention (tenants.retention_days, set by the tenant admin). Embeddings and analysis cascade from messages.
  DELETE FROM messages m USING tenants t WHERE t.id = m.tenant_id AND t.retention_days IS NOT NULL AND m."timestamp" < now() - make_interval(days => t.retention_days);
  GET DIAGNOSTICS c = ROW_COUNT; what := 'messages'; n := c; RETURN NEXT;
  DELETE FROM calendar_events e USING tenants t WHERE t.id = e.tenant_id AND t.retention_days IS NOT NULL AND e.end_at < now() - make_interval(days => t.retention_days);
  DELETE FROM threads th WHERE NOT EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = th.id);
  GET DIAGNOSTICS c = ROW_COUNT; what := 'empty_threads'; n := c; RETURN NEXT;
END $$;

-- Aggregates only (no identities), for the metrics endpoint.
CREATE FUNCTION sys_account_stats() RETURNS TABLE(channel text, status text, n bigint, oldest_sync_age_s double precision)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT channel, status, count(*), extract(epoch FROM now() - min(last_sync_at) FILTER (WHERE status = 'active'))::double precision
  FROM connected_accounts GROUP BY channel, status $$;

-- Used on every authenticated request so that logout, device revocation, disabling and deletion take effect
-- within seconds instead of when the 15-minute access token expires.
CREATE FUNCTION auth_session_alive(p_session uuid, p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM device_sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.id = p_session AND s.user_id = p_user AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT u.disabled) $$;

REVOKE ALL ON FUNCTION auth_session_alive(uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION sys_user_audit(uuid), sys_delete_user(uuid), sys_purge_expired(int, int, int, int, int, int), sys_account_stats() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN
    GRANT EXECUTE ON FUNCTION auth_session_alive(uuid, uuid), sys_user_audit(uuid), sys_delete_user(uuid), sys_purge_expired(int, int, int, int, int, int), sys_account_stats() TO inbox_app;
  END IF;
END $$;
