CREATE TABLE IF NOT EXISTS tinkerbot_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_organizations (
  organization_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_memberships (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_memberships_user ON tinkerbot_memberships (user_id, status);

CREATE TABLE IF NOT EXISTS tinkerbot_entitlements (
  organization_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  billing_status TEXT NOT NULL,
  private_repository_limit INTEGER NOT NULL DEFAULT 0,
  member_limit INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 0,
  features_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
