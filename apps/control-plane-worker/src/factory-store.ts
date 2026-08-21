import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  WorkOrder,
  WorkOrderEvent,
  WorkOrderState,
  assertFactoryEventAuthority,
  isFactoryCommandBoundaryEventType,
  createWorkOrderCreatedEvent,
  classifyWorkOrderGroup,
  createWorkOrder,
  graphEventForWorkOrderTransition,
  parseFactoryDefinition,
  transitionWorkOrder,
  FactoryCommandBoundary,
  createApprovalRecordedEvent,
  type FactoryCommandInput,
  type FactoryCommandReceipt,
  type FactoryCommandResult,
  type FactoryEvent,
  type FactoryProjection,
  type FactoryDefinition,
  type WorkOrderView,
} from "../../../packages/factory/src";
import { D1FactoryProjectionStore, type FactoryShadowReadSummary } from "./factory-projection-store";
import { D1FactoryTelemetryStore } from "./factory-telemetry-store";
import { D1FactoryWorkspaceStore, type WorkspaceEnvironment, type WorkspaceIntegration, type WorkspaceSecretMetadata } from "./factory-workspace-store";
import { D1FactoryReadModel } from "./factory-read-model";
import { D1FactoryArtifactStore } from "./factory-artifact-store";
import { D1FactoryOperationsStore } from "./factory-operations-store";
import { D1FactoryDefinitionStore, type FactoryRecord } from "./factory-definition-store";
import { D1FactoryGraphStore } from "./factory-graph-store";

export type { FactoryShadowReadSummary } from "./factory-projection-store";

function workOrderInsertStatement(database: D1DatabaseLike, order: WorkOrder, ignore = false) {
  const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
  return database.prepare(`${verb} INTO tinkerbot_work_orders (work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)`).bind(
    order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null, order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null, order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.verificationVerdict ?? "UNKNOWN", order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", order.releaseDecision ?? "BLOCKED", order.waiver ? JSON.stringify(order.waiver) : null,
  );
}

export class D1FactoryStore {
  readonly commandBoundary: FactoryCommandBoundary;
  private readonly projectionStore: D1FactoryProjectionStore;
  private readonly telemetryStore: D1FactoryTelemetryStore;
  private readonly workspaceStore: D1FactoryWorkspaceStore;
  private readonly readModel: D1FactoryReadModel;
  private readonly artifactStore: D1FactoryArtifactStore;
  private readonly operationsStore: D1FactoryOperationsStore;
  private readonly definitionStore: D1FactoryDefinitionStore;
  private readonly graphStore: D1FactoryGraphStore;

  constructor(private readonly database: D1DatabaseLike) {
    this.telemetryStore = new D1FactoryTelemetryStore(database);
    this.workspaceStore = new D1FactoryWorkspaceStore(database);
    this.definitionStore = new D1FactoryDefinitionStore(database, {
      replaceAutomations: (factoryId, automations, now) => this.workspaceStore.replaceAutomations(factoryId, automations, now),
    });
    this.readModel = new D1FactoryReadModel(this);
    this.artifactStore = new D1FactoryArtifactStore(database, (factoryId) => this.getFactory(factoryId));
    this.operationsStore = new D1FactoryOperationsStore(database, (factoryId) => this.getFactory(factoryId));
    this.commandBoundary = new FactoryCommandBoundary(this, (telemetry) => this.telemetryStore.persistCommandTelemetry(telemetry));
    this.projectionStore = new D1FactoryProjectionStore(database, {
      commandBoundary: this.commandBoundary,
      getWorkOrder: (workOrderId) => this.getWorkOrder(workOrderId),
      listWorkOrders: (organizationId) => this.listWorkOrders(organizationId),
      listFactoryEvents: (aggregateId, organizationId) => this.listFactoryEvents(aggregateId, organizationId),
      reconstructFactoryGraph: (aggregateId, organizationId) => this.reconstructFactoryGraph(aggregateId, organizationId),
    });
    this.graphStore = new D1FactoryGraphStore(database, {
      refreshLifecycleProjection: (workOrderId, organizationId, updatedAt) => this.refreshLifecycleProjection(workOrderId, organizationId, updatedAt),
    });
  }

  async pruneCommandTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<number> {
    return this.telemetryStore.pruneCommandTelemetry(retentionDays, now);
  }

  async persistOperationalSignal(signal: import("../../../packages/factory/src").FactoryOperationalSignal): Promise<void> {
    return this.telemetryStore.persistOperationalSignal(signal);
  }

