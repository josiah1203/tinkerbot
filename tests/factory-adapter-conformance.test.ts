import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { D1DatabaseLike } from "../packages/hosted-integrations/src";
import { D1FactoryStore } from "../apps/control-plane-worker/src/factory-store";
import {
  SqliteFactoryStore,
} from "../packages/local-runtime/src";
import {
  createApprovalRecordedEvent,
  createReleaseDecisionEvent,
  createReleaseExecutedEvent,
  createReleaseRolledBackEvent,
  createReviewRecordedEvent,
  createVerificationRecordedEvent,
  createWorkOrder,
  MemoryFactoryStore,
  projectFactoryEvents,
  type FactoryCommandInput,
  type FactoryCommandResult,
  type FactoryEvent,
  type FactoryProjection,
  type WorkOrder,
} from "../packages/factory/src";

type Row = Record<string, unknown>;

/** Minimal D1 contract fake for the graph/receipt persistence surface. */
class GraphD1Database implements D1DatabaseLike {
  readonly workOrders = new Map<string, Row>();
  readonly events = new Map<string, Row>();
  readonly receipts = new Map<string, Row>();
  readonly checkpoints = new Map<string, Row>();
  readonly telemetry: Row[] = [];
  failProjectionUpdate = false;

  seedWorkOrder(order: WorkOrder): void {
    this.workOrders.set(order.workOrderId, {
      work_order_id: order.workOrderId,
      factory_id: order.factoryId,
      organization_id: order.organizationId,
      source_type: order.sourceType,
      source_id: order.sourceId,
      repository_id: order.repositoryId,
      issue_or_pull_request: order.issueOrPullRequest ?? "",
      intent: order.intent ?? "",
      acceptance_criteria: order.acceptanceCriteria ?? "",
      policy_version: order.policyVersion,
      definition_version: order.definitionVersion,
      definition_digest: order.definitionDigest,
      current_stage: order.currentStage,
      status: order.status,
      actor: order.actor,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
      product_id: order.productId ?? "",
      line_id: order.lineId ?? "",
      cell_id: order.cellId ?? "",
      owner: order.owner ?? "",
      risk: order.risk ?? "",
      autonomy_mode: order.autonomyMode ?? "",
      output_kind: order.outputKind ?? "",
      policy_json: order.policyJson ?? "",
      dependencies_json: order.dependenciesJson ?? "",
      held_by: order.heldBy ?? "",
      verification_verdict: order.verificationVerdict ?? "UNKNOWN",
      review_assessment: order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW",
      release_decision: order.releaseDecision ?? "BLOCKED",
      waiver_json: order.waiver ? JSON.stringify(order.waiver) : "",
    });
  }

