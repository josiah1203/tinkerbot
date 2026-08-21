import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareFactoryGraphReplays,
  FactoryEventLedger,
  MemoryFactoryStore,
  assertFactoryTreeIntegrity,
  commandPayloadFingerprint,
  createApprovalRecordedEvent,
  createReleaseDecisionEvent,
  createReviewRecordedEvent,
  createReleaseExecutedEvent,
  createReleaseRolledBackEvent,
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
    const approval = createApprovalRecordedEvent({ ...context, eventId: approvalId, actorId: "owner", changeSetId: "change-1", changeSetDigest: digest, scope: "RELEASE", outcome: "GRANTED", targetOutcome: "RELEASE", approverId: "owner", workOrderId: context.aggregateId });
    const decision = createReleaseDecisionEvent({ ...context, eventId: `decision-${commandId}`, actorId: "owner", releaseId: "release-1", outcome: "RELEASE", approvalRef: { kind: "release_approval", eventId: approval.payload.approvalEventId, scope: "RELEASE", targetOutcome: "RELEASE", changeSetDigest: digest }, changeSetId: "change-1", changeSetDigest: digest, workOrderId: context.aggregateId });
    return [approval, decision];
  } });
  expect(release.projection).toMatchObject({ verificationVerdict: "PASS", reviewAssessment: "CLEAR", releaseDecision: "RELEASE", releaseId: "release-1" });
  const replay = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "release-1", payload: { decision: "release", digest }, buildEvents: () => { throw new Error("replay must not rebuild events"); } });
  expect(replay.replayed).toBe(true);
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "release-1", payload: { decision: "hold", digest }, buildEvents: () => [] })).rejects.toThrow("idempotency_conflict");
  expect((await store.listFactoryEvents(context.aggregateId)).filter((event) => event.commandId === release.commandId)).toHaveLength(2);
  const earlyRollbackApproval = createApprovalRecordedEvent({ ...context, eventId: "early-rollback-approval", actorId: "owner", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-1", changeSetDigest: digest, scope: "ROLLBACK", outcome: "GRANTED", targetOutcome: "ROLLBACK", releaseId: "release-1", approverId: "owner" });
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "rollback-before-execution", payload: { releaseId: "release-1", digest }, buildEvents: () => [earlyRollbackApproval, createReleaseDecisionEvent({ ...context, eventId: "rollback-before-execution-event", actorId: "owner", actorType: "human", workOrderId: context.aggregateId, releaseId: "release-1", outcome: "ROLLBACK", approvalRef: { kind: "release_approval", eventId: earlyRollbackApproval.payload.approvalEventId, scope: "ROLLBACK", targetOutcome: "ROLLBACK", changeSetDigest: digest, releaseId: "release-1" }, changeSetId: "change-1", changeSetDigest: digest })] })).rejects.toThrow("rollback_requires_executed_release");
  const execution = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "execution-1", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseExecutedEvent({ ...context, eventId: "execution-1-event", actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-1", changeSetDigest: digest })] });
  expect(execution.projection.releaseExecuted).toBe(true);
  const executionReplay = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "execution-1", payload: { releaseId: "release-1" }, buildEvents: () => { throw new Error("execution replay must not rebuild events"); } });
  expect(executionReplay.replayed).toBe(true);
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "execution-duplicate", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseExecutedEvent({ ...context, eventId: "execution-duplicate-event", actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-1", changeSetDigest: digest })] })).rejects.toThrow("release_execution_already_recorded");
  const verificationReplay = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "verifier", actorType: "system", idempotencyKey: "verify-1", payload: { digest }, buildEvents: () => { throw new Error("an idempotent callback replay must not rebuild events"); } });
  expect(verificationReplay.replayed).toBe(true);
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "verifier", actorType: "system", idempotencyKey: "verification-duplicate-after-release", payload: { digest }, buildEvents: () => [createVerificationRecordedEvent({ ...context, eventId: "verification-duplicate-after-release", actorId: "verifier", workOrderId: context.aggregateId, changeSetId: "change-1", changeSetDigest: digest, verificationRunId: "run-1", verdict: "PASS" })] })).rejects.toThrow("non_idempotent_event_after_release");
  const oldVerification = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "verifier", actorType: "system", idempotencyKey: "late-old-verification", payload: { digest: "sha256:old" }, buildEvents: () => [createVerificationRecordedEvent({ ...context, eventId: "late-old-verification", actorId: "verifier", workOrderId: context.aggregateId, changeSetId: "change-old", changeSetDigest: "sha256:old", verificationRunId: "run-old", verdict: "FAIL" })] });
  expect(oldVerification.projection).toMatchObject({ verificationVerdict: "PASS", currentChangeSetDigest: digest, releaseDecision: "RELEASE" });
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "verifier", actorType: "system", idempotencyKey: "conflicting-verification-after-release", payload: { digest }, buildEvents: () => [createVerificationRecordedEvent({ ...context, eventId: "conflicting-verification-after-release", actorId: "verifier", workOrderId: context.aggregateId, changeSetId: "change-1", changeSetDigest: digest, verificationRunId: "run-conflict", verdict: "FAIL" })] })).rejects.toThrow("non_idempotent_event_after_release");
  const rollbackApproval = createApprovalRecordedEvent({ ...context, eventId: "rollback-approval", actorId: "owner", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-1", changeSetDigest: digest, scope: "ROLLBACK", outcome: "GRANTED", targetOutcome: "ROLLBACK", releaseId: "release-1", approverId: "owner" });
  await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "owner", actorType: "human", idempotencyKey: "rollback-decision-1", payload: { releaseId: "release-1", digest }, buildEvents: () => [rollbackApproval, createReleaseDecisionEvent({ ...context, eventId: "rollback-decision-1-event", actorId: "owner", actorType: "human", workOrderId: context.aggregateId, releaseId: "release-1", outcome: "ROLLBACK", approvalRef: { kind: "release_approval", eventId: rollbackApproval.payload.approvalEventId, scope: "ROLLBACK", targetOutcome: "ROLLBACK", changeSetDigest: digest, releaseId: "release-1" }, changeSetId: "change-1", changeSetDigest: digest })] });
  const rollbackExecution = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "rollback-execution-1", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseRolledBackEvent({ ...context, eventId: "rollback-execution-1-event", actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-1", rollbackId: "rollback-1" })] });
  expect(rollbackExecution.projection).toMatchObject({ releaseDecision: "ROLLBACK", releaseExecuted: false });
  const rollbackReplay = await store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "rollback-execution-1", payload: { releaseId: "release-1" }, buildEvents: () => { throw new Error("rollback replay must not rebuild events"); } });
  expect(rollbackReplay.replayed).toBe(true);
  await expect(store.commandBoundary.dispatch({ organizationId: context.organizationId, factoryId: context.factoryId, workOrderId: context.aggregateId, actorId: "release-system", actorType: "system", idempotencyKey: "rollback-execution-duplicate", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseRolledBackEvent({ ...context, eventId: "rollback-execution-duplicate-event", actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-1", rollbackId: "rollback-duplicate" })] })).rejects.toThrow("rollback_execution_already_recorded");
  expect(await store.listFactoryEvents(context.aggregateId)).toHaveLength(9);
});

test("canonical event families retain stale evidence without changing current state and reject illegal execution edges", async () => {
  const store = new MemoryFactoryStore();
  const order = createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "stale", repositoryId: "acme/stale", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: "wo_stale" });
  await store.insertWorkOrder(order);
  await store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "worker", actorType: "agent", idempotencyKey: "change-1", payload: { workOrderId: order.workOrderId, changeSetId: "change-1", changeSetDigest: "sha256:new" }, buildEvents: () => [{ ...context, eventId: "change-1", aggregateId: order.workOrderId, type: "change.proposed", payload: { workOrderId: order.workOrderId, changeSetId: "change-1", changeSetDigest: "sha256:new" }, actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1 }] });
  const oldVerification = await store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "old-verification", payload: { digest: "sha256:old" }, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "old-verification", actorId: "verifier", changeSetId: "old", changeSetDigest: "sha256:old", verificationRunId: "old-run", verdict: "PASS", workOrderId: order.workOrderId })] });
  expect(oldVerification.projection).toMatchObject({ currentChangeSetDigest: "sha256:new", verificationVerdict: "UNKNOWN", eventCount: 2 });
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "system", actorType: "system", idempotencyKey: "illegal-execution", payload: { releaseId: "release-1" }, buildEvents: () => [createReleaseExecutedEvent({ ...context, aggregateId: order.workOrderId, eventId: "illegal-execution", actorId: "system", workOrderId: order.workOrderId, releaseId: "release-1" })] })).rejects.toThrow("release_execution_requires_release_decision");
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "wrong-scope", payload: { digest: "sha256:new" }, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "wrong-scope", actorId: "verifier", changeSetId: "change-1", changeSetDigest: "sha256:new", verificationRunId: "scope-run", verdict: "PASS", workOrderId: "other-work-order" })] })).rejects.toThrow("factory_command_scope_mismatch");
});

