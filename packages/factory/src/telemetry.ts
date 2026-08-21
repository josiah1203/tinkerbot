export type FactoryCommandOutcome = "committed" | "replayed" | "failed";
export type FactoryCommandProjectionStatus = "available" | "unavailable";

export const FACTORY_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const FACTORY_COMMAND_TELEMETRY_DEFAULT_RETENTION_DAYS = 30;
export const FACTORY_COMMAND_TELEMETRY_MAX_RETENTION_DAYS = 3_650;

/**
 * Operational signals are intentionally separate from command telemetry. They
 * describe delivery and infrastructure behavior, but never carry a command
 * payload and never participate in lifecycle decisions.
 */
export type FactoryOperationalSignalName =
  | "queue_delivery"
  | "foreman_coordination"
  | "projection_shadow_read"
  | "self_hosted_dispatch"
  | "self_hosted_completion"
  | "verification_ingest"
  | "provider_webhook"
  | "telemetry_retention";

export type FactoryOperationalOutcome = "accepted" | "completed" | "failed" | "blocked" | "replayed";

const FACTORY_OPERATIONAL_SIGNALS = new Set<FactoryOperationalSignalName>([
  "queue_delivery",
  "foreman_coordination",
  "projection_shadow_read",
  "self_hosted_dispatch",
  "self_hosted_completion",
  "verification_ingest",
  "provider_webhook",
  "telemetry_retention",
]);
const FACTORY_OPERATIONAL_OUTCOMES = new Set<FactoryOperationalOutcome>(["accepted", "completed", "failed", "blocked", "replayed"]);

function isSafeOperationalDimensions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, item]) => /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
    && !/payload|prompt|secret|credential|token|authorization/i.test(key)
    && (typeof item !== "string" || item.length <= 256)
    && (typeof item !== "number" || Number.isFinite(item))
    && (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null));
}

export interface FactoryOperationalSignal {
  kind: "factory_operational";
  schemaVersion: typeof FACTORY_TELEMETRY_SCHEMA_VERSION;
  signal: FactoryOperationalSignalName;
  outcome: FactoryOperationalOutcome;
  correlationId: string;
  organizationId?: string;
  factoryId?: string;
  workOrderId?: string;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
  /** Bounded scalar dimensions only; payloads, prompts, and credentials are forbidden. */
  dimensions?: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export function parseFactoryTelemetryRetentionDays(value: unknown): number | null {
  const candidate = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= FACTORY_COMMAND_TELEMETRY_MAX_RETENTION_DAYS ? candidate : null;
}

export function createFactoryOperationalSignal(input: Omit<FactoryOperationalSignal, "kind" | "schemaVersion">): FactoryOperationalSignal {
  if (!FACTORY_OPERATIONAL_SIGNALS.has(input.signal)) throw new Error("factory_operational_signal_name_invalid");
  if (!FACTORY_OPERATIONAL_OUTCOMES.has(input.outcome)) throw new Error("factory_operational_signal_outcome_invalid");
  if (!input.correlationId || input.correlationId.length > 192) throw new Error("factory_operational_signal_correlation_required");
  if (!input.createdAt || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("factory_operational_signal_timestamp_invalid");
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) throw new Error("factory_operational_signal_duration_invalid");
  if (input.retryCount !== undefined && (!Number.isInteger(input.retryCount) || input.retryCount < 0)) throw new Error("factory_operational_signal_retry_invalid");
  if (!isSafeOperationalDimensions(input.dimensions)) throw new Error("factory_operational_signal_dimensions_invalid");
  return { kind: "factory_operational", schemaVersion: FACTORY_TELEMETRY_SCHEMA_VERSION, ...input };
}

export function isFactoryOperationalSignal(value: unknown): value is FactoryOperationalSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === "factory_operational"
    && item.schemaVersion === FACTORY_TELEMETRY_SCHEMA_VERSION
    && typeof item.signal === "string"
    && FACTORY_OPERATIONAL_SIGNALS.has(item.signal as FactoryOperationalSignalName)
    && typeof item.outcome === "string"
    && FACTORY_OPERATIONAL_OUTCOMES.has(item.outcome as FactoryOperationalOutcome)
    && typeof item.correlationId === "string"
    && item.correlationId.length > 0 && item.correlationId.length <= 192
    && typeof item.createdAt === "string"
    && Number.isFinite(Date.parse(item.createdAt as string))
    && (item.durationMs === undefined || (typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0))
    && (item.retryCount === undefined || (Number.isInteger(item.retryCount) && Number(item.retryCount) >= 0))
    && (item.errorCode === undefined || (typeof item.errorCode === "string" && item.errorCode.length <= 128))
    && isSafeOperationalDimensions(item.dimensions);
}

/** Stable, provider-neutral command metrics. Payloads and credentials are
 * intentionally absent; this record is safe to forward to a logger, metric
 * sink, or Durable Object trace stream. */
export interface FactoryCommandTelemetry {
  kind: "factory_command";
  commandId: string;
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  correlationId: string;
  outcome: FactoryCommandOutcome;
  eventCount: number;
  projectionEventCount: number;
  projectionStatus: FactoryCommandProjectionStatus;
  aggregateSequence?: number;
  durationMs: number;
  errorCode?: string;
}

export type FactoryCommandTelemetrySink = (telemetry: FactoryCommandTelemetry) => void | Promise<void>;

export function isFactoryCommandTelemetry(value: unknown): value is FactoryCommandTelemetry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === "factory_command"
    && typeof item.commandId === "string"
    && typeof item.organizationId === "string"
    && typeof item.factoryId === "string"
    && typeof item.workOrderId === "string"
    && typeof item.idempotencyKey === "string"
    && typeof item.payloadFingerprint === "string"
    && typeof item.correlationId === "string"
    && (item.outcome === "committed" || item.outcome === "replayed" || item.outcome === "failed")
    && Number.isInteger(item.eventCount) && Number(item.eventCount) >= 0
    && Number.isInteger(item.projectionEventCount) && Number(item.projectionEventCount) >= 0
    && (item.projectionStatus === "available" || item.projectionStatus === "unavailable")
    && typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0;
}
