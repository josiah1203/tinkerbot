ALTER TABLE tinkerbot_memberships ADD COLUMN identity_type TEXT NOT NULL DEFAULT 'human';
ALTER TABLE tinkerbot_memberships ADD COLUMN access_state TEXT NOT NULL DEFAULT 'enabled';

UPDATE tinkerbot_memberships SET identity_type = 'human' WHERE identity_type IS NULL OR identity_type = '';
UPDATE tinkerbot_memberships SET access_state = 'enabled' WHERE access_state IS NULL OR access_state = '';

CREATE TABLE IF NOT EXISTS tinkerbot_membership_billing_states (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  identity_type TEXT NOT NULL DEFAULT 'human',
  access_state TEXT NOT NULL DEFAULT 'enabled',
  membership_status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS tinkerbot_seat_ledger_events (
  event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT,
  transition TEXT NOT NULL,
  quantity_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_seat_ledger_org ON tinkerbot_seat_ledger_events (organization_id, created_at);

CREATE TABLE IF NOT EXISTS tinkerbot_trial_records (
  organization_id TEXT NOT NULL,
  trial_type TEXT NOT NULL DEFAULT 'team',
  state TEXT NOT NULL,
  workos_organization_id TEXT,
  stripe_customer_id TEXT,
  predecessor_organization_id TEXT,
  started_at TEXT,
  ends_at TEXT,
  converted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, trial_type)
);

CREATE TABLE IF NOT EXISTS tinkerbot_checkout_sessions (
  checkout_session_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  seat_quantity INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tinkerbot_checkout_idempotency ON tinkerbot_checkout_sessions (organization_id, idempotency_key);

CREATE TABLE IF NOT EXISTS tinkerbot_enterprise_entitlement_grants (
  grant_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  expires_at TEXT,
  signed_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_enterprise_grants_org ON tinkerbot_enterprise_entitlement_grants (organization_id, entitlement_key);

CREATE TABLE IF NOT EXISTS tinkerbot_ai_cost_events (
  event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  factory_id TEXT,
  seat_id TEXT,
  service_identity_id TEXT,
  work_order_id TEXT,
  run_id TEXT,
  stage_id TEXT,
  agent_id TEXT,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_minor INTEGER NOT NULL DEFAULT 0,
  cost_catalog_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_ai_cost_org ON tinkerbot_ai_cost_events (organization_id, created_at);

CREATE TABLE IF NOT EXISTS tinkerbot_billing_audit_events (
  event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  organization_id TEXT,
  status TEXT NOT NULL,
  expected_quantity INTEGER,
  actual_quantity INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_organization_roles (
  role_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS tinkerbot_service_credentials (
  credential_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tinkerbot_service_token_hash ON tinkerbot_service_credentials (token_hash);

CREATE TABLE IF NOT EXISTS tinkerbot_notification_destinations (
  destination_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slack', 'teams')),
  webhook_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_sso_connections (
  organization_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO tinkerbot_membership_billing_states (organization_id, user_id, billable, identity_type, access_state, membership_status, updated_at)
SELECT organization_id, user_id, CASE WHEN status = 'active' THEN 1 ELSE 0 END, 'human', 'enabled', status, updated_at
FROM tinkerbot_memberships
WHERE NOT EXISTS (
  SELECT 1 FROM tinkerbot_membership_billing_states s
  WHERE s.organization_id = tinkerbot_memberships.organization_id AND s.user_id = tinkerbot_memberships.user_id
);
