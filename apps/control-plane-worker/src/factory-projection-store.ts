import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  asApprovalEventId,
  createApprovalRecordedEvent,
  createFactoryProjectionCheckpoint,
  createReleaseDecisionEvent,
  createReviewRecordedEvent,
  createVerificationRecordedEvent,
  projectFactoryAuditEvents,
  projectFactoryEvents,
  shadowReadFactoryProjection,
  type FactoryCommandInput,
  type FactoryCommandBoundary,
  type FactoryEvent,
  type FactoryProjection,
  type FactoryProjectionCheckpoint,
  type WorkOrder,
} from "../../../packages/factory/src";

export interface FactoryShadowReadSummary {
  organizationId: string;
  checkedAt: string;
  checked: number;
  skipped: number;
  divergentWorkOrders: number;
  divergences: Array<{ workOrderId: string; divergence: string }>;
  status: "clean" | "diverged";
}

interface FactoryProjectionHost {
  commandBoundary: Pick<FactoryCommandBoundary, "dispatch">;
  getWorkOrder(workOrderId: string): Promise<WorkOrder | null>;
  listWorkOrders(organizationId: string): Promise<Array<{ workOrderId: string }>>;
  listFactoryEvents(aggregateId: string, organizationId?: string): Promise<FactoryEvent[]>;
  reconstructFactoryGraph(aggregateId: string, organizationId: string): Promise<FactoryProjection>;
}

/**
 * D1 compatibility projections are deliberately kept behind a separate
 * persistence boundary. The graph remains authoritative; this adapter owns
 * only checkpointing, compatibility-field refresh, typed decision recording,
 * and read-only shadow audits.
 */
export class D1FactoryProjectionStore {
  constructor(private readonly database: D1DatabaseLike, private readonly host: FactoryProjectionHost) {}

  private async readFactoryProjectionCheckpoint(organizationId: string, aggregateId: string): Promise<FactoryProjectionCheckpoint | null> {
    const row = await this.database.prepare("SELECT organization_id, aggregate_id, aggregate_type, last_event_id, last_aggregate_sequence, projection_json, projection_fingerprint, status, attempt_count, last_error, updated_at FROM tinkerbot_factory_projection_checkpoints WHERE organization_id = ?1 AND aggregate_id = ?2").bind(organizationId, aggregateId).first<Record<string, unknown>>();
    if (!row) return null;
    let projection: FactoryProjection;
    try { projection = JSON.parse(String(row.projection_json)) as FactoryProjection; } catch { return null; }
    return {
      organizationId: String(row.organization_id),
      aggregateId: String(row.aggregate_id),
      aggregateType: String(row.aggregate_type),
      lastEventId: row.last_event_id ? String(row.last_event_id) : undefined,
      lastAggregateSequence: row.last_aggregate_sequence === null || row.last_aggregate_sequence === undefined ? undefined : Number(row.last_aggregate_sequence),
      projection,
      projectionFingerprint: String(row.projection_fingerprint),
      status: String(row.status) === "RETRY_PENDING" ? "RETRY_PENDING" : "APPLIED",
      attemptCount: Number(row.attempt_count ?? 0),
      lastError: row.last_error ? String(row.last_error) : undefined,
      updatedAt: String(row.updated_at),
    };
  }