  async pruneOperationalTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<number> {
    return this.telemetryStore.pruneOperationalTelemetry(retentionDays, now);
  }

  async pruneTelemetry(retentionDays: number, now = new Date().toISOString()): Promise<{ commandDeleted: number; operationalDeleted: number }> {
    return this.telemetryStore.pruneTelemetry(retentionDays, now);
  }

  async listFactories(organizationId: string): Promise<Array<{ factoryId: string; name: string; status: string; updatedAt: string }>> {
    return this.definitionStore.listFactories(organizationId);
  }

  async getFactory(factoryId: string): Promise<FactoryRecord | null> {
    return this.definitionStore.getFactory(factoryId);
  }

  async putFactory(input: { factoryId: string; organizationId: string; name: string; yaml?: string; files?: Array<{ path: string; contents: string }>; now?: string }): Promise<{ factoryId: string; digest?: string }> {
    return this.definitionStore.putFactory(input);
  }

  async getLatestDefinition(factoryId: string): Promise<{ yaml: string; files: Array<{ path: string; contents: string }>; digest: string } | null> {
    return this.definitionStore.getLatestDefinition(factoryId);
  }

  async factoryOperatorView(factoryId: string, organizationId: string): Promise<Awaited<ReturnType<D1FactoryReadModel["factoryOperatorView"]>>> {
    return this.readModel.factoryOperatorView(factoryId, organizationId);
  }


  async listWorkOrderViews(organizationId: string, factoryId?: string): Promise<WorkOrderView[]> {
    return this.readModel.listWorkOrderViews(organizationId, factoryId);
  }


  async getWorkOrderView(workOrderId: string, organizationId: string): Promise<WorkOrderView | null> {
    return this.readModel.getWorkOrderView(workOrderId, organizationId);
  }


  async listFactoryRuns(factoryId: string): Promise<Array<Record<string, string>>> {
    return this.artifactStore.listFactoryRuns(factoryId);
  }

  async listFactoryUsage(factoryId: string, organizationId: string): Promise<Array<{ kind: string; tokens: number; costCents: number; createdAt: string }>> {
    return this.artifactStore.listFactoryUsage(factoryId, organizationId);
  }

  async listFactoryEvidence(factoryId: string, organizationId: string): Promise<Array<Record<string, unknown>>> {
    return this.artifactStore.listFactoryEvidence(factoryId, organizationId);
  }

  async listEnvironments(organizationId: string): Promise<WorkspaceEnvironment[]> {
    return this.workspaceStore.listEnvironments(organizationId);
  }

  async listIntegrations(organizationId: string): Promise<WorkspaceIntegration[]> {
    return this.workspaceStore.listIntegrations(organizationId);
  }

  async listSecretMetadata(organizationId: string): Promise<WorkspaceSecretMetadata[]> {
    return this.workspaceStore.listSecretMetadata(organizationId);
  }

  async createSecretMetadata(input: { organizationId: string; name: string; reference: string; owner: string; now: string }): Promise<WorkspaceSecretMetadata> {
    return this.workspaceStore.createSecretMetadata(input);
  }

  async createIntegrationMetadata(input: { organizationId: string; name: string; kind: string; now: string }): Promise<WorkspaceIntegration> {
    return this.workspaceStore.createIntegrationMetadata(input);
  }

  async listScorers(factoryId: string): Promise<Array<Record<string, unknown>>> {
    return this.operationsStore.listScorers(factoryId);
  }

  async listSelfImprovement(factoryId: string): Promise<Array<Record<string, unknown>>> {
    return this.operationsStore.listSelfImprovement(factoryId);
  }

  async replaceAutomations(factoryId: string, automations: FactoryDefinition["automations"], now: string): Promise<void> {
    return this.workspaceStore.replaceAutomations(factoryId, automations, now);
  }

