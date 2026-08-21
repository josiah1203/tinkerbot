-- Telemetry is disposable operational evidence. The lifecycle graph,
-- command receipts, and projections are intentionally excluded from cleanup.
CREATE INDEX IF NOT EXISTS idx_factory_command_telemetry_created
  ON tinkerbot_factory_command_telemetry (created_at);
