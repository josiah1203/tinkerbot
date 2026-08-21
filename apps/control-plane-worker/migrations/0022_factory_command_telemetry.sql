-- Non-authoritative command telemetry. It contains no command payload and is
-- safe to discard/rebuild; the Factory Graph and command receipts remain the
-- lifecycle authority.
CREATE TABLE IF NOT EXISTS tinkerbot_factory_command_telemetry (
  telemetry_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  projection_event_count INTEGER NOT NULL,
  projection_status TEXT NOT NULL,
  aggregate_sequence INTEGER,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_command_telemetry_org
  ON tinkerbot_factory_command_telemetry (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_command_telemetry_work_order
  ON tinkerbot_factory_command_telemetry (work_order_id, created_at);