  async listWorkOrders(organizationId: string): Promise<Array<WorkOrder & { group: ReturnType<typeof classifyWorkOrderGroup> }>> {
    const statement = this.database.prepare("SELECT work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json FROM tinkerbot_work_orders WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string>>();
    return (result.results ?? []).map((row) => {
      const order = rowToWorkOrder(row);
      return { ...order, group: classifyWorkOrderGroup(order.status) };
    });
  }

  async getWorkOrder(workOrderId: string): Promise<WorkOrder | null> {
    const row = await this.database.prepare("SELECT work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json FROM tinkerbot_work_orders WHERE work_order_id = ?1").bind(workOrderId).first<Record<string, string>>();
    return row ? rowToWorkOrder(row) : null;
  }

  /** Tenant-scoped work-order lookup for control-plane adapters (MCP, API, and workers). */
  async getWorkOrderForOrganization(workOrderId: string, organizationId: string): Promise<WorkOrder | null> {
    const order = await this.getWorkOrder(workOrderId);
    return order && order.organizationId === organizationId ? order : null;
  }

  /** Idempotent intake lookup used when a delivery does not yet have a WorkOrder ID. */
  async getWorkOrderForSource(organizationId: string, sourceType: WorkOrder["sourceType"], sourceId: string): Promise<WorkOrder | null> {
    const row = await this.database.prepare("SELECT work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json FROM tinkerbot_work_orders WHERE organization_id = ?1 AND source_type = ?2 AND source_id = ?3 ORDER BY created_at LIMIT 1").bind(organizationId, sourceType, sourceId).first<Record<string, string>>();
    return row ? rowToWorkOrder(row) : null;
  }

  /** Seed-only compatibility path for tests and legacy migration fixtures. */
  async seedWorkOrder(order: WorkOrder): Promise<void> {
    await workOrderInsertStatement(this.database, order).run();
  }

  async admitWorkOrder(order: WorkOrder): Promise<FactoryCommandResult> {
    const actorType: FactoryEvent["actorType"] = order.sourceType === "manual" ? "human" : order.sourceType.startsWith("github") || order.sourceType.startsWith("gitlab") ? "integration" : "system";
    const event = createWorkOrderCreatedEvent(order, actorType);
    return this.commandBoundary.dispatch({
      organizationId: order.organizationId,
      factoryId: order.factoryId,
      workOrderId: order.workOrderId,
      actorId: order.actor,
      actorType,
      idempotencyKey: `admission:${order.workOrderId}`,
      payload: { kind: "work_order_admission", order },
      admission: order,
      now: order.createdAt,
      buildEvents: () => [event],
    });
  }

  async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string, now?: string): Promise<{ ok: true; order: WorkOrder; event?: WorkOrderEvent } | { ok: false; code: "not_found" | "invalid_transition" | "idempotent" }> {
    const current = await this.getWorkOrder(workOrderId);
    if (!current) return { ok: false, code: "not_found" };
    const result = transitionWorkOrder(current, toState, causeId, actor, now);
    if ("error" in result) return { ok: false, code: result.error };
    const graphEvent = graphEventForWorkOrderTransition({
      workOrderId: result.order.workOrderId,
      factoryId: result.order.factoryId,
      organizationId: result.order.organizationId,
      actor: result.order.actor,
      policyVersion: result.order.policyVersion,
      fromState: result.event.fromState,
      toState: result.event.toState,
      causeId: result.event.causeId,
      createdAt: result.event.createdAt,
      definitionDigest: result.order.definitionDigest,
      changeSetId: result.order.workOrderId,
      changeSetDigest: result.order.definitionDigest,
    });
    if (graphEvent) await this.commandBoundary.dispatch({ organizationId: result.order.organizationId, factoryId: result.order.factoryId, workOrderId: result.order.workOrderId, actorId: graphEvent.actorId, actorType: graphEvent.actorType, idempotencyKey: `transition:${result.event.eventId}`, payload: graphEvent.payload, now: graphEvent.occurredAt, buildEvents: () => [graphEvent] });
    await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_work_order_events (event_id, work_order_id, from_state, to_state, cause_id, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(result.event.eventId, result.event.workOrderId, result.event.fromState, result.event.toState, result.event.causeId, result.event.actor, result.event.createdAt).run();
    // Route/status columns are compatibility projections. Rebuild them from
    // the graph event written above instead of treating this adapter update as
    // a second lifecycle authority.
    await this.refreshLifecycleProjection(workOrderId, result.order.organizationId, result.event.createdAt);
    return { ok: true, order: result.order, event: result.event };
  }

  async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    return this.artifactStore.insertRun(run);
  }

  async updateRun(runId: string, status: string, now: string): Promise<void> {
    return this.artifactStore.updateRun(runId, status, now);
  }

  async updateRunDefinition(runId: string, definitionDigest: string, now: string): Promise<void> {
    return this.artifactStore.updateRunDefinition(runId, definitionDigest, now);
  }

  async updateWorkOrderDefinition(workOrderId: string, definitionDigest: string, now: string): Promise<void> {
    await this.database.prepare("UPDATE tinkerbot_work_orders SET definition_digest = ?1, updated_at = ?2 WHERE work_order_id = ?3").bind(definitionDigest, now, workOrderId).run();
  }

