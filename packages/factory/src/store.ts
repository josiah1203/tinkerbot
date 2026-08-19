import type { WorkOrder, WorkOrderEvent, WorkOrderState } from "./index";
import type { CostEstimate, ExecutionPlan, ProviderUsage } from "./runtime";
import type { EvalAttempt, EvalSuite } from "./evals";

export interface FactoryStore {
  insertWorkOrder(order: WorkOrder): Promise<void>;
  getWorkOrder(workOrderId: string): Promise<WorkOrder | null>;
  listWorkOrders(organizationId: string): Promise<WorkOrder[]>;
  applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string): Promise<{ ok: true; order: WorkOrder; event?: WorkOrderEvent } | { ok: false; code: "not_found" | "invalid_transition" | "idempotent" }>;
  insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void>;
  getRun(runId: string): Promise<Record<string, string> | null>;
  getRunByWorkOrder(workOrderId: string): Promise<Record<string, string> | null>;
  insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void>;
  listRunStages(runId: string): Promise<Array<{ stage: string; status: string; summary?: string }>>;
  putExecutionPlan(plan: ExecutionPlan): Promise<void>;
  getExecutionPlan(planId: string): Promise<ExecutionPlan | null>;
  getExecutionPlanForWorkOrder(workOrderId: string): Promise<ExecutionPlan | null>;
  putCostEstimate(planId: string, estimate: CostEstimate): Promise<void>;
  putCostActual(input: { planId: string; runId: string; usage: ProviderUsage; now: string }): Promise<void>;
  listCostActuals(runId: string): Promise<ProviderUsage[]>;
  insertApprovalRecord(input: InlineApprovalRecord): Promise<{ ok: true } | { ok: false; reason: string }>;
  insertAgentReceipt(input: { runId: string; agentId: string; receipt: unknown; digest: string; signed: boolean; now: string }): Promise<void>;
  putEvalSuite(suite: EvalSuite): Promise<void>;
  getEvalSuite(suiteId: string): Promise<EvalSuite | null>;
  insertEvalAttempt(attempt: EvalAttempt): Promise<void>;
  listEvalAttempts(suiteId: string): Promise<EvalAttempt[]>;
  enqueueOutbox(event: OutboxEvent): Promise<void>;
  listOutbox(limit?: number): Promise<OutboxEvent[]>;
  markOutboxSynced(eventId: string, now: string): Promise<void>;
}

export interface InlineApprovalRecord {
  approvalId: string;
  workOrderId: string;
  requester: string;
  approver: string;
  actorKind: "human" | "agent";
  baseSha?: string;
  headSha?: string;
  evidenceDigest?: string;
  reviewedAcceptanceCriteria?: string;
  rationale?: string;
  decision: "approved" | "rejected";
  createdAt: string;
}

export interface OutboxEvent {
  eventId: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
  syncedAt?: string;
}

export class MemoryFactoryStore implements FactoryStore {
  readonly orders = new Map<string, WorkOrder>();
  readonly events: WorkOrderEvent[] = [];
  readonly runs = new Map<string, Record<string, string>>();
  readonly stages = new Map<string, Array<{ stage: string; status: string; summary?: string }>>();
  readonly plans = new Map<string, ExecutionPlan>();
  readonly estimates = new Map<string, CostEstimate>();
  readonly actuals = new Map<string, ProviderUsage[]>();
  readonly approvals: InlineApprovalRecord[] = [];
  readonly receipts: unknown[] = [];
  readonly suites = new Map<string, EvalSuite>();
  readonly attempts: EvalAttempt[] = [];
  readonly outbox: OutboxEvent[] = [];

  async insertWorkOrder(order: WorkOrder): Promise<void> {
    this.orders.set(order.workOrderId, order);
  }

  async getWorkOrder(workOrderId: string): Promise<WorkOrder | null> {
    return this.orders.get(workOrderId) ?? null;
  }

  async listWorkOrders(organizationId: string): Promise<WorkOrder[]> {
    return [...this.orders.values()].filter((order) => order.organizationId === organizationId);
  }