test("release decisions require an approval bound to the same target outcome", async () => {
  const store = new MemoryFactoryStore();
  const order = createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "target", repositoryId: "acme/target", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: "wo_target" });
  await store.insertWorkOrder(order);
  const digest = "sha256:target";
  await store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "worker", actorType: "agent", idempotencyKey: "target-change", payload: { workOrderId: order.workOrderId, changeSetId: "change-target", changeSetDigest: digest }, buildEvents: () => [{ ...context, aggregateId: order.workOrderId, eventId: "target-change", type: "change.proposed", actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1, payload: { workOrderId: order.workOrderId, changeSetId: "change-target", changeSetDigest: digest } }] });
  await store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "verifier", actorType: "system", idempotencyKey: "target-verification", payload: { digest }, buildEvents: () => [createVerificationRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "target-verification", actorId: "verifier", changeSetId: "change-target", changeSetDigest: digest, verificationRunId: "target-run", verdict: "PASS", workOrderId: order.workOrderId })] });
  await store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "reviewer", actorType: "human", idempotencyKey: "target-review", payload: { digest }, buildEvents: () => [createReviewRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "target-review", actorId: "reviewer", changeSetId: "change-target", changeSetDigest: digest, reviewId: "target-review", reviewerId: "reviewer", independence: "SECOND_HUMAN", outcome: "NO_FINDINGS", workOrderId: order.workOrderId })] });
  const approval = createApprovalRecordedEvent({ ...context, aggregateId: order.workOrderId, eventId: "target-hold-approval", actorId: "owner", actorType: "human", workOrderId: order.workOrderId, changeSetId: "change-target", changeSetDigest: digest, scope: "RELEASE", outcome: "GRANTED", targetOutcome: "HOLD", approverId: "owner" });
  await expect(store.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "owner", actorType: "human", idempotencyKey: "target-release", payload: { digest, decision: "release" }, buildEvents: () => [approval, createReleaseDecisionEvent({ ...context, aggregateId: order.workOrderId, eventId: "target-release-decision", actorId: "owner", actorType: "human", workOrderId: order.workOrderId, releaseId: "release-target", outcome: "RELEASE", approvalRef: { kind: "release_approval", eventId: approval.payload.approvalEventId, scope: "RELEASE", targetOutcome: "RELEASE", changeSetDigest: digest }, changeSetId: "change-target", changeSetDigest: digest })] })).rejects.toThrow("release_approval_reference_not_granted");
  expect(await store.listFactoryEvents(order.workOrderId)).toHaveLength(3);
});

