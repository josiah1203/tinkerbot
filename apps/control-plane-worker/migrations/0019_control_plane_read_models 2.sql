-- Workspace read-model metadata. Secret values are intentionally not stored here.
CREATE TABLE IF NOT EXISTS tinkerbot_environments (
  environment_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  factory_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_environments_org ON tinkerbot_environments (organization_id, updated_at);

CREATE TABLE IF NOT EXISTS tinkerbot_integrations (
  integration_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  scopes TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_integrations_org ON tinkerbot_integrations (organization_id, updated_at);

CREATE TABLE IF NOT EXISTS tinkerbot_secret_metadata (
  secret_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  references_text TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_secret_metadata_org ON tinkerbot_secret_metadata (organization_id, updated_at);
