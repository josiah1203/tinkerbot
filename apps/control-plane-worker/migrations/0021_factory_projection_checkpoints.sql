-- ADR-0010 projection recovery state. The Factory Graph remains the source of
-- truth; this table makes compatibility projection lag and retry state durable.
CREATE TABLE IF NOT EXISTS tinkerbot_factory_projection_checkpoints (
  organization_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  last_event_id TEXT,
  last_aggregate_sequence INTEGER,
  projection_json TEXT NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'RETRY_PENDING')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, aggregate_id)
);

CREATE INDEX IF NOT EXISTS idx_factory_projection_checkpoints_retry
  ON tinkerbot_factory_projection_checkpoints (status, updated_at);