test("the in-memory event ledger cannot append canonical binding events directly", () => {
  const ledger = new FactoryEventLedger();
  const event = createVerificationRecordedEvent({ ...context, eventId: "ledger-verification", actorId: "verifier", workOrderId: context.aggregateId, changeSetId: "change-ledger", changeSetDigest: "sha256:ledger", verificationRunId: "ledger-run", verdict: "PASS" });
  expect(() => ledger.append(event)).toThrow("factory_command_boundary_required");
});

test("store batch appenders reject canonical binding events without command-boundary authority", async () => {
  const store = new MemoryFactoryStore();
  const event = createVerificationRecordedEvent({ ...context, eventId: "batch-verification", actorId: "verifier", workOrderId: context.aggregateId, changeSetId: "change-batch", changeSetDigest: "sha256:batch", verificationRunId: "batch-run", verdict: "PASS" });
  await expect(store.appendFactoryEvents([event])).rejects.toThrow("factory_command_boundary_required");
});

test("SQLite command receipts and graph projections survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-spine-restart-"));
  const dbPath = path.join(dir, "local.db");
  const first = new SqliteFactoryStore(dbPath);
  const order = createWorkOrder({ factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "restart", repositoryId: "acme/restart", policyVersion: "v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human", workOrderId: "wo_restart" });
  await first.insertWorkOrder(order);
  await first.commandBoundary.dispatch({ organizationId: order.organizationId, factoryId: order.factoryId, workOrderId: order.workOrderId, actorId: "worker", actorType: "agent", idempotencyKey: "restart-change", payload: { workOrderId: order.workOrderId, changeSetId: "change-restart", changeSetDigest: "sha256:restart" }, now: "2030-01-01T00:00:00.000Z", buildEvents: () => [{ ...context, aggregateId: order.workOrderId, eventId: "restart-change", type: "change.proposed", actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1, occurredAt: "2030-01-01T00:00:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId: "change-restart", changeSetDigest: "sha256:restart" } }] });
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