  async getRun(runId: string): Promise<Record<string, string> | null> {
    return this.artifactStore.getRun(runId);
  }

  async getRunForOrganization(runId: string, organizationId: string): Promise<Record<string, string> | null> {
    return this.artifactStore.getRunForOrganization(runId, organizationId);
  }

  async consumeOidcReplayKey(key: string, now: string): Promise<"ok" | "replay"> {
    return this.artifactStore.consumeOidcReplayKey(key, now);
  }

  async listRunStages(runId: string): Promise<Array<{ stage: string; status: string; summary?: string }>> {
    return this.artifactStore.listRunStages(runId);
  }

  async insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<boolean> {
    return this.artifactStore.insertStage(runId, stage, status, summary, now);
  }

  /** Complete an already-persisted stage without appending a duplicate row. */
  async updateStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void> {
    return this.artifactStore.updateStage(runId, stage, status, summary, now);
  }

  async insertUsage(event: { organizationId: string; factoryId?: string; runId?: string; kind: string; tokens: number; costCents: number; now: string }): Promise<void> {
    return this.artifactStore.insertUsage(event);
  }

  async insertAiCostEvent(event: { organizationId: string; factoryId?: string; workOrderId?: string; runId?: string; stageId?: string; agentId?: string; modelId: string; tokens: number; costMinor: number; now: string; provider?: string }): Promise<void> {
    return this.artifactStore.insertAiCostEvent(event);
  }

  async insertAgentReceipt(input: { runId: string; agentId: string; receipt: unknown; digest: string; signed: boolean; now: string }): Promise<void> {
    return this.artifactStore.insertAgentReceipt(input);
  }

  async insertEvidence(input: { runId: string; kind: string; objectKey: string; digest: string; signed?: boolean; now: string }): Promise<void> {
    return this.artifactStore.insertEvidence(input);
  }

  async putSeatLedger(organizationId: string, periodStart: string, activeSeats: number, now: string): Promise<void> {
    return this.artifactStore.putSeatLedger(organizationId, periodStart, activeSeats, now);
  }

  async listUsage(organizationId: string): Promise<Array<{ kind: string; tokens: number; costCents: number; createdAt: string }>> {
    return this.artifactStore.listUsage(organizationId);
  }

  async putRunToken(tokenId: string, runId: string, repository: string, sha: string | undefined, expiresAt: string, now: string): Promise<void> {
    return this.artifactStore.putRunToken(tokenId, runId, repository, sha, expiresAt, now);
  }

  async getRunToken(tokenId: string): Promise<{ runId: string; repository: string; sha?: string; expiresAt: string } | null> {
    return this.artifactStore.getRunToken(tokenId);
  }

  async putPublication(input: { runId: string; commitSha: string; fingerprint: string; kind: string; remoteId?: string; now: string }): Promise<"created" | "duplicate"> {
    return this.artifactStore.putPublication(input);
  }

