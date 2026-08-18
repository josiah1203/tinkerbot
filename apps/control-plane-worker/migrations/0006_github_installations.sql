CREATE TABLE IF NOT EXISTS tinkerbot_github_installations (
  installation_id INTEGER PRIMARY KEY,
  organization_id TEXT,
  account_id INTEGER,
  account_login TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_github_installations_organization
  ON tinkerbot_github_installations (organization_id, status);

CREATE TABLE IF NOT EXISTS tinkerbot_github_repositories (
  repository_id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  visibility TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'suspended')),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, full_name),
  FOREIGN KEY (installation_id) REFERENCES tinkerbot_github_installations(installation_id)
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_github_repositories_installation
  ON tinkerbot_github_repositories (installation_id, status);
