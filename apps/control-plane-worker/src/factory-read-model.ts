import {
  applyFactoryTree,
  classifyActivityColumn,
  classifyWorkOrderGroup,
  factoryDashboardMetrics,
  groupView,
  normalizeOutcomeStatus,
  normalizeReleaseDecision,
  normalizeReviewDecision,
  normalizeVerificationVerdict,
  parseFactoryDefinition,
  projectFactoryEvents,
  stageView,
  type ActionCapability,
  type FactoryDefinition,
  type FactoryProjection,
  type WorkOrder,
  type WorkOrderGroupView,
  type WorkOrderView,
} from "../../../packages/factory/src";
import type { D1FactoryStore } from "./factory-store";

/**
 * Graph-derived operator/read models are disposable projections. This adapter
 * can be rebuilt from the D1 Factory store and never writes lifecycle state.
 */
export class D1FactoryReadModel {
  constructor(private readonly store: D1FactoryStore) {}

  async factoryOperatorView(factoryId: string, organizationId: string): Promise<{
    factory: { factoryId: string; organizationId: string; name: string; status: string; definitionDigest?: string; alias?: string; schemaVersion?: string };
    activity: Array<WorkOrder & { group: ReturnType<typeof classifyWorkOrderGroup>; column: ReturnType<typeof classifyActivityColumn> }>;
    runs: Array<Record<string, string>>;
    scorers: Array<Record<string, unknown>>;
    selfImprovement: Array<Record<string, unknown>>;
    automations: FactoryDefinition["automations"];
    agents: FactoryDefinition["agents"];
    definitionFiles: Array<{ path: string; contents: string }>;
    metrics: ReturnType<typeof factoryDashboardMetrics>;
    graph: Record<string, FactoryProjection>;
    workOrders: WorkOrderView[];
    costs: { totalCents: number; acceptedChanges: number; medianDurationSeconds?: number; ownershipLabel: string };
  } | null> {
    const factory = await this.store.getFactory(factoryId);
    if (!factory || factory.organizationId !== organizationId) return null;
    const orders = (await this.store.listWorkOrders(organizationId)).filter((order) => order.factoryId === factoryId);
    const graphEntries = await Promise.all(orders.map(async (order) => ({ order, graph: await this.store.reconstructFactoryGraph(order.workOrderId, organizationId) })));
    const projectedOrders = graphEntries.map(({ order, graph }) => ({ ...order, status: graph.workOrderState ?? order.status, currentStage: graph.currentStage ?? order.currentStage, actor: graph.currentActorId ?? order.actor }));
    const latest = await this.store.getLatestDefinition(factoryId);
    let definition: FactoryDefinition | undefined;
    if (latest) {
      definition = parseFactoryDefinition(latest.yaml);
      if (latest.files.length) definition = applyFactoryTree(definition, latest.files);
    }
    const workOrders = await Promise.all(orders.map((order) => this.store.getWorkOrderView(order.workOrderId, organizationId)));
    const normalizedOrders = workOrders.filter((order): order is WorkOrderView => Boolean(order));
    const dashboardMetrics = factoryDashboardMetrics({ statuses: projectedOrders.map((order) => order.status) });
    const counts = normalizedOrders.reduce((result, order) => { result[order.group] += 1; return result; }, { blocked: 0, awaiting_review: 0, in_progress: 0, ready: 0, released: 0, unknown: 0 } as Record<WorkOrderGroupView, number>);
    const usage = await this.store.listFactoryUsage(factoryId, organizationId);
    return {
      factory: { ...factory, alias: definition?.alias, schemaVersion: definition?.schemaVersion },
      activity: projectedOrders.map((order) => ({ ...order, column: classifyActivityColumn(order.status) })),
      runs: await this.store.listFactoryRuns(factoryId),
      scorers: await this.store.listScorers(factoryId),
      selfImprovement: await this.store.listSelfImprovement(factoryId),
      automations: definition?.automations ?? [],
      agents: definition?.agents ?? [],
      definitionFiles: latest?.files ?? (latest ? [{ path: ".tinkerbot/factory.yaml", contents: latest.yaml }] : []),
      metrics: { ...dashboardMetrics, inProgress: counts.in_progress, awaitingReview: counts.awaiting_review, released: counts.released },
      graph: Object.fromEntries(graphEntries.map(({ order, graph }) => [order.workOrderId, graph])),
      workOrders: normalizedOrders,
      costs: { totalCents: usage.reduce((total, item) => total + item.costCents, 0), acceptedChanges: counts.released, medianDurationSeconds: undefined, ownershipLabel: "Measured platform and provider spend are reported separately." },
    };
  }

  async listWorkOrderViews(organizationId: string, factoryId?: string): Promise<WorkOrderView[]> {
    const orders = await this.store.listWorkOrders(organizationId);
    const views = await Promise.all(orders.filter((order) => !factoryId || order.factoryId === factoryId).map((order) => this.store.getWorkOrderView(order.workOrderId, organizationId)));
    return views.filter((view): view is WorkOrderView => Boolean(view));
  }

