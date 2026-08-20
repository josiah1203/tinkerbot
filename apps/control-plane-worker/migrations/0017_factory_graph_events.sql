-- Canonical append-only Factory Graph ledger. Provider-specific records remain references, not domain state.
CREATE TABLE IF NOT EXISTS tinkerbot_factory_graph_events (
  event_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  policy_version TEXT,
  provenance TEXT NOT NULL,
  external_references_json TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_graph_events_aggregate ON tinkerbot_factory_graph_events (aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_factory_graph_events_tenant ON tinkerbot_factory_graph_events (organization_id, factory_id, occurred_at);
