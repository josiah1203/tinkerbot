import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareFactoryGraphReplays,
  MemoryFactoryStore,
  assertFactoryTreeIntegrity,
  commandPayloadFingerprint,
  createApprovalRecordedEvent,
  createReleaseDecisionEvent,
  createReviewRecordedEvent,
  createReleaseExecutedEvent,
  createVerificationRecordedEvent,
  createWorkOrder,
  projectFactoryEvents,
  shadowReadFactoryProjection,
} from "../packages/factory/src";
import { SqliteFactoryStore } from "../packages/local-runtime/src";

const context = {
  aggregateId: "wo_spine",
  aggregateType: "work_order",
  organizationId: "org_spine",
  factoryId: "fac_spine",
  actorId: "system",
  actorType: "system" as const,
  occurredAt: "2030-01-01T00:00:00.000Z",
  correlationId: "wo_spine",
  policyVersion: "v1",
};

test("command boundary serializes a WorkOrder and replays idempotently", async () => {
  const store = new MemoryFactoryStore();
  await store.insertWorkOrder(createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "spine", repositoryId: "acme/spine", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: context.aggregateId }));
  const digest = "sha256:change-1";
  await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "verifier", actorType: "system", idempotencyKey: "verify-1", payload: { digest }, buildEvents: () => [createVerificationRecordedEvent({ ...context, eventId: "verify-1", actorId: "verifier", changeSetId: "change-1", changeSetDigest: digest, verificationRunId: "run-1", verdict: "PASS", workOrderId: context.aggregateId })] });
  await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "reviewer", actorType: "human", idempotencyKey: "review-1", payload: { digest }, buildEvents: () => [createReviewRecordedEvent({ ...context, eventId: "review-1", actorId: "reviewer", changeSetId: "change-1", changeSetDigest: digest, reviewId: "review-1", reviewerId: "reviewer", independence: "SECOND_HUMAN", outcome: "NO_FINDINGS", workOrderId: context.aggregateId })] });
  const release = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "release-1", payload: { digest, decision: "release" }, buildEvents: ({ commandId }) => {
    const approvalId = `approval-${commandId}`;
    const approval = createApprovalRecordedEvent({ ...context, eventId: approvalId, actorId: "owner", changeSetId: "change-1", changeSetDigest: digest, scope: "RELEASE", outcome: "GRANTED", approverId: "owner", workOrderId: context.aggregateId });
    const decision = createReleaseDecisionEvent({ ...context, eventId: `decision-${commandId}`, actorId: "owner", releaseId: "release-1", outcome: "RELEASE", approvalRef: { kind: "release_approval", eventId: approval.payload.approvalEventId, scope: "RELEASE", targetOutcome: "RELEASE", changeSetDigest: digest }, changeSetId: "change-1", changeSetDigest: digest, workOrderId: context.aggregateId });
    return [approval, decision];
  } });
  expect(release.projection).toMatchObject({ verificationVerdict: "PASS", reviewAssessment: "CLEAR", releaseDecision: "RELEASE", releaseId: "release-1" });
  const replay = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "release-1", payload: { decision: "release", digest }, buildEvents: () => { throw new Error("replay must not rebuild events"); } });
  expect(replay.replayed).toBe(true);
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "release-1", payload: { decision: "hold", digest }, buildEvents: () => [] })).rejects.toThrow("idempotency_conflict");
  expect((await store.listFactoryEvents(context.aggregateId)).filter((event) => event.commandId === release.commandId)).toHaveLength(2);
});

test("canonical event families reject stale digests and illegal execution edges", async () => {
  const store = new MemoryFactoryStore();
  const order = createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "stale", repositoryId: "acme/stale", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: "wo_stale" });
  await store.insertWorkOrder(order);
  await store.appendFactoryEvent({ ...context, eventId: "change-1", aggregateId: order.workOrderId, type: "change.proposed", payload: { workOrderId: order.workOrderId, changeSetId: "change-1", changeSetDigest: "sha256:new" }, actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1 });
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "old-verification", payload: { digest: "sha256:old" }, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "old-verification", actorId: "verifier", changeSetId: "old", changeSetDigest: "sha256:old", verificationRunId: "old-run", verdict: "PASS", workOrderId: order.workOrderId })] })).rejects.toThrow("stale_change_set");
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "system", actorType: "system", idempotencyKey: "illegal-execution", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseExecutedEvent({ ...context, aggregateId: order.workOrderId, eventId: "illegal-execution", actorId: "system", workOrderId: order.workOrderId, releaseId: "release-1" })] })).rejects.toThrow("release_execution_requires_release_decision");
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "wrong-scope", payload: { digest: "sha256:new" }, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "wrong-scope", actorId: "verifier", changeSetId: "change-1", changeSetDigest: "sha256:new", verificationRunId: "scope-run", verdict: "PASS", workOrderId: "other-work-order" })] })).rejects.toThrow("factory_command_scope_mismatch");
});

test("SQLite command receipts and graph projections survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-spine-restart-"));
  const dbPath = path.join(dir, "local.db");
  const first = new SqliteFactoryStore(dbPath);
  const order = createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "restart", repositoryId: "acme/restart", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: "wo_restart" });
  await first.insertWorkOrder(order);
  await first.appendFactoryEvent({ ...context, aggregateId: order.workOrderId, eventId: "restart-change", type: "change.proposed", actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1, occurredAt: "2030-01-01T00:00:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId: "change-restart", changeSetDigest: "sha256:restart" } });
  const payload = { changeSetId: "change-restart", changeSetDigest: "sha256:restart", verificationRunId: "run-restart", verdict: "PASS" as const };
  const firstResult = await first.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "restart-verification", payload, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "restart-verification-event", actorId: "verifier", workOrderId: order.workOrderId, changeSetId: payload.changeSetId, changeSetDigest: payload.changeSetDigest, verificationRunId: payload.verificationRunId, verdict: payload.verdict })] });
  const reopened = new SqliteFactoryStore(dbPath);
  const replay = await reopened.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "restart-verification", payload, buildEvents: () => { throw new Error("durable receipt must replay without rebuilding"); } });
  expect(replay.replayed).toBe(true);
  expect(replay.eventIds).toEqual(firstResult.eventIds);
  expect(compareFactoryGraphReplays(await first.listFactoryEvents(order.workOrderId), await reopened.listFactoryEvents(order.workOrderId)).equivalent).toBe(true);
});

test("tree integrity and projection shadow reads are deterministic", () => {
  expect(() => assertFactoryTreeIntegrity([{ path: ".tinkerbot/factory.yaml", contents: "a" }, { path: ".tinkerbot/factory 2.yaml", contents: "b" }])).toThrow("duplicate_factory_semantic_path");
  const projection = projectFactoryEvents([]);
  expect(commandPayloadFingerprint({ b: 2, a: 1 })).toBe(commandPayloadFingerprint({ a: 1, b: 2 }));
  expect(shadowReadFactoryProjection(projection, { verificationVerdict: "UNKNOWN", reviewAssessment: "NEEDS_HUMAN_REVIEW", releaseDecision: "BLOCKED" }).divergences).toEqual([]);
});
