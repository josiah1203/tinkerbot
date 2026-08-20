CREATE TABLE IF NOT EXISTS tinkerbot_execution_plans (
  plan_id TEXT PRIMARY KEY,
  work_order_id TEXT,
  run_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'hosted')),
  profile_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  selected_pipeline TEXT NOT NULL,
  escalation_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_execution_plans_work_order ON tinkerbot_execution_plans (work_order_id);

CREATE TABLE IF NOT EXISTS tinkerbot_cost_estimates (
  plan_id TEXT PRIMARY KEY,
  catalog_version TEXT NOT NULL,
  estimate_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_cost_actuals (
  actual_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 1 CHECK (managed IN (0, 1)),
  catalog_version TEXT NOT NULL,
  runner_origin TEXT NOT NULL CHECK (runner_origin IN ('local', 'hosted')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_cost_actuals_run ON tinkerbot_cost_actuals (run_id);

CREATE TABLE IF NOT EXISTS tinkerbot_provider_metadata (
  provider_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  credential_ref TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_eval_suites (
  suite_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yaml TEXT NOT NULL,
  baseline_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_eval_tasks (
  task_id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_eval_attempts (
  attempt_id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  output TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_sync_outbox (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tinkerbot_inline_approvals (
  approval_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  approver TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  base_sha TEXT,
  head_sha TEXT,
  evidence_digest TEXT,
  reviewed_ac TEXT,
  rationale TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  created_at TEXT NOT NULL
);
