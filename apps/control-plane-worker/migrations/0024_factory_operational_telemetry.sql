-- Non-authoritative operational signals for hosted delivery, coordination,
-- shadow reads, execution, verification, provider webhooks, and retention.
-- The ledger contains bounded dimensions only; Factory Graph state remains the
-- lifecycle authority and this table is safe to discard and rebuild.
CREATE TABLE IF NOT EXISTS tinkerbot_factory_operational_telemetry (
  signal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  signal TEXT NOT NULL,
  outcome TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  organization_id TEXT,
  factory_id TEXT,
  work_order_id TEXT,
  duration_ms INTEGER,
  retry_count INTEGER,
  error_code TEXT,
  dimensions_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_operational_telemetry_org
  ON tinkerbot_factory_operational_telemetry (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_operational_telemetry_signal
  ON tinkerbot_factory_operational_telemetry (signal, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_operational_telemetry_created
  ON tinkerbot_factory_operational_telemetry (created_at);