  async insertApproval(workOrderId: string, actor: string, decision: "approved" | "rejected", signature: string, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_approvals (approval_id, work_order_id, actor, decision, signature, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), workOrderId, actor, decision, signature, now).run();
    const order = await this.getWorkOrder(workOrderId);
    if (!order) return;
    const current = await this.reconstructFactoryGraph(workOrderId, order.organizationId);
    const changeSetId = current.currentChangeSetId ?? workOrderId;
    const changeSetDigest = current.currentChangeSetDigest ?? order.definitionDigest;
    await this.commandBoundary.dispatch({
      organizationId: order.organizationId,
      factoryId: order.factoryId,
      workOrderId,
      actorId: actor,
      actorType: "human",
      idempotencyKey: `spec-approval:${signature}:${decision}`,
      payload: { changeSetId, changeSetDigest, decision },
      now,
      buildEvents: ({ commandId }) => [createApprovalRecordedEvent({ eventId: `approval_${workOrderId}_${commandId}`, aggregateId: workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId: order.factoryId, actorId: actor, actorType: "human", occurredAt: now, correlationId: workOrderId, policyVersion: order.policyVersion, workOrderId, changeSetId, changeSetDigest, scope: "SPEC", outcome: decision === "approved" ? "GRANTED" : "DENIED", approverId: actor, rationale: signature })],
    });
  }

  async hasSpecApproval(workOrderId: string): Promise<boolean> {
    const row = await this.database.prepare("SELECT approval_id FROM tinkerbot_approvals WHERE work_order_id = ?1 AND decision = 'approved' LIMIT 1").bind(workOrderId).first<{ approval_id: string }>();
    return Boolean(row);
  }

  async putConversation(input: { workOrderId: string; agentId: string; r2Key: string; now: string }): Promise<string> {
    return this.artifactStore.putConversation(input);
  }

  async insertScorer(input: { factoryId: string; name: string; criteria: string; now: string }): Promise<string> {
    return this.operationsStore.insertScorer(input);
  }

  async insertBenchmark(factoryId: string, metric: string, value: number, now: string): Promise<void> {
    return this.operationsStore.insertBenchmark(factoryId, metric, value, now);
  }

  async insertSelfImprovement(input: { factoryId: string; title: string; workOrderId?: string; now: string }): Promise<void> {
    return this.operationsStore.insertSelfImprovement(input);
  }

  async getRunByWorkOrder(workOrderId: string): Promise<Record<string, string> | null> {
    return this.artifactStore.getRunByWorkOrder(workOrderId);
  }

  async hitRateLimit(bucket: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
    const row = await this.database.prepare("SELECT count, window_started_at FROM tinkerbot_rate_limits WHERE bucket = ?1").bind(bucket).first<{ count: number; window_started_at: string }>();
    const started = row ? Date.parse(row.window_started_at) : 0;
    if (!row || !Number.isFinite(started) || now - started > windowMs) {
      await this.database.prepare("INSERT INTO tinkerbot_rate_limits (bucket, count, window_started_at) VALUES (?1, 1, ?2) ON CONFLICT(bucket) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at").bind(bucket, new Date(now).toISOString()).run();
      return false;
    }
    if (row.count >= limit) return true;
    await this.database.prepare("UPDATE tinkerbot_rate_limits SET count = count + 1 WHERE bucket = ?1").bind(bucket).run();
    return false;
  }

  async patchWorkOrder(workOrderId: string, patch: Partial<Pick<WorkOrder, "productId" | "lineId" | "cellId" | "owner" | "risk" | "autonomyMode" | "outputKind" | "intent" | "acceptanceCriteria">> & { heldBy?: WorkOrder["heldBy"] | null } & { now: string }): Promise<void> {
    const current = await this.getWorkOrder(workOrderId);
    if (!current) return;
    await this.database.prepare("UPDATE tinkerbot_work_orders SET product_id = ?1, line_id = ?2, cell_id = ?3, owner = ?4, risk = ?5, autonomy_mode = ?6, output_kind = ?7, held_by = ?8, intent = ?9, acceptance_criteria = ?10, updated_at = ?11 WHERE work_order_id = ?12").bind(patch.productId ?? current.productId ?? null, patch.lineId ?? current.lineId ?? null, patch.cellId ?? current.cellId ?? null, patch.owner ?? current.owner ?? null, patch.risk ?? current.risk ?? null, patch.autonomyMode ?? current.autonomyMode ?? null, patch.outputKind ?? current.outputKind ?? null, patch.heldBy === undefined ? current.heldBy ?? null : patch.heldBy, patch.intent ?? current.intent ?? null, patch.acceptanceCriteria ?? current.acceptanceCriteria ?? null, patch.now, workOrderId).run();
  }

  /** Serialized operator cell ownership action; held_by remains compatibility metadata. */
  async setWorkOrderCellHold(input: { workOrderId: string; organizationId: string; actor: string; action: "take" | "return"; now: string }): Promise<WorkOrder | null> {
    const current = await this.getWorkOrderForOrganization(input.workOrderId, input.organizationId);
    if (!current) return null;
    await this.patchWorkOrder(current.workOrderId, { heldBy: input.action === "take" ? input.actor : null, now: input.now });
    await this.database.prepare("INSERT INTO tinkerbot_human_decisions (decision_id, work_order_id, subject_id, actor, role, decision, reason, created_at) VALUES (?1, ?2, ?3, ?4, 'operator', ?5, ?6, ?7)").bind(crypto.randomUUID(), current.workOrderId, current.cellId ?? current.workOrderId, input.actor, input.action === "take" ? "take_cell" : "return_cell", "Human/agent parity", input.now).run();
    return this.getWorkOrder(current.workOrderId);
  }

  private async refreshLifecycleProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection> {
    return this.projectionStore.refreshLifecycleProjection(workOrderId, organizationId, updatedAt);
  }

  async getFactoryProjectionCheckpoint(workOrderId: string, organizationId: string) {
    return this.projectionStore.getFactoryProjectionCheckpoint(workOrderId, organizationId);
  }

  /** Rebuilds the compatibility projection from the authoritative graph. */
  async rebuildFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()) {
    return this.projectionStore.rebuildFactoryProjection(workOrderId, organizationId, updatedAt);
  }

  async retryFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()) {
    return this.projectionStore.retryFactoryProjection(workOrderId, organizationId, updatedAt);
  }

  async recordVerification(input: { workOrderId: string; organizationId: string; actorId?: string; changeSetId?: string; changeSetDigest?: string; verificationRunId: string; verdict: "PASS" | "FAIL" | "UNKNOWN"; now: string }) {
    return this.projectionStore.recordVerification(input);
  }

  async recordTypedDecision(input: { workOrderId: string; organizationId: string; actor: string; type: "review" | "release"; decision: "approved" | "rejected" | "changes_requested" | "hold"; now: string }): Promise<void> {
    return this.projectionStore.recordTypedDecision(input);
  }

  async upsertWorkCell(cell: { cellId: string; factoryId: string; workOrderId?: string; kind: string; repository: string; branch: string; status: string; leasedBy?: string; heldBy?: string; credentialScope: string; cleanupAt: string; now: string; productionAccess?: string; observability?: string; allowedTools?: string[] }): Promise<void> {
    return this.operationsStore.upsertWorkCell(cell);
  }

  async listWorkCells(factoryId?: string): Promise<Array<Record<string, string | null>>> {
    return this.operationsStore.listWorkCells(factoryId);
  }

  async listExpiredCells(now: string): Promise<Array<Record<string, string | null>>> {
    return this.operationsStore.listExpiredCells(now);
  }

  async listProducts(organizationId: string): Promise<Array<Record<string, string | null>>> {
    return this.operationsStore.listProducts(organizationId);
  }

  async upsertProduct(input: { productId: string; organizationId: string; factoryId?: string; name: string; riskClass?: string; now: string }): Promise<void> {
    return this.operationsStore.upsertProduct(input);
  }

  async listSkills(factoryId: string): Promise<Array<Record<string, string | null>>> {
    return this.operationsStore.listSkills(factoryId);
  }

  async upsertSkill(input: { skillId: string; factoryId: string; name: string; purpose: string; owner: string; version: string; yaml: string; rollout: string; allowedTools: string[]; permissions: string[]; now: string }): Promise<void> {
    return this.operationsStore.upsertSkill(input);
  }

  async listProposals(factoryId: string): Promise<Array<Record<string, unknown>>> {
    return this.operationsStore.listProposals(factoryId);
  }

  async insertProposal(input: { proposalId: string; factoryId: string; title: string; evidence: string[]; proposedChanges: string[]; expectedEffect: string; kind: string; stewardActor?: string; now: string }): Promise<void> {
    return this.operationsStore.insertProposal(input);
  }

  async approveProposal(proposalId: string, actor: string, now: string, organizationId?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.operationsStore.approveProposal(proposalId, actor, now, organizationId);
  }

  async insertReleaseCandidate(input: { releaseId: string; workOrderId: string; factoryId: string; commitSha: string; receiptIds: string[]; rollbackRefs: string[]; status: string; blocking: string[]; now: string }): Promise<void> {
    return this.operationsStore.insertReleaseCandidate(input);
  }

  async listReleaseCandidates(factoryId: string): Promise<Array<Record<string, unknown>>> {
    return this.operationsStore.listReleaseCandidates(factoryId);
  }

  async insertDeployment(input: { deploymentId: string; releaseId: string; environment: string; status: string; workflow?: string; now: string }): Promise<void> {
    return this.operationsStore.insertDeployment(input);
  }

  async insertOutcome(input: { outcomeId: string; workOrderId?: string; releaseId?: string; kind: string; association: string; now: string }): Promise<void> {
    return this.operationsStore.insertOutcome(input);
  }

  async insertFactoryCommand(command: import("../../../packages/factory/src").FactoryCommand): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_factory_commands (command_id, organization_id, source_system, source_object_id, actor_id, authorized, idempotency_key, work_order_id, action, confirmation_required, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(command_id) DO NOTHING").bind(
      command.commandId, command.organizationId, command.sourceSystem, command.sourceObjectId, command.actorId, command.authorized ? 1 : 0, command.idempotencyKey, command.workOrderId ?? null, command.action, command.confirmationRequired ? 1 : 0, JSON.stringify(command), command.createdAt,
    ).run();
  }

  async insertAftercare(record: import("../../../packages/factory/src").AftercareRecord): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_aftercare (release_id, owner, environment, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(release_id) DO UPDATE SET payload_json = excluded.payload_json").bind(
      record.releaseId, record.owner, record.environment, JSON.stringify(record), new Date().toISOString(),
    ).run();
  }

  async putExecutionPlan(plan: import("../../../packages/factory/src/runtime").ExecutionPlan): Promise<void> {
    return this.artifactStore.putExecutionPlan(plan);
  }

  async getExecutionPlanForWorkOrder(workOrderId: string): Promise<import("../../../packages/factory/src/runtime").ExecutionPlan | null> {
    return this.artifactStore.getExecutionPlanForWorkOrder(workOrderId);
  }

  async putCostEstimate(planId: string, estimate: import("../../../packages/factory/src/runtime").CostEstimate): Promise<void> {
    return this.artifactStore.putCostEstimate(planId, estimate);
  }

  async putCostActual(input: { planId: string; runId: string; usage: import("../../../packages/factory/src/runtime").ProviderUsage; now: string }): Promise<void> {
    return this.artifactStore.putCostActual(input);
  }

  async ingestLocalRuntimePayload(input: { organizationId: string; kind: string; payload: Record<string, unknown>; now: string }): Promise<{ accepted: true; organizationId: string; kind: string }> {
    const kind = input.kind;
    const payload = input.payload;
    if (kind === "factory-graph-event" || payload.event) {
      const event = (payload.event ?? payload) as FactoryEvent;
      if (!event || typeof event !== "object" || typeof event.eventId !== "string" || typeof event.aggregateId !== "string" || event.organizationId !== input.organizationId) throw new Error("invalid_factory_graph_event");
      const factory = typeof event.factoryId === "string" ? await this.getFactory(event.factoryId) : null;
      if (!factory || factory.organizationId !== input.organizationId) throw new Error("factory_not_found_for_organization");
      if (event.aggregateType === "work_order" && !await this.getWorkOrderForOrganization(event.aggregateId, input.organizationId)) throw new Error("work_order_not_found_for_organization");
      assertFactoryEventAuthority(event);
      const bindingEvent = isFactoryCommandBoundaryEventType(event.type);
      if (bindingEvent) {
        await this.commandBoundary.dispatch({ organizationId: input.organizationId, factoryId: event.factoryId, workOrderId: event.aggregateId, actorId: event.actorId, actorType: event.actorType, commandId: event.commandId, idempotencyKey: event.idempotencyKey ?? `runtime-sync:${event.eventId}`, payload: event.payload, now: event.occurredAt, buildEvents: () => [event] });
      } else {
        await this.appendFactoryEvent(event);
      }
    }
    if (kind === "execution-plan" || payload.plan) {
      const plan = (payload.plan ?? payload) as import("../../../packages/factory/src/runtime").ExecutionPlan;
      if (plan && typeof plan === "object" && typeof plan.planId === "string") await this.putExecutionPlan({ ...plan, origin: "local" });
      if (plan?.cost) await this.putCostEstimate(plan.planId, plan.cost);
    }
    if (kind === "cost-actual" || payload.usage) {
      const usage = payload.usage as import("../../../packages/factory/src/runtime").ProviderUsage;
      if (usage && typeof payload.planId === "string" && typeof payload.runId === "string") await this.putCostActual({ planId: payload.planId, runId: payload.runId, usage, now: input.now });
    }
    if (kind === "eval-attempt" || payload.attempt) {
      const attempt = (payload.attempt ?? payload) as import("../../../packages/factory/src/evals").EvalAttempt;
      if (attempt && typeof attempt.attemptId === "string") await this.insertEvalAttempt(attempt);
    }
    if (kind === "eval-suite" || payload.suite) {
      const suite = (payload.suite ?? payload) as import("../../../packages/factory/src/evals").EvalSuite;
      if (suite && typeof suite.suiteId === "string") await this.putEvalSuite(suite);
    }
    return { accepted: true, organizationId: input.organizationId, kind };
  }

  async putEvalSuite(suite: import("../../../packages/factory/src/evals").EvalSuite): Promise<void> {
    return this.artifactStore.putEvalSuite(suite);
  }

  async insertEvalAttempt(attempt: import("../../../packages/factory/src/evals").EvalAttempt): Promise<void> {
    return this.artifactStore.insertEvalAttempt(attempt);
  }

  async listOutcomes(organizationId: string): Promise<Array<Record<string, unknown>>> {
    return this.operationsStore.listOutcomes(organizationId);
  }

  async appendFactoryEvents(events: readonly FactoryEvent[], options: { commandBoundary?: boolean; admission?: WorkOrder } = {}): Promise<void> {
    return this.graphStore.appendFactoryEvents(events, options);
  }

  async appendFactoryCommand(events: readonly FactoryEvent[], receipt: FactoryCommandReceipt, options: { admission?: WorkOrder } = {}): Promise<void> {
    return this.graphStore.appendFactoryCommand(events, receipt, options);
  }

  async getFactoryCommandReceipt(organizationId: string, workOrderId: string, idempotencyKey: string): Promise<FactoryCommandReceipt | null> {
    return this.graphStore.getFactoryCommandReceipt(organizationId, workOrderId, idempotencyKey);
  }

  async putFactoryCommandReceipt(receipt: FactoryCommandReceipt): Promise<void> {
    return this.graphStore.putFactoryCommandReceipt(receipt);
  }

  async dispatchFactoryCommand<T>(input: FactoryCommandInput<T>): Promise<FactoryCommandResult> {
    return this.commandBoundary.dispatch(input);
  }

  async appendFactoryEvent(event: FactoryEvent, options: { commandBoundary?: boolean; admission?: WorkOrder } = {}): Promise<void> {
    return this.graphStore.appendFactoryEvent(event, options);
  }

  async appendFactoryEventOnce(event: FactoryEvent): Promise<boolean> {
    return this.graphStore.appendFactoryEventOnce(event);
  }

  async listFactoryEvents(aggregateId: string, organizationId?: string): Promise<FactoryEvent[]> {
    return this.graphStore.listFactoryEvents(aggregateId, organizationId);
  }

  async reconstructFactoryGraph(aggregateId: string, organizationId: string): Promise<FactoryProjection> {
    return this.graphStore.reconstructFactoryGraph(aggregateId, organizationId);
  }

  async shadowReadWorkOrder(workOrderId: string, organizationId: string, checkedAt = new Date().toISOString()) {
    return this.projectionStore.shadowReadWorkOrder(workOrderId, organizationId, checkedAt);
  }

  async shadowReadOrganization(organizationId: string, options: { limit?: number; checkedAt?: string } = {}): Promise<FactoryShadowReadSummary> {
    return this.projectionStore.shadowReadOrganization(organizationId, options);
  }

  async listFactoryAuditEvents(workOrderId: string, organizationId: string) {
    return this.projectionStore.listFactoryAuditEvents(workOrderId, organizationId);
  }
}

