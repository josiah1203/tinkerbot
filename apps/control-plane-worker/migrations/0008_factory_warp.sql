-- Warp-parity factory: conversations, scorers, automations, broader intake.
-- Recreate work_orders / factory_sources with additional source types (SQLite cannot alter CHECK).

CREATE TABLE IF NOT EXISTS tinkerbot_work_orders_v2 (
  work_order_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira')),
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

INSERT INTO tinkerbot_work_orders_v2 SELECT * FROM tinkerbot_work_orders;
DROP TABLE tinkerbot_work_orders;
ALTER TABLE tinkerbot_work_orders_v2 RENAME TO tinkerbot_work_orders;
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_factory ON tinkerbot_work_orders (factory_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_work_orders_org ON tinkerbot_work_orders (organization_id, updated_at);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_sources_v2 (
  source_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('github_issue', 'github_pull_request', 'manual', 'mcp', 'slack', 'linear', 'jira')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO tinkerbot_factory_sources_v2 SELECT * FROM tinkerbot_factory_sources;
DROP TABLE tinkerbot_factory_sources;
ALTER TABLE tinkerbot_factory_sources_v2 RENAME TO tinkerbot_factory_sources;

CREATE TABLE IF NOT EXISTS tinkerbot_conversations (
  conversation_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  zdr INTEGER NOT NULL DEFAULT 1 CHECK (zdr IN (0, 1)),
  training INTEGER NOT NULL DEFAULT 0 CHECK (training IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  tool_names_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_scorers (
  scorer_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  criteria TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  self_improve INTEGER NOT NULL DEFAULT 0 CHECK (self_improve IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_benchmark_suites (
  suite_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_self_improvement_tasks (
  task_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  scorer_id TEXT,
  work_order_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_memories (
  memory_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  vectorize_id TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_custom_agents (
  agent_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinkerbot_automations (
  automation_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