  prepare(query: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => this.first<T>(query, args),
        all: async <T>() => ({ results: this.all<T>(query, args) }),
        run: async () => this.run(query, args),
      }),
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  private first<T>(query: string, args: unknown[]): T | null {
    if (query.includes("FROM tinkerbot_work_orders") && query.includes("work_order_id =")) return (this.workOrders.get(String(args[0])) ?? null) as T | null;
    if (query.includes("FROM tinkerbot_factory_command_receipts")) {
      const key = `${String(args[0])}:${String(args[1])}:${String(args[2])}`;
      return (this.receipts.get(key) ?? null) as T | null;
    }
    if (query.includes("FROM tinkerbot_factory_projection_checkpoints")) {
      const key = `${String(args[0])}:${String(args[1])}`;
      return (this.checkpoints.get(key) ?? null) as T | null;
    }
    return null;
  }

  private all<T>(query: string, args: unknown[]): T[] {
    if (!query.includes("FROM tinkerbot_factory_graph_events")) return [];
    const aggregateId = String(args[0]);
    const organizationId = args.length > 1 ? String(args[1]) : undefined;
    return [...this.events.values()].filter((row) => row.aggregate_id === aggregateId && (!organizationId || row.organization_id === organizationId)) as T[];
  }

  private run(query: string, args: unknown[]): { meta: { changes: number } } {
    if (query.includes("tinkerbot_factory_graph_events") && query.includes("INSERT")) {
      const eventId = String(args[0]);
      if (this.events.has(eventId)) return { meta: { changes: 0 } };
      const hasSpineColumns = args.length >= 20;
      this.events.set(eventId, hasSpineColumns ? {
        event_id: eventId,
        aggregate_id: args[1],
        aggregate_type: args[2],
        organization_id: args[3],
        factory_id: args[4],
        event_type: args[5],
        actor_id: args[6],
        actor_type: args[7],
        occurred_at: args[8],
        correlation_id: args[9],
        causation_id: args[10],
        schema_version: args[11],
        aggregate_sequence: args[12],
        command_id: args[13],
        idempotency_key: args[14],
        payload_fingerprint: args[15],
        policy_version: args[16],
        provenance: args[17],
        external_references_json: args[18],
        payload_json: args[19],
      } : {
        event_id: eventId,
        aggregate_id: args[1],
        aggregate_type: args[2],
        organization_id: args[3],
        factory_id: args[4],
        event_type: args[5],
        actor_id: args[6],
        actor_type: args[7],
        occurred_at: args[8],
        correlation_id: args[9],
        causation_id: args[10],
        schema_version: args[11],
        aggregate_sequence: null,
        command_id: null,
        idempotency_key: null,
        payload_fingerprint: null,
        policy_version: args[12],
        provenance: args[13],
        external_references_json: args[14],
        payload_json: args[15],
      });
      return { meta: { changes: 1 } };
    }
    if (query.includes("tinkerbot_factory_command_receipts") && query.includes("INSERT")) {
      const key = `${String(args[0])}:${String(args[1])}:${String(args[2])}`;
      if (this.receipts.has(key)) return { meta: { changes: 0 } };
      this.receipts.set(key, { organization_id: args[0], work_order_id: args[1], idempotency_key: args[2], payload_fingerprint: args[3], command_id: args[4], event_ids_json: args[5], result_json: args[6], created_at: args[7] });
      return { meta: { changes: 1 } };
    }
    if (query.includes("tinkerbot_factory_projection_checkpoints") && query.includes("INSERT")) {
      const key = `${String(args[0])}:${String(args[1])}`;
      this.checkpoints.set(key, {
        organization_id: args[0],
        aggregate_id: args[1],
        aggregate_type: args[2],
        last_event_id: args[3],
        last_aggregate_sequence: args[4],
        projection_json: args[5],
        projection_fingerprint: args[6],
        status: args[7],
        attempt_count: args[8],
        last_error: args[9],
        updated_at: args[10],
      });
      return { meta: { changes: 1 } };
    }
    if (query.includes("tinkerbot_factory_command_telemetry") && query.includes("INSERT")) {
      this.telemetry.push({ telemetry_id: args[0], command_id: args[1], organization_id: args[2], factory_id: args[3], work_order_id: args[4], idempotency_key: args[5], payload_fingerprint: args[6], correlation_id: args[7], outcome: args[8], event_count: args[9], projection_event_count: args[10], projection_status: args[11], aggregate_sequence: args[12], duration_ms: args[13], error_code: args[14], created_at: args[15] });
      return { meta: { changes: 1 } };
    }
    if (query.includes("UPDATE tinkerbot_work_orders SET status = COALESCE")) {
      if (this.failProjectionUpdate) throw new Error("projection_write_failed");
      const row = this.workOrders.get(String(args[7]));
      if (row) {
        if (args[0] != null) row.status = args[0];
        if (args[1] != null) row.current_stage = args[1];
        if (args[2] != null) row.actor = args[2];
        if (args[3] != null) row.updated_at = args[3];
        row.verification_verdict = args[4];
        row.review_assessment = args[5];
        row.release_decision = args[6];
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    return { meta: { changes: 1 } };
  }
}

type CommandAdapter = {
  commandBoundary: { dispatch<T>(input: FactoryCommandInput<T>): Promise<FactoryCommandResult> };
  appendFactoryEvent(event: FactoryEvent): Promise<void>;
  listFactoryEvents(aggregateId: string): Promise<FactoryEvent[]>;
};

const context = {
  aggregateId: "wo_conformance",
  aggregateType: "work_order",
  organizationId: "org_conformance",
  factoryId: "factory_conformance",
  actorId: "system",
  actorType: "system" as const,
  correlationId: "wo_conformance",
  policyVersion: "policy-v1",
};

function timestamp(step: number): string {
  return `2030-01-01T00:00:${String(step).padStart(2, "0")}.000Z`;
}

async function dispatch(adapter: CommandAdapter, key: string, payload: unknown, events: FactoryEvent[]): Promise<FactoryCommandResult> {
  return adapter.commandBoundary.dispatch({
    ...context,
    workOrderId: context.aggregateId,
    commandId: `cmd-${key}`,
    idempotencyKey: key,
    payload,
    now: events[0]?.occurredAt ?? timestamp(1),
    buildEvents: () => events,
  });
}

async function runFixture(adapter: CommandAdapter): Promise<FactoryProjection> {
  const digestOne = "sha256:conformance-one";
  const digestTwo = "sha256:conformance-two";
  await dispatch(adapter, "change-one", { changeSetId: "change-one", changeSetDigest: digestOne }, [{ ...context, eventId: "change-one", type: "change.proposed", occurredAt: timestamp(1), actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1, payload: { workOrderId: context.aggregateId, changeSetId: "change-one", changeSetDigest: digestOne } }]);
  await dispatch(adapter, "verification-one", { changeSetId: "change-one", changeSetDigest: digestOne }, [createVerificationRecordedEvent({ ...context, eventId: "verification-one", occurredAt: timestamp(2), actorId: "deterministic-verifier", workOrderId: context.aggregateId, changeSetId: "change-one", changeSetDigest: digestOne, verificationRunId: "run-one", verdict: "PASS" })]);
  await dispatch(adapter, "review-one", { changeSetId: "change-one", changeSetDigest: digestOne }, [createReviewRecordedEvent({ ...context, eventId: "review-one", occurredAt: timestamp(3), actorId: "reviewer", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-one", changeSetDigest: digestOne, reviewId: "review-one", reviewerId: "reviewer", independence: "SECOND_HUMAN", outcome: "NO_FINDINGS" })]);

  const holdApproval = createApprovalRecordedEvent({ ...context, eventId: "approval-hold", occurredAt: timestamp(4), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-one", changeSetDigest: digestOne, scope: "RELEASE", outcome: "GRANTED", targetOutcome: "HOLD", approverId: "owner" });
  await dispatch(adapter, "release-hold", { changeSetId: "change-one", changeSetDigest: digestOne, targetOutcome: "HOLD" }, [holdApproval, createReleaseDecisionEvent({ ...context, eventId: "release-hold", occurredAt: timestamp(5), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, releaseId: "release-hold", outcome: "HOLD", approvalRef: { kind: "release_approval", eventId: holdApproval.payload.approvalEventId, scope: "RELEASE", targetOutcome: "HOLD", changeSetDigest: digestOne }, changeSetId: "change-one", changeSetDigest: digestOne })]);

  await dispatch(adapter, "change-two", { changeSetId: "change-two", changeSetDigest: digestTwo }, [{ ...context, eventId: "change-two", type: "change.updated", occurredAt: timestamp(6), actorId: "worker", actorType: "agent", provenance: "ATTESTED", schemaVersion: 1, payload: { workOrderId: context.aggregateId, changeSetId: "change-two", changeSetDigest: digestTwo } }]);
  await dispatch(adapter, "verification-two", { changeSetId: "change-two", changeSetDigest: digestTwo }, [createVerificationRecordedEvent({ ...context, eventId: "verification-two", occurredAt: timestamp(7), actorId: "deterministic-verifier", workOrderId: context.aggregateId, changeSetId: "change-two", changeSetDigest: digestTwo, verificationRunId: "run-two", verdict: "PASS" })]);
  await dispatch(adapter, "review-two", { changeSetId: "change-two", changeSetDigest: digestTwo }, [createReviewRecordedEvent({ ...context, eventId: "review-two", occurredAt: timestamp(8), actorId: "reviewer", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-two", changeSetDigest: digestTwo, reviewId: "review-two", reviewerId: "reviewer", independence: "SECOND_HUMAN", outcome: "NO_FINDINGS" })]);

  const releaseApproval = createApprovalRecordedEvent({ ...context, eventId: "approval-release", occurredAt: timestamp(9), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-two", changeSetDigest: digestTwo, scope: "RELEASE", outcome: "GRANTED", targetOutcome: "RELEASE", approverId: "owner" });
  await dispatch(adapter, "release-decision", { changeSetId: "change-two", changeSetDigest: digestTwo, targetOutcome: "RELEASE" }, [releaseApproval, createReleaseDecisionEvent({ ...context, eventId: "release-decision", occurredAt: timestamp(10), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, releaseId: "release-two", outcome: "RELEASE", approvalRef: { kind: "release_approval", eventId: releaseApproval.payload.approvalEventId, scope: "RELEASE", targetOutcome: "RELEASE", changeSetDigest: digestTwo }, changeSetId: "change-two", changeSetDigest: digestTwo })]);
  await dispatch(adapter, "release-execution", { releaseId: "release-two" }, [createReleaseExecutedEvent({ ...context, eventId: "release-execution", occurredAt: timestamp(11), actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-two", changeSetDigest: digestTwo })]);

  const rollbackApproval = createApprovalRecordedEvent({ ...context, eventId: "approval-rollback", occurredAt: timestamp(12), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, changeSetId: "change-two", changeSetDigest: digestTwo, scope: "ROLLBACK", outcome: "GRANTED", targetOutcome: "ROLLBACK", releaseId: "release-two", approverId: "owner" });
  await dispatch(adapter, "rollback-decision", { releaseId: "release-two", changeSetDigest: digestTwo, targetOutcome: "ROLLBACK" }, [rollbackApproval, createReleaseDecisionEvent({ ...context, eventId: "rollback-decision", occurredAt: timestamp(13), actorId: "owner", actorType: "human", workOrderId: context.aggregateId, releaseId: "release-two", outcome: "ROLLBACK", approvalRef: { kind: "release_approval", eventId: rollbackApproval.payload.approvalEventId, scope: "ROLLBACK", targetOutcome: "ROLLBACK", releaseId: "release-two", changeSetDigest: digestTwo }, changeSetId: "change-two", changeSetDigest: digestTwo })]);
  await dispatch(adapter, "rollback-execution", { releaseId: "release-two" }, [createReleaseRolledBackEvent({ ...context, eventId: "rollback-execution", occurredAt: timestamp(14), actorId: "release-system", actorType: "system", workOrderId: context.aggregateId, releaseId: "release-two", rollbackId: "rollback-two" })]);
  await adapter.appendFactoryEvent({ ...context, eventId: "outcome-started", type: "outcome.measurement_started", occurredAt: timestamp(15), actorId: "system", actorType: "system", provenance: "ATTESTED", schemaVersion: 1, payload: { workOrderId: context.aggregateId } });
  await adapter.appendFactoryEvent({ ...context, eventId: "outcome-observed", type: "outcome.observed", occurredAt: timestamp(16), actorId: "system", actorType: "system", provenance: "ATTESTED", schemaVersion: 1, payload: { workOrderId: context.aggregateId, status: "NEUTRAL", mature: true } });
  return projectFactoryEvents(await adapter.listFactoryEvents(context.aggregateId));
}

function order(): WorkOrder {
  return createWorkOrder({ workOrderId: context.aggregateId, factoryId: context.factoryId, organizationId: context.organizationId, sourceType: "manual", sourceId: "conformance", repositoryId: "acme/conformance", policyVersion: "policy-v1", definitionVersion: "v1", definitionDigest: "sha256:definition", actor: "human" });
}

test("Memory, SQLite, and D1 produce the same Factory Spine projection", async () => {
  const memory = new MemoryFactoryStore();
  await memory.insertWorkOrder(order());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-conformance-"));
  const sqlite = new SqliteFactoryStore(path.join(dir, "local.db"));
  await sqlite.insertWorkOrder(order());

  const d1Database = new GraphD1Database();
  d1Database.seedWorkOrder(order());
  const d1 = new D1FactoryStore(d1Database);

  const projections = await Promise.all([
    runFixture(memory),
    runFixture(sqlite),
    runFixture(d1),
  ]);

  expect(projections[0]).toEqual(projections[1]);
  expect(projections[0]).toEqual(projections[2]);
  expect(projections[0]).toMatchObject({
    verificationVerdict: "PASS",
    reviewAssessment: "CLEAR",
    releaseDecision: "ROLLBACK",
    outcomeStatus: "NEUTRAL",
    currentChangeSetDigest: "sha256:conformance-two",
    releaseApprovalTargetOutcome: "ROLLBACK",
    releaseExecuted: false,
  });
  const sqliteCheckpoint = await sqlite.getFactoryProjectionCheckpoint(context.aggregateId, context.organizationId);
  const d1Checkpoint = await d1.getFactoryProjectionCheckpoint(context.aggregateId, context.organizationId);
  expect(sqliteCheckpoint).toMatchObject({ status: "APPLIED", lastEventId: "outcome-observed", projection: projections[0] });
  expect(d1Checkpoint).toMatchObject({ status: "APPLIED", lastEventId: "outcome-observed", projection: projections[0] });
  expect(d1Checkpoint?.projectionFingerprint).toBe(sqliteCheckpoint?.projectionFingerprint);
  expect(d1Database.telemetry.length).toBeGreaterThan(0);
  expect(d1Database.telemetry.every((row) => !("payload" in row))).toBe(true);
  expect(await sqlite.retryFactoryProjection(context.aggregateId, context.organizationId, timestamp(17))).toEqual(projections[0]);
  expect(await d1.rebuildFactoryProjection(context.aggregateId, context.organizationId, timestamp(17))).toEqual(projections[0]);
});

test("all durable adapters reject direct canonical batch appends", async () => {
  const memory = new MemoryFactoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-conformance-boundary-"));
  const sqlite = new SqliteFactoryStore(path.join(dir, "local.db"));
  const d1Database = new GraphD1Database();
  const d1 = new D1FactoryStore(d1Database);
  const event = createVerificationRecordedEvent({ ...context, eventId: "direct-boundary-verification", actorId: "deterministic-verifier", workOrderId: context.aggregateId, changeSetId: "change-boundary", changeSetDigest: "sha256:boundary", verificationRunId: "boundary-run", verdict: "PASS" });
  const change: FactoryEvent = { ...context, eventId: "direct-boundary-change", type: "change.proposed", occurredAt: timestamp(1), schemaVersion: 1, provenance: "ATTESTED", payload: { workOrderId: context.aggregateId, changeSetId: "change-boundary", changeSetDigest: "sha256:boundary" } };
  for (const store of [memory, sqlite, d1]) {
    await expect(store.appendFactoryEvents([event])).rejects.toThrow("factory_command_boundary_required");
    await expect(store.appendFactoryEvents([change])).rejects.toThrow("factory_command_boundary_required");
  }
});

test("a failed hosted projection leaves a durable retry marker while the graph remains replayable", async () => {
  const database = new GraphD1Database();
  database.seedWorkOrder(order());
  const store = new D1FactoryStore(database);
  database.failProjectionUpdate = true;
  const event: FactoryEvent = { ...context, eventId: "checkpoint-change", type: "change.proposed", occurredAt: timestamp(1), schemaVersion: 1, provenance: "ATTESTED", payload: { workOrderId: context.aggregateId, changeSetId: "checkpoint-change", changeSetDigest: "sha256:checkpoint" } };
  await expect(store.commandBoundary.dispatch({
    ...context,
    workOrderId: context.aggregateId,
    commandId: "checkpoint-command",
    idempotencyKey: "checkpoint-command",
    payload: { changeSetId: "checkpoint-change", changeSetDigest: "sha256:checkpoint" },
    buildEvents: () => [event],
  })).rejects.toThrow("projection_write_failed");
  expect(await store.getFactoryCommandReceipt(context.organizationId, context.aggregateId, "checkpoint-command")).not.toBeNull();
  expect(await store.listFactoryEvents(context.aggregateId)).toHaveLength(1);
  expect(await store.getFactoryProjectionCheckpoint(context.aggregateId, context.organizationId)).toMatchObject({ status: "RETRY_PENDING", lastEventId: "checkpoint-change", lastError: "projection_write_failed" });

  database.failProjectionUpdate = false;
  expect(await store.retryFactoryProjection(context.aggregateId, context.organizationId, timestamp(2))).toMatchObject({ currentChangeSetId: "checkpoint-change", currentChangeSetDigest: "sha256:checkpoint" });
  expect(await store.getFactoryProjectionCheckpoint(context.aggregateId, context.organizationId)).toMatchObject({ status: "APPLIED", attemptCount: 0, lastEventId: "checkpoint-change" });
});
