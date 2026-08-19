-- GitLab MR/issue intake. Pipeline/job/deployment/system hooks stay rejected at the webhook.

CREATE TABLE IF NOT EXISTS tinkerbot_work_orders_v4 (
  work_order_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira',
    'github_dependabot', 'github_code_scanning', 'github_secret_scanning',
    'incident', 'support', 'roadmap', 'scheduled',
    'gitlab_issue', 'gitlab_merge_request'
  )),
  source_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  issue_or_pull_request TEXT,
  intent TEXT,
  acceptance_criteria TEXT,
  policy_version TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intake', 'triage', 'specification', 'implementation', 'review', 'verification', 'approval', 'ready', 'merged', 'released', 'blocked', 'failed', 'cancelled', 'unknown')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  product_id TEXT,
  line_id TEXT,
  cell_id TEXT,
  owner TEXT,
  risk TEXT,
  autonomy_mode TEXT,
  output_kind TEXT,
  policy_json TEXT,
  dependencies_json TEXT,
  held_by TEXT
);

INSERT INTO tinkerbot_work_orders_v4 SELECT * FROM tinkerbot_work_orders;
DROP TABLE tinkerbot_work_orders;
ALTER TABLE tinkerbot_work_orders_v4 RENAME TO tinkerbot_work_orders;
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_factory ON tinkerbot_work_orders (factory_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_org ON tinkerbot_work_orders (organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_line ON tinkerbot_work_orders (line_id, status);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_sources_v4 (
  source_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira',
    'github_dependabot', 'github_code_scanning', 'github_secret_scanning',
    'incident', 'support', 'roadmap', 'scheduled',
    'gitlab_issue', 'gitlab_merge_request'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO tinkerbot_factory_sources_v4 SELECT * FROM tinkerbot_factory_sources;
DROP TABLE tinkerbot_factory_sources;
ALTER TABLE tinkerbot_factory_sources_v4 RENAME TO tinkerbot_factory_sources;
