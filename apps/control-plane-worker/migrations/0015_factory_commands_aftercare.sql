CREATE TABLE IF NOT EXISTS tinkerbot_factory_commands (
  command_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authorized INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  work_order_id TEXT,
  action TEXT NOT NULL,
  confirmation_required INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tinkerbot_factory_commands_idempotency ON tinkerbot_factory_commands (organization_id, idempotency_key);

CREATE TABLE IF NOT EXISTS tinkerbot_aftercare (
  release_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
