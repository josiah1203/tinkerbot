CREATE TABLE IF NOT EXISTS tinkerbot_factories (
  factory_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  definition_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_factories_organization ON tinkerbot_factories (organization_id, status);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_repositories (
  factory_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  installation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (factory_id, repository_id)
);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_sources (
  source_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('github_issue', 'github_pull_request', 'manual')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_definitions (
  definition_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  yaml TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_definition_versions (
  version_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (factory_id, version)
);

CREATE TABLE IF NOT EXISTS tinkerbot_agent_definitions (
  agent_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  harness TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_stage_definitions (
  stage_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  agent_id TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  approval_required INTEGER NOT NULL DEFAULT 0 CHECK (approval_required IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_work_orders (
  work_order_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('github_issue', 'github_pull_request', 'manual')),
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_factory ON tinkerbot_work_orders (factory_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_org ON tinkerbot_work_orders (organization_id, updated_at);

CREATE TABLE IF NOT EXISTS tinkerbot_work_order_events (
  event_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  cause_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (work_order_id, from_state, to_state, cause_id)
);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_runs (
  run_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_run_stages (
  run_stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tinkerbot_agent_runs (
  agent_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  harness TEXT,
  prompt_hash TEXT,
  definition_hash TEXT,
  input_ref TEXT,
  output_ref TEXT,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_approvals (
  approval_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  signature TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_agent_receipts (
  receipt_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0 CHECK (signed IN (0, 1)),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_evidence_records (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0 CHECK (signed IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_github_publications (
  publication_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  remote_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'superseded')),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, fingerprint, commit_sha, kind)
);

CREATE TABLE IF NOT EXISTS tinkerbot_execution_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  runner TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_job_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS tinkerbot_usage_events (
  usage_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  factory_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_usage_org ON tinkerbot_usage_events (organization_id, created_at);

CREATE TABLE IF NOT EXISTS tinkerbot_benchmark_results (
  benchmark_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_run_tokens (
  token_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  sha TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_seat_ledger (
  organization_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  active_seats INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, period_start)
);

CREATE TABLE IF NOT EXISTS tinkerbot_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);
