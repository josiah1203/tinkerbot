import crypto from "node:crypto";
import {
  assertCanonicalFactoryEvent,
  assertFactoryEventOrdering,
  asApprovalEventId,
  projectFactoryEvents,
  type FactoryEvent,
  type FactoryProjection,
} from "./graph";
import type { WorkOrder } from "./index";
import type { FactoryCommandTelemetry, FactoryCommandTelemetrySink } from "./telemetry";

/** Stable JSON used for idempotency and definition-independent command identity. */
export function canonicalCommandJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCommandJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalCommandJson(record[key])}`).join(",")}}`;
}

export function commandPayloadFingerprint(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonicalCommandJson(value)).digest("hex")}`;
}

export interface FactoryCommandReceipt {
  organizationId: string;
  workOrderId: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  commandId: string;
  eventIds: string[];
  resultJson?: string;
  createdAt: string;
}

export interface FactoryCommandStore {
  listFactoryEvents(aggregateId: string, organizationId?: string): Promise<FactoryEvent[]>;
  appendFactoryEvent(event: FactoryEvent, options?: { commandBoundary?: boolean; admission?: WorkOrder }): Promise<void>;
  appendFactoryEvents?(events: readonly FactoryEvent[], options?: { commandBoundary?: boolean; admission?: WorkOrder }): Promise<void>;
  /** Persist the event batch and its receipt as one adapter-level unit when supported. */
  appendFactoryCommand?(events: readonly FactoryEvent[], receipt: FactoryCommandReceipt, options?: { admission?: WorkOrder }): Promise<void>;
  getFactoryCommandReceipt?(organizationId: string, workOrderId: string, idempotencyKey: string): Promise<FactoryCommandReceipt | null>;
  putFactoryCommandReceipt?(receipt: FactoryCommandReceipt): Promise<void>;
}

export interface FactoryCommandInput<T = unknown> {
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  actorId: string;
  actorType: FactoryEvent["actorType"];
  commandId?: string;
  idempotencyKey: string;
  payload: T;
  /** Full WorkOrder metadata used only by the atomic admission adapter hook. */
  admission?: WorkOrder;
  now?: string;
  /** Build canonical events from the ordered aggregate history. */
  buildEvents: (input: { priorEvents: readonly FactoryEvent[]; nextSequence: number; commandId: string; payloadFingerprint: string }) => FactoryEvent[];
}

export interface FactoryCommandResult {
  replayed: boolean;
  commandId: string;
  payloadFingerprint: string;
  eventIds: string[];
  events: FactoryEvent[];
  projection: FactoryProjection;
}

export type FactoryProjectionCheckpointStatus = "APPLIED" | "RETRY_PENDING";

/** Durable read-model recovery state. The graph remains authoritative even
 * when the compatibility projection is behind or needs to be rebuilt. */
export interface FactoryProjectionCheckpoint {
  organizationId: string;
  aggregateId: string;
  aggregateType: string;
  lastEventId?: string;
  lastAggregateSequence?: number;
  projection: FactoryProjection;
  projectionFingerprint: string;
  status: FactoryProjectionCheckpointStatus;
  attemptCount: number;
  lastError?: string;
  updatedAt: string;
}

function compareFactoryEvents(left: FactoryEvent, right: FactoryEvent): number {
  if (left.aggregateSequence !== undefined && right.aggregateSequence !== undefined && left.aggregateSequence !== right.aggregateSequence) return left.aggregateSequence - right.aggregateSequence;
  return left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId);
}

export function createFactoryProjectionCheckpoint(input: {
  organizationId: string;
  aggregateId: string;
  aggregateType: string;
  events: readonly FactoryEvent[];
  projection: FactoryProjection;
  status: FactoryProjectionCheckpointStatus;
  attemptCount: number;
  lastError?: string;
  updatedAt: string;
}): FactoryProjectionCheckpoint {
  const lastEvent = [...input.events].sort(compareFactoryEvents).at(-1);
  return {
    organizationId: input.organizationId,
    aggregateId: input.aggregateId,
    aggregateType: input.aggregateType,
    lastEventId: lastEvent?.eventId,
    lastAggregateSequence: lastEvent?.aggregateSequence,
    projection: input.projection,
    projectionFingerprint: commandPayloadFingerprint(input.projection),
    status: input.status,
    attemptCount: input.attemptCount,
    lastError: input.lastError,
    updatedAt: input.updatedAt,
  };
}

export function replayFactoryGraph(events: readonly FactoryEvent[]): FactoryProjection {
  return projectFactoryEvents([...events]);
}

export function compareFactoryGraphReplays(left: readonly FactoryEvent[], right: readonly FactoryEvent[]): { equivalent: boolean; left: FactoryProjection; right: FactoryProjection } {
  const leftProjection = replayFactoryGraph(left);
  const rightProjection = replayFactoryGraph(right);
  return { equivalent: canonicalCommandJson(leftProjection) === canonicalCommandJson(rightProjection), left: leftProjection, right: rightProjection };
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function assertCommandEventScope(event: FactoryEvent, input: FactoryCommandInput<unknown>): void {
  if (event.aggregateId !== input.workOrderId || event.organizationId !== input.organizationId || event.factoryId !== input.factoryId) throw new Error("factory_command_scope_mismatch");
  if (isRecord(event.payload) && event.payload.workOrderId !== undefined && event.payload.workOrderId !== input.workOrderId) throw new Error("factory_command_scope_mismatch");
}
export function validateReleaseApprovalReference(event: FactoryEvent, priorEvents: readonly FactoryEvent[], batchEvents: readonly FactoryEvent[]): void {
  if (event.type !== "release.decided") return;
  const payload = event.payload as Record<string, unknown>;
  const ref = isRecord(payload.approvalRef) ? payload.approvalRef : undefined;
  if (!ref || ref.kind !== "release_approval" || typeof ref.eventId !== "string") throw new Error("release_approval_reference_required");
  const referenced = [...priorEvents, ...batchEvents].find((candidate) => candidate.eventId === ref.eventId);
  if (!referenced || referenced.type !== "approval.recorded") throw new Error("release_approval_reference_must_target_approval_event");
  const approval = referenced.payload as Record<string, unknown>;
  if (referenced.aggregateId !== event.aggregateId || referenced.organizationId !== event.organizationId || referenced.factoryId !== event.factoryId) throw new Error("release_approval_reference_scope_mismatch");
  if ((approval.scope ?? approval.approvalScope) !== ref.scope || approval.outcome !== "GRANTED" || approval.workOrderId !== payload.workOrderId || approval.targetOutcome !== payload.outcome) throw new Error("release_approval_reference_not_granted");
  const outcome = payload.outcome;
  if (outcome === "ROLLBACK") {
    if (ref.scope !== "ROLLBACK" || ref.targetOutcome !== "ROLLBACK" || ref.releaseId !== payload.releaseId || approval.releaseId !== payload.releaseId || typeof ref.changeSetDigest !== "string" || approval.changeSetDigest !== ref.changeSetDigest || (payload.changeSetDigest !== undefined && ref.changeSetDigest !== payload.changeSetDigest)) throw new Error("rollback_approval_reference_mismatch");
  } else if (ref.scope !== "RELEASE" || ref.targetOutcome !== outcome || ref.changeSetDigest !== payload.changeSetDigest || approval.changeSetDigest !== payload.changeSetDigest) {
    throw new Error("release_approval_reference_digest_mismatch");
  }
}

/**
 * Durable command-side writer. The lock is intentionally per WorkOrder so
 * unrelated WorkOrders can run concurrently while a single aggregate remains
 * ordered. Persistence hooks make the idempotency receipt survive restarts.
 */
export class FactoryCommandBoundary {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly receipts = new Map<string, FactoryCommandReceipt>();
  readonly telemetry: FactoryCommandTelemetry[] = [];

  constructor(private readonly store: FactoryCommandStore, private telemetrySink?: FactoryCommandTelemetrySink) {}

  /** Attach an adapter-local sink after construction (for example, SQLite
   * cannot open its database until after the base store constructor returns). */
  setTelemetrySink(sink: FactoryCommandTelemetrySink | undefined): void {
    this.telemetrySink = sink;
  }

  private pushTelemetry(telemetry: FactoryCommandTelemetry): void {
    if (this.telemetry.length >= 1_000) this.telemetry.shift();
    this.telemetry.push(telemetry);
  }

  recordTelemetry(telemetry: FactoryCommandTelemetry): void {
    this.pushTelemetry(telemetry);
    if (!this.telemetrySink) return;
    try {
      void Promise.resolve(this.telemetrySink(telemetry)).catch(() => {
        // Observability must never change command authority or retry semantics.
      });
    } catch {
      // A synchronous adapter sink is also non-authoritative.
    }
  }

  private async emitTelemetry(telemetry: FactoryCommandTelemetry): Promise<void> {
    this.pushTelemetry(telemetry);
    if (!this.telemetrySink) return;
    try {
      await this.telemetrySink(telemetry);
    } catch {
      // Observability must never change command authority or retry semantics.
    }
  }

  async dispatch<T>(input: FactoryCommandInput<T>): Promise<FactoryCommandResult> {
    if (!input.organizationId || !input.factoryId || !input.workOrderId || !input.idempotencyKey) throw new Error("invalid_factory_command_identity");
    const commandId = input.commandId ?? `cmd_${crypto.randomUUID().replace(/-/g, "")}`;
    const payloadFingerprint = commandPayloadFingerprint(input.payload);
    const lockKey = `${input.organizationId}:${input.workOrderId}`;
    const prior = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    this.locks.set(lockKey, queued);
    const startedAt = Date.now();
    let observedEvents: readonly FactoryEvent[] = [];
    const recordTelemetry = async (telemetry: Omit<FactoryCommandTelemetry, "durationMs">): Promise<void> => this.emitTelemetry({ ...telemetry, durationMs: Math.max(0, Date.now() - startedAt) });
    await prior;
    try {
      const receiptKey = `${input.organizationId}:${input.workOrderId}:${input.idempotencyKey}`;
      const durable = await this.store.getFactoryCommandReceipt?.(input.organizationId, input.workOrderId, input.idempotencyKey);
      const known = durable ?? this.receipts.get(receiptKey);
      if (known) {
        if (known.payloadFingerprint !== payloadFingerprint) throw new Error("idempotency_conflict");
        const events = await this.store.listFactoryEvents(input.workOrderId, input.organizationId);
        observedEvents = events;
        await recordTelemetry({ kind: "factory_command", commandId: known.commandId, organizationId: input.organizationId, factoryId: input.factoryId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, correlationId: events[0]?.correlationId ?? input.workOrderId, outcome: "replayed", eventCount: known.eventIds.length, projectionEventCount: events.length, projectionStatus: "available", aggregateSequence: events.at(-1)?.aggregateSequence });
        return { replayed: true, commandId: known.commandId, payloadFingerprint, eventIds: known.eventIds, events: events.filter((event) => known.eventIds.includes(event.eventId)), projection: projectFactoryEvents(events) };
      }

      const priorEvents = await this.store.listFactoryEvents(input.workOrderId, input.organizationId);
      observedEvents = priorEvents;
      const matchingEvents = priorEvents.filter((event) => event.idempotencyKey === input.idempotencyKey);
      if (matchingEvents.length) {
        if (matchingEvents.some((event) => event.payloadFingerprint !== payloadFingerprint)) throw new Error("idempotency_conflict");
        const recovered: FactoryCommandReceipt = { organizationId: input.organizationId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, commandId: matchingEvents[0]!.commandId ?? commandId, eventIds: matchingEvents.map((event) => event.eventId), createdAt: input.now ?? new Date().toISOString() };
        this.receipts.set(receiptKey, recovered);
        await this.store.putFactoryCommandReceipt?.(recovered);
        await recordTelemetry({ kind: "factory_command", commandId: recovered.commandId, organizationId: input.organizationId, factoryId: input.factoryId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, correlationId: matchingEvents[0]?.correlationId ?? input.workOrderId, outcome: "replayed", eventCount: matchingEvents.length, projectionEventCount: priorEvents.length, projectionStatus: "available", aggregateSequence: priorEvents.at(-1)?.aggregateSequence });
        return { replayed: true, commandId: recovered.commandId, payloadFingerprint, eventIds: recovered.eventIds, events: matchingEvents, projection: projectFactoryEvents(priorEvents) };
      }

      const maxSequence = priorEvents.reduce((max, event) => Math.max(max, event.aggregateSequence ?? 0), 0);
      const built = input.buildEvents({ priorEvents, nextSequence: maxSequence + 1, commandId, payloadFingerprint });
      if (!built.length) throw new Error("factory_command_produced_no_events");
      const events: FactoryEvent[] = [];
      for (let index = 0; index < built.length; index += 1) {
        assertCommandEventScope(built[index]!, input);
        const event = { ...built[index]!, aggregateId: input.workOrderId, organizationId: input.organizationId, factoryId: input.factoryId, actorId: input.actorId, actorType: input.actorType, aggregateSequence: maxSequence + index + 1, commandId, idempotencyKey: input.idempotencyKey, payloadFingerprint } as FactoryEvent;
        if (event.type === "release.decided") validateReleaseApprovalReference(event, priorEvents, events);
        assertFactoryEventOrdering(event, [...priorEvents, ...events]);
        assertCanonicalFactoryEvent(event);
        events.push(event);
      }
      const receipt: FactoryCommandReceipt = { organizationId: input.organizationId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, commandId, eventIds: events.map((event) => event.eventId), resultJson: JSON.stringify({ eventIds: events.map((event) => event.eventId) }), createdAt: input.now ?? new Date().toISOString() };
      if (input.admission && (input.admission.workOrderId !== input.workOrderId || input.admission.organizationId !== input.organizationId || input.admission.factoryId !== input.factoryId)) throw new Error("factory_admission_scope_mismatch");
      if (this.store.appendFactoryCommand) await this.store.appendFactoryCommand(events, receipt, { admission: input.admission });
      else {
        if (this.store.appendFactoryEvents) await this.store.appendFactoryEvents(events, { commandBoundary: true, admission: input.admission });
        else for (const event of events) await this.store.appendFactoryEvent(event, { commandBoundary: true });
        await this.store.putFactoryCommandReceipt?.(receipt);
      }
      this.receipts.set(receiptKey, receipt);
      const allEvents = [...priorEvents, ...events];
      observedEvents = allEvents;
      await recordTelemetry({ kind: "factory_command", commandId, organizationId: input.organizationId, factoryId: input.factoryId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, correlationId: events[0]?.correlationId ?? input.workOrderId, outcome: "committed", eventCount: events.length, projectionEventCount: allEvents.length, projectionStatus: "available", aggregateSequence: events.at(-1)?.aggregateSequence });
      return { replayed: false, commandId, payloadFingerprint, eventIds: receipt.eventIds, events, projection: projectFactoryEvents(allEvents) };
    } catch (error) {
      await recordTelemetry({ kind: "factory_command", commandId, organizationId: input.organizationId, factoryId: input.factoryId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, correlationId: observedEvents[0]?.correlationId ?? input.workOrderId, outcome: "failed", eventCount: 0, projectionEventCount: observedEvents.length, projectionStatus: "unavailable", aggregateSequence: observedEvents.at(-1)?.aggregateSequence, errorCode: error instanceof Error ? error.message : "factory_command_failed" });
      throw error;
    } finally {
      release();
      if (this.locks.get(lockKey) === queued) this.locks.delete(lockKey);
    }
  }

  async reconstruct(workOrderId: string, organizationId?: string): Promise<FactoryProjection> {
    return projectFactoryEvents(await this.store.listFactoryEvents(workOrderId, organizationId));
  }
}

/** Helper for command handlers that need to inspect a stored approval event. */
export function approvalEventId(value: string): ReturnType<typeof asApprovalEventId> { return asApprovalEventId(value); }