  async getWorkOrderView(workOrderId: string, organizationId: string): Promise<WorkOrderView | null> {
    const order = await this.store.getWorkOrder(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    const events = await this.store.listFactoryEvents(workOrderId, organizationId);
    const graph = projectFactoryEvents(events);
    const projectedStatus = graph.workOrderState ?? order.status;
    const projectedStage = graph.currentStage ?? order.currentStage;
    const projectedActor = graph.currentActorId ?? order.actor;
    const latest = <T extends { occurredAt: string }>(items: T[]): T | undefined => items.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1);
    const verificationEvent = latest(events.filter((event) => ["verification.recorded", "verification.completed"].includes(event.type)));
    const reviewEvent = latest(events.filter((event) => ["review.recorded", "review.completed", "approval.recorded"].includes(event.type) && event.actorType === "human"));
    const releaseEvent = latest(events.filter((event) => ["release.decided", "release.executed", "release.completed", "release.authorized"].includes(event.type) && event.actorType === "human"));
    const verification = normalizeVerificationVerdict(graph.verificationVerdict ?? (verificationEvent?.payload && typeof verificationEvent.payload === "object" ? (verificationEvent.payload as Record<string, unknown>).verdict : order.verificationVerdict), projectedStage ? "not_run" : "unknown");
    const reviewPayload = reviewEvent?.payload && typeof reviewEvent.payload === "object" ? reviewEvent.payload as Record<string, unknown> : undefined;
    const canonicalReview = graph.reviewAssessment === "CLEAR" ? "approved" : graph.reviewAssessment === "REVISE" ? "changes_requested" : graph.reviewAssessment === "NEEDS_HUMAN_REVIEW" ? "awaiting_human" : undefined;
    const review = canonicalReview ? normalizeReviewDecision(canonicalReview, "awaiting_human") : reviewEvent ? normalizeReviewDecision(reviewPayload?.decision, "awaiting_human") : normalizeReviewDecision(order.reviewAssessment, "awaiting_human");
    const releasePayload = releaseEvent?.payload && typeof releaseEvent.payload === "object" ? releaseEvent.payload as Record<string, unknown> : undefined;
    const canonicalRelease = graph.releaseExecuted ? "released" : graph.releaseDecision === "RELEASE" ? "approved" : graph.releaseDecision === "HOLD" ? "hold" : graph.releaseApprovalEventId ? "awaiting_authorization" : verification === "pass" && review === "approved" && ["approval", "ready", "merged"].includes(projectedStatus) ? "awaiting_authorization" : undefined;
    const release = canonicalRelease ? normalizeReleaseDecision(canonicalRelease, { verification, review, released: canonicalRelease === "released" }) : normalizeReleaseDecision(releaseEvent ? releasePayload?.decision : order.releaseDecision, { verification, review, released: Boolean(graph.releaseExecuted) });
    const outcome = normalizeOutcomeStatus(projectedStatus === "released" ? "accepted" : projectedStatus === "failed" ? "failed" : undefined, "pending");
    const run = await this.store.getRunByWorkOrder(order.workOrderId);
    const unresolvedUnknownCount = verification === "unknown" || verification === "not_run" && ["verification", "release"].includes(stageView(projectedStage)) ? 1 : 0;
    const group = groupView({ status: projectedStatus, verification, review, release, outcome });
    const canRetry = ["failed", "blocked"].includes(projectedStatus);
    const canReview = review === "awaiting_human" && verification !== "fail" && verification !== "blocked";
    const canRelease = verification === "pass" && review === "approved" && (release === "awaiting_authorization" || release === "hold");
    const availableActions: ActionCapability[] = [
      { id: order.heldBy ? "return" : "take", label: order.heldBy ? "Return cell" : "Take cell", allowed: true },
      { id: "steer", label: "Add operator note", allowed: true },
      { id: "retry", label: "Retry run", allowed: canRetry, reason: canRetry ? undefined : "Retry is available after a failed or blocked run." },
      { id: "review", label: "Record review", allowed: canReview, reason: canReview ? undefined : "Review is only available when the work is awaiting human review." },
      { id: "authorize_release", label: "Authorize release", allowed: canRelease, reason: canRelease ? undefined : "Deterministic verification, human review, and release policy must be resolved first." },
    ];
    const actorKind: "agent" | "human" | "system" = order.sourceType === "manual" ? "human" : projectedActor.toLowerCase().startsWith("agent") || projectedActor.toLowerCase().includes("bot") ? "agent" : "system";
    return {
      id: order.workOrderId,
      workOrderId: order.workOrderId,
      title: order.issueOrPullRequest ?? order.intent ?? order.workOrderId,
      factoryId: order.factoryId,
      status: projectedStatus,
      repository: order.repositoryId ? { id: order.repositoryId, name: order.repositoryId } : undefined,
      stage: stageView(projectedStage),
      actor: { id: projectedActor, name: projectedActor, kind: actorKind },
      risk: order.risk ?? "unknown",
      updatedAt: order.updatedAt,
      verificationVerdict: verification,
      reviewDecision: review,
      releaseDecision: release,
      outcomeStatus: outcome,
      unresolvedUnknownCount,
      latestRunId: run?.run_id,
      group,
      availableActions,
      intent: order.intent,
      acceptanceCriteria: order.acceptanceCriteria,
      sourceType: order.sourceType,
      sourceId: order.sourceId,
      blockedReason: projectedStatus === "blocked" ? "A required factory gate or authorized execution surface is unresolved." : projectedStatus === "failed" ? "The latest deterministic verification failed." : undefined,
    };
  }
}
