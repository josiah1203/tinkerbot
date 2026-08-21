import { describe, expect, test } from "vitest";
import { FactoryEventLedger, MemoryFactoryStore, calculateFactoryEconomics, createMicroIntent, createWorkOrder, mayRecordRelease, parseIntegrationCommand, projectFactoryEvents, validateIntent, type FactoryEvent } from "../packages/factory/src";

const envelope = { aggregateId: "wo_1", aggregateType: "work_order", organizationId: "org_1", factoryId: "fac_1", actorId: "human_1", actorType: "human" as const, correlationId: "corr_1", provenance: "DETERMINISTICALLY_VERIFIED" as const };

describe("Factory Graph", () => {
  test("keeps an append-only lifecycle and reconstructs independent decisions", () => {
    const ledger = new FactoryEventLedger();
    ledger.append({ ...envelope, type: "verification.completed", payload: { verdict: "PASS" } });
    ledger.append({ ...envelope, type: "review.completed", payload: { decision: "APPROVE" } });
    ledger.append({ ...envelope, type: "release.completed", payload: { decision: "RELEASE" } });
    ledger.append({ ...envelope, type: "outcome.measurement_started", payload: {} });
    const state = ledger.reconstruct("wo_1");
    expect(state).toMatchObject({ verificationVerdict: "PASS", reviewDecision: "APPROVE", releaseDecision: "RELEASE", outcomeStatus: "PENDING" });
    expect(mayRecordRelease(state, "worker_1", ["worker_1"])).toEqual({ ok: false, reason: "worker_cannot_approve_or_release_own_work" });
    expect(mayRecordRelease(state, "release_owner", ["worker_1"])).toEqual({ ok: true });
    expect(() => ledger.append({ ...envelope, eventId: ledger.all()[0]?.eventId, type: "release.requested", payload: { workOrderId: "wo_1", requestId: "duplicate" } })).toThrow("duplicate_event_id");
  });

  test("does not treat immature outcomes as success and calculates the primary metric", () => {
    const events: FactoryEvent[] = [
      { ...envelope, eventId: "e1", occurredAt: "2026-01-01T00:00:00Z", schemaVersion: 1 as const, type: "approval.recorded" as const, payload: { decision: "approved" } },
      { ...envelope, eventId: "e2", occurredAt: "2026-01-01T00:00:01Z", schemaVersion: 1 as const, type: "cost.recorded" as const, payload: { costCents: 40, copqCategory: "appraisal" } },
      { ...envelope, eventId: "e3", occurredAt: "2026-01-01T00:00:02Z", schemaVersion: 1 as const, type: "outcome.observed" as const, payload: { status: "POSITIVE", mature: false } },
    ];
    expect(projectFactoryEvents(events).outcomeStatus).toBe("POSITIVE");
    expect(calculateFactoryEconomics(events).costPerAcceptedUnrevertedOutcomePositiveChange).toBeNull();
    events[2] = { ...events[2], payload: { status: "POSITIVE", mature: true } };
    expect(calculateFactoryEconomics(events).costPerAcceptedUnrevertedOutcomePositiveChange).toBe(40);
  });

  test("prevents advisory and worker authority from changing verification or release facts", () => {
    const ledger = new FactoryEventLedger();
    expect(() => ledger.append({ ...envelope, type: "verification.completed", provenance: "REPORTED", payload: { verdict: "PASS" } })).toThrow("only_deterministic_verification");
    expect(() => ledger.append({ ...envelope, type: "release.completed", actorType: "agent", payload: {} })).toThrow("worker_cannot_approve");
    expect(() => ledger.append({ ...envelope, type: "outcome.observed", payload: { status: "POSITIVE", mature: false } })).toThrow("immature_outcome");
  });

  test("supports micro intent and provider-neutral commands", () => {
    expect(validateIntent(createMicroIntent("Fix invoice timezone formatting"))).toEqual([]);
    expect(parseIntegrationCommand("@tinkerbot status")).toMatchObject({ command: "status" });
    expect(parseIntegrationCommand("@tinkerbot approve")).toMatchObject({ command: "approve" });
    expect(parseIntegrationCommand("/tinkerbot status")).toBeUndefined();
  });

  test("projects legacy WorkOrder transitions into the canonical event stream", async () => {
    const store = new MemoryFactoryStore();
    const order = createWorkOrder({ factoryId: "fac_1", organizationId: "org_1", sourceType: "manual", sourceId: "local", repositoryId: "repo", policyVersion: "policy_1", definitionVersion: "1", definitionDigest: "sha256:1", actor: "developer" });
    await store.insertWorkOrder(order);
    await store.applyTransition(order.workOrderId, "triage", "cause_1", "developer");
    expect(await store.listFactoryEvents(order.workOrderId)).toMatchObject([{ type: "task.queued", aggregateId: order.workOrderId }]);
  });
});