  async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string): Promise<{ ok: true; order: WorkOrder; event?: WorkOrderEvent } | { ok: false; code: "not_found" | "invalid_transition" | "idempotent" }> {
    const { transitionWorkOrder } = await import("./index");
    const current = this.orders.get(workOrderId);
    if (!current) return { ok: false, code: "not_found" };
    const result = transitionWorkOrder(current, toState, causeId, actor);
    if ("error" in result) return { ok: false, code: result.error };
    this.orders.set(workOrderId, result.order);
    this.events.push(result.event);
    return { ok: true, order: result.order, event: result.event };
  }

  async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    this.runs.set(run.runId, { run_id: run.runId, work_order_id: run.workOrderId, factory_id: run.factoryId, definition_digest: run.definitionDigest, status: run.status, started_at: run.now, updated_at: run.now });
  }

  async getRun(runId: string): Promise<Record<string, string> | null> {
    return this.runs.get(runId) ?? null;
  }

  async getRunByWorkOrder(workOrderId: string): Promise<Record<string, string> | null> {
    return [...this.runs.values()].find((run) => run.work_order_id === workOrderId) ?? null;
  }

  async insertStage(runId: string, stage: string, status: string, summary: string, _now?: string): Promise<void> {
    const list = this.stages.get(runId) ?? [];
    list.push({ stage, status, summary });
    this.stages.set(runId, list);
  }

  async listRunStages(runId: string): Promise<Array<{ stage: string; status: string; summary?: string }>> {
    return this.stages.get(runId) ?? [];
  }

  async putExecutionPlan(plan: ExecutionPlan): Promise<void> {
    this.plans.set(plan.planId, plan);
  }

  async getExecutionPlan(planId: string): Promise<ExecutionPlan | null> {
    return this.plans.get(planId) ?? null;
  }

  async getExecutionPlanForWorkOrder(workOrderId: string): Promise<ExecutionPlan | null> {
    return [...this.plans.values()].find((plan) => plan.workOrderId === workOrderId) ?? null;
  }

  async putCostEstimate(planId: string, estimate: CostEstimate): Promise<void> {
    this.estimates.set(planId, estimate);
  }

  async putCostActual(input: { planId: string; runId: string; usage: ProviderUsage }): Promise<void> {
    const list = this.actuals.get(input.runId) ?? [];
    list.push(input.usage);
    this.actuals.set(input.runId, list);
  }

  async listCostActuals(runId: string): Promise<ProviderUsage[]> {
    return this.actuals.get(runId) ?? [];
  }

  async insertApprovalRecord(input: InlineApprovalRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (input.actorKind === "agent" || /agent|bot|foreman|tinkerbot/i.test(input.approver)) return { ok: false, reason: "agent_cannot_approve" };
    this.approvals.push(input);
    return { ok: true };
  }

  async insertAgentReceipt(input: { runId: string; agentId: string; receipt: unknown; digest: string; signed: boolean; now: string }): Promise<void> {
    this.receipts.push(input);
  }

  async putEvalSuite(suite: EvalSuite): Promise<void> {
    this.suites.set(suite.suiteId, suite);
  }

  async getEvalSuite(suiteId: string): Promise<EvalSuite | null> {
    return this.suites.get(suiteId) ?? null;
  }

  async insertEvalAttempt(attempt: EvalAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async listEvalAttempts(suiteId: string): Promise<EvalAttempt[]> {
    return this.attempts.filter((attempt) => attempt.suiteId === suiteId);
  }

  async enqueueOutbox(event: OutboxEvent): Promise<void> {
    this.outbox.push(event);
  }

  async listOutbox(limit = 50): Promise<OutboxEvent[]> {
    return this.outbox.filter((event) => !event.syncedAt).slice(0, limit);
  }

  async markOutboxSynced(eventId: string, now: string): Promise<void> {
    const event = this.outbox.find((item) => item.eventId === eventId);
    if (event) event.syncedAt = now;
  }
}
