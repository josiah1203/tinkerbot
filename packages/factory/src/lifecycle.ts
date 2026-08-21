import { assertCanonicalFactoryEvent, createMicroIntent, factoryId, isFactoryCommandBoundaryEventType, type FactoryEvent, type IntentContract } from "./graph";
import type { FactoryStore } from "./store";

export interface LifecycleContext { organizationId: string; factoryId: string; actorId: string; actorType: FactoryEvent["actorType"]; correlationId?: string; policyVersion?: string; }

/** Single command-side writer for the Factory Graph. Surfaces call this; projections only read events. */
export class FactoryLifecycle {
  constructor(private readonly store: Pick<FactoryStore, "appendFactoryEvent"> & Partial<Pick<FactoryStore, "dispatchFactoryCommand">>) {}

  async createIntent(context: LifecycleContext, title: string, mode: IntentContract["mode"] = "micro"): Promise<IntentContract> {
    const intent = mode === "micro" ? createMicroIntent(title) : { ...createMicroIntent(title), mode };
    await this.append(context, "intent.created", intent.intentId, "intent", "HUMAN_VERIFIED", { intent });
    return intent;
  }

  async record(context: LifecycleContext, type: FactoryEvent["type"], aggregateId: string, aggregateType: string, payload: Record<string, unknown>, provenance: FactoryEvent["provenance"] = "ATTESTED"): Promise<FactoryEvent> {
    return this.append(context, type, aggregateId, aggregateType, provenance, payload);
  }

  private async append(context: LifecycleContext, type: FactoryEvent["type"], aggregateId: string, aggregateType: string, provenance: FactoryEvent["provenance"], payload: Record<string, unknown>): Promise<FactoryEvent> {
    const event: FactoryEvent = { eventId: factoryId("evt"), type, aggregateId, aggregateType, organizationId: context.organizationId, factoryId: context.factoryId, actorId: context.actorId, actorType: context.actorType, occurredAt: new Date().toISOString(), correlationId: context.correlationId ?? aggregateId, schemaVersion: 1, policyVersion: context.policyVersion, provenance, payload };
    assertCanonicalFactoryEvent(event);
    const bindingEvent = isFactoryCommandBoundaryEventType(event.type);
    if (bindingEvent && !this.store.dispatchFactoryCommand) throw new Error("factory_command_boundary_required");
    if (bindingEvent && this.store.dispatchFactoryCommand) {
      await this.store.dispatchFactoryCommand({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: aggregateId, actorId: context.actorId, actorType: context.actorType, idempotencyKey: `lifecycle:${event.eventId}`, payload, now: event.occurredAt, buildEvents: () => [event] });
      return event;
    }
    await this.store.appendFactoryEvent(event);
    return event;
  }
}