  private async writeFactoryProjectionCheckpoint(checkpoint: FactoryProjectionCheckpoint): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_factory_projection_checkpoints (organization_id, aggregate_id, aggregate_type, last_event_id, last_aggregate_sequence, projection_json, projection_fingerprint, status, attempt_count, last_error, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(organization_id, aggregate_id) DO UPDATE SET aggregate_type = excluded.aggregate_type, last_event_id = excluded.last_event_id, last_aggregate_sequence = excluded.last_aggregate_sequence, projection_json = excluded.projection_json, projection_fingerprint = excluded.projection_fingerprint, status = excluded.status, attempt_count = excluded.attempt_count, last_error = excluded.last_error, updated_at = excluded.updated_at").bind(
      checkpoint.organizationId, checkpoint.aggregateId, checkpoint.aggregateType, checkpoint.lastEventId ?? null, checkpoint.lastAggregateSequence ?? null, JSON.stringify(checkpoint.projection), checkpoint.projectionFingerprint, checkpoint.status, checkpoint.attemptCount, checkpoint.lastError ?? null, checkpoint.updatedAt,
    ).run();
  }

  private projectionErrorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  }

  async refreshLifecycleProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection> {
    const events = await this.host.listFactoryEvents(workOrderId, organizationId);
    const projection = projectFactoryEvents(events);
    const reviewAssessment = projection.reviewAssessment === "CLEAR" || projection.reviewAssessment === "REVISE" ? projection.reviewAssessment : "NEEDS_HUMAN_REVIEW";
    const releaseDecision = projection.releaseDecision === "RELEASE" ? "READY" : "BLOCKED";
    const priorCheckpoint = await this.readFactoryProjectionCheckpoint(organizationId, workOrderId);
    const checkpoint = createFactoryProjectionCheckpoint({ organizationId, aggregateId: workOrderId, aggregateType: events[0]?.aggregateType ?? "work_order", events, projection, status: "APPLIED", attemptCount: 0, updatedAt });
    const updateStatement = this.database.prepare("UPDATE tinkerbot_work_orders SET status = COALESCE(?1, status), current_stage = COALESCE(?2, current_stage), actor = COALESCE(?3, actor), updated_at = COALESCE(?4, updated_at), verification_verdict = ?5, review_assessment = ?6, release_decision = ?7 WHERE work_order_id = ?8").bind(
      projection.workOrderState ?? null,
      projection.currentStage ?? null,
      projection.currentActorId ?? null,
      projection.lastTransitionAt ?? null,
      projection.verificationVerdict,
      reviewAssessment,
      releaseDecision,
      workOrderId,
    );
    try {
      if (this.database.batch) await this.database.batch([updateStatement, this.database.prepare("INSERT INTO tinkerbot_factory_projection_checkpoints (organization_id, aggregate_id, aggregate_type, last_event_id, last_aggregate_sequence, projection_json, projection_fingerprint, status, attempt_count, last_error, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(organization_id, aggregate_id) DO UPDATE SET aggregate_type = excluded.aggregate_type, last_event_id = excluded.last_event_id, last_aggregate_sequence = excluded.last_aggregate_sequence, projection_json = excluded.projection_json, projection_fingerprint = excluded.projection_fingerprint, status = excluded.status, attempt_count = excluded.attempt_count, last_error = excluded.last_error, updated_at = excluded.updated_at").bind(
        checkpoint.organizationId, checkpoint.aggregateId, checkpoint.aggregateType, checkpoint.lastEventId ?? null, checkpoint.lastAggregateSequence ?? null, JSON.stringify(checkpoint.projection), checkpoint.projectionFingerprint, checkpoint.status, checkpoint.attemptCount, checkpoint.lastError ?? null, checkpoint.updatedAt,
      )]);
      else {
        await updateStatement.run();
        await this.writeFactoryProjectionCheckpoint(checkpoint);
      }
      return projection;
    } catch (error) {
      const retry = createFactoryProjectionCheckpoint({ organizationId, aggregateId: workOrderId, aggregateType: events[0]?.aggregateType ?? "work_order", events, projection, status: "RETRY_PENDING", attemptCount: (priorCheckpoint?.attemptCount ?? 0) + 1, lastError: this.projectionErrorMessage(error), updatedAt });
      try { await this.writeFactoryProjectionCheckpoint(retry); } catch { /* preserve the original projection failure */ }
      throw error;
    }
  }

  async getFactoryProjectionCheckpoint(workOrderId: string, organizationId: string): Promise<FactoryProjectionCheckpoint | null> {
    const order = await this.host.getWorkOrder(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    return this.readFactoryProjectionCheckpoint(organizationId, workOrderId);
  }

  /** Rebuilds the compatibility projection from the authoritative graph. */
  async rebuildFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection | null> {
    const order = await this.host.getWorkOrder(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    return this.refreshLifecycleProjection(workOrderId, organizationId, updatedAt);
  }

  async retryFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection | null> {
    return this.rebuildFactoryProjection(workOrderId, organizationId, updatedAt);
  }

  async recordVerification(input: { workOrderId: string; organizationId: string; actorId?: string; changeSetId?: string; changeSetDigest?: string; verificationRunId: string; verdict: "PASS" | "FAIL" | "UNKNOWN"; now: string }): Promise<FactoryProjection | null> {
    const order = await this.host.getWorkOrder(input.workOrderId);
    if (!order || order.organizationId !== input.organizationId) return null;
    const current = await this.host.reconstructFactoryGraph(input.workOrderId, input.organizationId);
    const changeSetId = input.changeSetId ?? current.currentChangeSetId ?? input.workOrderId;
    const changeSetDigest = input.changeSetDigest ?? current.currentChangeSetDigest ?? order.definitionDigest;
    await this.host.commandBoundary.dispatch({
      organizationId: input.organizationId,
      factoryId: order.factoryId,
      workOrderId: input.workOrderId,
      actorId: input.actorId ?? "deterministic-verifier",
      actorType: "system",
      idempotencyKey: `verification:${input.verificationRunId}:${changeSetDigest}`,
      payload: { changeSetId, changeSetDigest, verificationRunId: input.verificationRunId, verdict: input.verdict },
      now: input.now,
      buildEvents: ({ commandId }) => [createVerificationRecordedEvent({ eventId: `verification_${input.workOrderId}_${commandId}`, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: order.factoryId, actorId: input.actorId ?? "deterministic-verifier", actorType: "system", occurredAt: input.now, correlationId: input.verificationRunId, policyVersion: order.policyVersion, workOrderId: input.workOrderId, changeSetId, changeSetDigest, verificationRunId: input.verificationRunId, verdict: input.verdict })],
    });
    return this.refreshLifecycleProjection(input.workOrderId, input.organizationId);
  }

  async recordTypedDecision(input: { workOrderId: string; organizationId: string; actor: string; type: "review" | "release"; decision: "approved" | "rejected" | "changes_requested" | "hold"; now: string }): Promise<void> {
    const order = await this.host.getWorkOrder(input.workOrderId);
    if (!order || order.organizationId !== input.organizationId) return;
    const current = await this.host.reconstructFactoryGraph(input.workOrderId, input.organizationId);
    const changeSetId = current.currentChangeSetId ?? input.workOrderId;
    const changeSetDigest = current.currentChangeSetDigest ?? order.definitionDigest;
    if (input.type === "review") {
      if (input.decision === "hold") throw new Error("invalid_review_decision");
      const outcome = input.decision === "approved" ? "NO_FINDINGS" : input.decision === "changes_requested" ? "FINDINGS" : "ESCALATE";
      await this.host.commandBoundary.dispatch({
        organizationId: input.organizationId, factoryId: order.factoryId, workOrderId: input.workOrderId, actorId: input.actor, actorType: "human", idempotencyKey: `review:${changeSetDigest}:${input.decision}`, payload: { changeSetId, changeSetDigest, outcome }, now: input.now,
        buildEvents: ({ commandId }) => [createReviewRecordedEvent({ eventId: `review_${input.workOrderId}_${commandId}`, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: order.factoryId, actorId: input.actor, actorType: "human", occurredAt: input.now, correlationId: input.workOrderId, policyVersion: order.policyVersion, workOrderId: input.workOrderId, changeSetId, changeSetDigest, reviewId: `review_${input.workOrderId}_${commandId}`, outcome, reviewerId: input.actor, independence: "SECOND_HUMAN" })],
      });
      await this.refreshLifecycleProjection(input.workOrderId, input.organizationId);
      return;
    }
    if (input.decision === "changes_requested") throw new Error("invalid_release_decision");
    const approvalOutcome = input.decision === "rejected" ? "DENIED" : "GRANTED";
    const targetOutcome = input.decision === "hold" ? "HOLD" : "RELEASE";
    await this.host.commandBoundary.dispatch({
      organizationId: input.organizationId, factoryId: order.factoryId, workOrderId: input.workOrderId, actorId: input.actor, actorType: "human", idempotencyKey: `release:${changeSetDigest}:${input.decision}`, payload: { changeSetId, changeSetDigest, decision: input.decision, targetOutcome }, now: input.now,
      buildEvents: ({ commandId }) => {
        const approvalEventId = `approval_${input.workOrderId}_${commandId}`;
        const approval = createApprovalRecordedEvent({ eventId: approvalEventId, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: order.factoryId, actorId: input.actor, actorType: "human", occurredAt: input.now, correlationId: input.workOrderId, policyVersion: order.policyVersion, workOrderId: input.workOrderId, changeSetId, changeSetDigest, scope: "RELEASE", outcome: approvalOutcome, targetOutcome, approverId: input.actor, rationale: input.decision });
        if (approvalOutcome === "DENIED") return [approval];
        return [approval, createReleaseDecisionEvent({ eventId: `release_decision_${input.workOrderId}_${commandId}`, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: order.factoryId, actorId: input.actor, actorType: "human", occurredAt: input.now, correlationId: input.workOrderId, policyVersion: order.policyVersion, workOrderId: input.workOrderId, releaseId: `release_${input.workOrderId}`, outcome: targetOutcome, approvalRef: { kind: "release_approval", eventId: asApprovalEventId(approvalEventId), scope: "RELEASE", targetOutcome, changeSetDigest }, changeSetId, changeSetDigest })];
      },
    });
    await this.refreshLifecycleProjection(input.workOrderId, input.organizationId);
  }

  async shadowReadWorkOrder(workOrderId: string, organizationId: string, checkedAt = new Date().toISOString()): Promise<ReturnType<typeof shadowReadFactoryProjection> | null> {
    const order = await this.host.getWorkOrder(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    const projection = await this.host.reconstructFactoryGraph(workOrderId, organizationId);
    return shadowReadFactoryProjection(projection, { verificationVerdict: order.verificationVerdict, reviewAssessment: order.reviewAssessment, releaseDecision: order.releaseDecision }, checkedAt);
  }

  /**
   * Read-only compatibility audit for a bounded tenant slice. This deliberately
   * does not rebuild checkpoints or update WorkOrder rows: staging/production
   * operators must be able to observe divergence before choosing reconciliation.
   */
  async shadowReadOrganization(organizationId: string, options: { limit?: number; checkedAt?: string } = {}): Promise<FactoryShadowReadSummary> {
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const limit = Number.isInteger(options.limit) && Number(options.limit) > 0 ? Math.min(Number(options.limit), 1_000) : 250;
    const orders = await this.host.listWorkOrders(organizationId);
    const selected = orders.slice(0, limit);
    const reads = (await Promise.all(selected.map(async (order) => ({ workOrderId: order.workOrderId, read: await this.shadowReadWorkOrder(order.workOrderId, organizationId, checkedAt) })))).filter((item): item is { workOrderId: string; read: NonNullable<typeof item.read> } => Boolean(item.read));
    const divergences = reads.flatMap(({ workOrderId, read }) => read.divergences.map((divergence) => ({ workOrderId, divergence })));
    return {
      organizationId,
      checkedAt,
      checked: reads.length,
      skipped: Math.max(orders.length - selected.length, 0),
      divergentWorkOrders: new Set(divergences.map((item) => item.workOrderId)).size,
      divergences,
      status: divergences.length ? "diverged" : "clean",
    };
  }

  async listFactoryAuditEvents(workOrderId: string, organizationId: string): Promise<ReturnType<typeof projectFactoryAuditEvents>> {
    return projectFactoryAuditEvents(await this.host.listFactoryEvents(workOrderId, organizationId));
  }
}
