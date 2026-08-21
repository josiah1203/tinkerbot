-- ADR-0010: durable per-WorkOrder command receipts and ordered graph events.
-- Existing graph rows remain readable; nullable metadata lets the migration
-- preserve their historical ordering while all new command writes carry the
-- full spine envelope.
ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN aggregate_sequence INTEGER;
ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN command_id TEXT;
ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN payload_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_graph_events_sequence
  ON tinkerbot_factory_graph_events (aggregate_id, aggregate_sequence);
CREATE INDEX IF NOT EXISTS idx_factory_graph_events_command
  ON tinkerbot_factory_graph_events (organization_id, aggregate_id, command_id);

CREATE TABLE IF NOT EXISTS tinkerbot_factory_command_receipts (
  organization_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  command_id TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, work_order_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_factory_command_receipts_work_order
  ON tinkerbot_factory_command_receipts (organization_id, work_order_id, created_at);