function rowToWorkOrder(row: Record<string, string>): WorkOrder {
  return {
    workOrderId: row.work_order_id,
    factoryId: row.factory_id,
    organizationId: row.organization_id,
    sourceType: row.source_type as WorkOrder["sourceType"],
    sourceId: row.source_id,
    repositoryId: row.repository_id,
    issueOrPullRequest: row.issue_or_pull_request,
    intent: row.intent,
    acceptanceCriteria: row.acceptance_criteria,
    policyVersion: row.policy_version,
    definitionVersion: row.definition_version,
    definitionDigest: row.definition_digest,
    currentStage: row.current_stage as WorkOrder["currentStage"],
    status: row.status as WorkOrder["status"],
    actor: row.actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    productId: row.product_id || undefined,
    lineId: row.line_id as WorkOrder["lineId"],
    cellId: row.cell_id || undefined,
    owner: row.owner || undefined,
    risk: row.risk as WorkOrder["risk"],
    autonomyMode: row.autonomy_mode as WorkOrder["autonomyMode"],
    outputKind: row.output_kind as WorkOrder["outputKind"],
    policyJson: row.policy_json || undefined,
    dependenciesJson: row.dependencies_json || undefined,
    heldBy: row.held_by || undefined,
    verificationVerdict: (row.verification_verdict as WorkOrder["verificationVerdict"]) || "UNKNOWN",
    reviewAssessment: (row.review_assessment as WorkOrder["reviewAssessment"]) || "NEEDS_HUMAN_REVIEW",
    releaseDecision: (row.release_decision as WorkOrder["releaseDecision"]) || "BLOCKED",
    waiver: row.waiver_json ? JSON.parse(row.waiver_json) as WorkOrder["waiver"] : undefined,
  };
}

export { createWorkOrder, parseFactoryDefinition, type FactoryDefinition };
