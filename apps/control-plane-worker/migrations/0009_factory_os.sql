-- Factory OS: product graph, production lines, work cells, specs, delivery, skills, evolution.

CREATE TABLE IF NOT EXISTS tinkerbot_work_orders_v3 (
  work_order_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira',
    'github_dependabot', 'github_code_scanning', 'github_secret_scanning',
    'incident', 'support', 'roadmap', 'scheduled'
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

INSERT INTO tinkerbot_work_orders_v3 (
  work_order_id, factory_id, organization_id, source_type, source_id, repository_id,
  issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version,
  definition_digest, current_stage, status, actor, created_at, updated_at
)
SELECT work_order_id, factory_id, organization_id, source_type, source_id, repository_id,
  issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version,
  definition_digest, current_stage, status, actor, created_at, updated_at
FROM tinkerbot_work_orders;
DROP TABLE tinkerbot_work_orders;
ALTER TABLE tinkerbot_work_orders_v3 RENAME TO tinkerbot_work_orders;
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_factory ON tinkerbot_work_orders (factory_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_org ON tinkerbot_work_orders (organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_line ON tinkerbot_work_orders (line_id, status);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_sources_v3 (
  source_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira',
    'github_dependabot', 'github_code_scanning', 'github_secret_scanning',
    'incident', 'support', 'roadmap', 'scheduled'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO tinkerbot_factory_sources_v3 SELECT * FROM tinkerbot_factory_sources;
DROP TABLE tinkerbot_factory_sources;
ALTER TABLE tinkerbot_factory_sources_v3 RENAME TO tinkerbot_factory_sources;

CREATE TABLE IF NOT EXISTS tinkerbot_portfolios (
  portfolio_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_products (
  product_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  portfolio_id TEXT,
  factory_id TEXT,
  name TEXT NOT NULL,
  owners_json TEXT NOT NULL DEFAULT '[]',
  environments_json TEXT NOT NULL DEFAULT '[]',
  risk_class TEXT NOT NULL DEFAULT 'medium',
  customer_facing INTEGER NOT NULL DEFAULT 1 CHECK (customer_facing IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_systems (
  system_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repository TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_services (
  service_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repository TEXT NOT NULL,
  module_path TEXT,
  api_refs_json TEXT NOT NULL DEFAULT '[]',
  owners_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  deprecated INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_architecture_bindings (
  binding_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relationship TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_production_lines (
  line_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  stages_json TEXT NOT NULL,
  agents_json TEXT NOT NULL DEFAULT '[]',
  autonomy TEXT NOT NULL DEFAULT 'approval_gated',
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  approval_roles_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_work_cells (
  cell_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  work_order_id TEXT,
  kind TEXT NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('free', 'leased', 'held', 'abandoned')),
  leased_by TEXT,
  held_by TEXT,
  credential_scope TEXT NOT NULL,
  cleanup_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_cells_repo ON tinkerbot_work_cells (repository, branch, status);

CREATE TABLE IF NOT EXISTS tinkerbot_specifications (
  specification_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  problem TEXT,
  stories_json TEXT NOT NULL DEFAULT '[]',
  nfrs_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT,
  contracts_json TEXT NOT NULL DEFAULT '[]',
  migration_plan TEXT,
  rollout_plan TEXT,
  rollback_plan TEXT,
  test_plan TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'assurance', 'approved', 'rejected')),
  spec_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_architecture_decisions (
  decision_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  product_id TEXT,
  adr_text TEXT NOT NULL,
  affected_services_json TEXT NOT NULL DEFAULT '[]',
  violations_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_change_sets (
  change_set_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_human_decisions (
  decision_id TEXT PRIMARY KEY,
  work_order_id TEXT,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_release_candidates (
  release_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  receipt_ids_json TEXT NOT NULL DEFAULT '[]',
  rollback_refs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  blocking_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_deployments (
  deployment_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow TEXT,
  executed_on_customer_cluster INTEGER NOT NULL DEFAULT 0 CHECK (executed_on_customer_cluster IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_outcomes (
  outcome_id TEXT PRIMARY KEY,
  work_order_id TEXT,
  release_id TEXT,
  kind TEXT NOT NULL,
  association TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_maintenance_tasks (
  task_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  work_order_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_skills (
  skill_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_skill_versions (
  version_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  yaml TEXT NOT NULL,
  rollout TEXT NOT NULL CHECK (rollout IN ('draft', 'evaluate', 'review', 'canary', 'active', 'deprecated')),
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  permission_scope_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version)
);

CREATE TABLE IF NOT EXISTS tinkerbot_improvement_proposals (
  proposal_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  proposed_changes_json TEXT NOT NULL DEFAULT '[]',
  expected_effect TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  benchmark_json TEXT NOT NULL DEFAULT '[]',
  human_approved INTEGER NOT NULL DEFAULT 0 CHECK (human_approved IN (0, 1)),
  steward_actor TEXT,
  auto_merge INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
