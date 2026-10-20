-- Phase 4: chat channels (Slack, Teams, WhatsApp Business, LinkedIn stub). Run as the owner role.

ALTER TABLE connected_accounts DROP CONSTRAINT connected_accounts_channel_check;
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_channel_check
  CHECK (channel IN ('gmail','google_calendar','outlook','microsoft_calendar','slack','teams','whatsapp','linkedin'));

-- Webhook for a whole Slack workspace: find every connected user of a team by external-id prefix.
CREATE FUNCTION sys_find_accounts_prefix(p_channel text, p_prefix text) RETURNS TABLE(id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id FROM connected_accounts a
  WHERE a.status = 'active' AND a.channel = p_channel AND p_prefix <> '' AND starts_with(lower(a.external_id), lower(p_prefix)) $$;

-- WhatsApp Cloud API has no history endpoint, so verified webhook content must be stored before we answer 200.
-- Payloads are encrypted by the application; rows are deleted as soon as the sync worker has ingested them.
CREATE TABLE webhook_inbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  enc_payload bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_inbox_account ON webhook_inbox(account_id, id);
ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_inbox_all ON webhook_inbox FOR ALL USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());

-- The only writer: the unauthenticated webhook endpoint, after it has verified the provider's signature.
-- It resolves tenant and user itself, so the caller cannot choose whose inbox receives the row.
CREATE FUNCTION sys_push_webhook_event(p_account uuid, p_payload bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO webhook_inbox(tenant_id, user_id, account_id, enc_payload)
  SELECT a.tenant_id, a.user_id, a.id, p_payload FROM connected_accounts a WHERE a.id = p_account AND a.status = 'active' $$;

REVOKE ALL ON FUNCTION sys_find_accounts_prefix(text, text), sys_push_webhook_event(uuid, bytea) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_app') THEN
    GRANT SELECT, DELETE ON webhook_inbox TO inbox_app;
    GRANT USAGE ON SEQUENCE webhook_inbox_id_seq TO inbox_app;
    GRANT EXECUTE ON FUNCTION sys_find_accounts_prefix(text, text), sys_push_webhook_event(uuid, bytea) TO inbox_app;
  END IF;
END $$;
