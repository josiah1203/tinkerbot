import { projectFactoryEvents, type FactoryEvent, type FactoryProjection } from "./graph";

/** Read-only audit view. There is intentionally no append API: audit records
 * are derived from the append-only Factory Graph and therefore cannot become
 * a second lifecycle authority. */
export interface FactoryAuditEvent {
  auditEventId: string;
  sourceEventId: string;
  aggregateId: string;
  eventType: FactoryEvent["type"];
  occurredAt: string;
  actorId: string;
  actorType: FactoryEvent["actorType"];
  projection: FactoryProjection;
  sourceOfTruth: "append_only_factory_graph";
}

export function projectFactoryAuditEvents(events: readonly FactoryEvent[]): FactoryAuditEvent[] {
  const ordered = [...events].sort((left, right) => (left.aggregateSequence !== undefined && right.aggregateSequence !== undefined && left.aggregateSequence !== right.aggregateSequence ? left.aggregateSequence - right.aggregateSequence : left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId)));
  return ordered.map((event, index) => ({ auditEventId: `audit:${event.eventId}`, sourceEventId: event.eventId, aggregateId: event.aggregateId, eventType: event.type, occurredAt: event.occurredAt, actorId: event.actorId, actorType: event.actorType, projection: projectFactoryEvents(ordered.slice(0, index + 1)), sourceOfTruth: "append_only_factory_graph" }));
}
