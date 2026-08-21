import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  isFactoryOperationalSignal,
  parseFactoryTelemetryRetentionDays,
  type FactoryCommandTelemetry,
  type FactoryOperationalSignal,
} from "../../../packages/factory/src";

/**
 * D1 operational telemetry is deliberately isolated from graph persistence.
 * These ledgers are bounded, discardable evidence and never participate in a
 * lifecycle command's authority or projection correctness.
 */
export class D1FactoryTelemetryStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async persistCommandTelemetry(telemetry: FactoryCommandTelemetry): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_factory_command_telemetry (telemetry_id, command_id, organization_id, factory_id, work_order_id, idempotency_key, payload_fingerprint, correlation_id, outcome, event_count, projection_event_count, projection_status, aggregate_sequence, duration_ms, error_code, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)").bind(
      crypto.randomUUID(), telemetry.commandId, telemetry.organizationId, telemetry.factoryId, telemetry.workOrderId, telemetry.idempotencyKey, telemetry.payloadFingerprint, telemetry.correlationId, telemetry.outcome, telemetry.eventCount, telemetry.projectionEventCount, telemetry.projectionStatus, telemetry.aggregateSequence ?? null, telemetry.durationMs, telemetry.errorCode ?? null, new Date().toISOString(),
    ).run();
  }

  async pruneCommandTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<number> {
    const cutoff = this.cutoff(retentionDays, now);
    const result = await this.database.prepare("DELETE FROM tinkerbot_factory_command_telemetry WHERE created_at < ?1").bind(cutoff).run() as { meta?: { changes?: number } };
    return Math.max(0, Number(result.meta?.changes ?? 0));
  }

  async persistOperationalSignal(signal: FactoryOperationalSignal): Promise<void> {
    if (!isFactoryOperationalSignal(signal)) throw new Error("factory_operational_signal_invalid");
    await this.database.prepare("INSERT INTO tinkerbot_factory_operational_telemetry (signal_id, schema_version, signal, outcome, correlation_id, organization_id, factory_id, work_order_id, duration_ms, retry_count, error_code, dimensions_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)").bind(
      crypto.randomUUID(), signal.schemaVersion, signal.signal, signal.outcome, signal.correlationId, signal.organizationId ?? null, signal.factoryId ?? null, signal.workOrderId ?? null, signal.durationMs ?? null, signal.retryCount ?? null, signal.errorCode ?? null, signal.dimensions ? JSON.stringify(signal.dimensions) : null, signal.createdAt,
    ).run();
  }

  async pruneOperationalTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<number> {
    const cutoff = this.cutoff(retentionDays, now);
    const result = await this.database.prepare("DELETE FROM tinkerbot_factory_operational_telemetry WHERE created_at < ?1").bind(cutoff).run() as { meta?: { changes?: number } };
    return Math.max(0, Number(result.meta?.changes ?? 0));
  }

  async pruneTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<{ commandDeleted: number; operationalDeleted: number }> {
    const commandDeleted = await this.pruneCommandTelemetry(retentionDays, now);
    const operationalDeleted = await this.pruneOperationalTelemetry(retentionDays, now);
    return { commandDeleted, operationalDeleted };
  }

  private cutoff(retentionDays: number, now: string): string {
    const days = parseFactoryTelemetryRetentionDays(retentionDays);
    if (days === null) throw new Error("factory_telemetry_retention_invalid");
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error("factory_telemetry_retention_timestamp_invalid");
    return new Date(timestamp - days * 86_400_000).toISOString();
  }
}
