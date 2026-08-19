import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryFactoryStore, type FactoryStore, type OutboxEvent } from "../../factory/src/store";
import type { CostEstimate, ExecutionPlan, ProviderUsage } from "../../factory/src/runtime";
import type { EvalAttempt, EvalSuite } from "../../factory/src/evals";
import type { WorkOrder, WorkOrderState } from "../../factory/src";
import type { InlineApprovalRecord } from "../../factory/src/store";

export const LOCAL_DB_SCHEMA_VERSION = 13;

export function defaultLocalDbPath(root?: string): string {
  if (process.env.TINKERBOT_LOCAL_DB) return process.env.TINKERBOT_LOCAL_DB;
  if (root) {
    const repo = path.join(root, ".tinkerbot", "state.sqlite");
    if (fs.existsSync(path.dirname(repo))) return repo;
  }
  return path.join(os.homedir(), ".tinkerbot", "local.db");
}

interface PersistedState {
  schemaVersion: number;
  orders: WorkOrder[];
  runs: Array<[string, Record<string, string>]>;
  stages: Array<[string, Array<{ stage: string; status: string; summary?: string }>]>;
  plans: ExecutionPlan[];
  estimates: Array<[string, CostEstimate]>;
  actuals: Array<[string, ProviderUsage[]]>;
  approvals: InlineApprovalRecord[];
  suites: EvalSuite[];
  attempts: EvalAttempt[];
  outbox: OutboxEvent[];
}

/** File-backed FactoryStore. Uses a SQLite-shaped schema version; persistence is JSON so Workers never import this module. */
export class SqliteFactoryStore extends MemoryFactoryStore implements FactoryStore {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: PersistedState = {
      schemaVersion: LOCAL_DB_SCHEMA_VERSION,
      orders: [...this.orders.values()],
      runs: [...this.runs.entries()],
      stages: [...this.stages.entries()],
      plans: [...this.plans.values()],
      estimates: [...this.estimates.entries()],
      actuals: [...this.actuals.entries()],
      approvals: this.approvals,
      suites: [...this.suites.values()],
      attempts: this.attempts,
      outbox: this.outbox,
    };
    fs.writeFileSync(this.filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedState;
      if (parsed.schemaVersion !== LOCAL_DB_SCHEMA_VERSION && parsed.schemaVersion != null && parsed.schemaVersion < 1) return;
      for (const order of parsed.orders ?? []) this.orders.set(order.workOrderId, order);
      for (const [id, run] of parsed.runs ?? []) this.runs.set(id, run);
      for (const [id, stages] of parsed.stages ?? []) this.stages.set(id, stages);
      for (const plan of parsed.plans ?? []) this.plans.set(plan.planId, plan);
      for (const [id, estimate] of parsed.estimates ?? []) this.estimates.set(id, estimate);
      for (const [id, usage] of parsed.actuals ?? []) this.actuals.set(id, usage);
      this.approvals.push(...(parsed.approvals ?? []));
      for (const suite of parsed.suites ?? []) this.suites.set(suite.suiteId, suite);
      this.attempts.push(...(parsed.attempts ?? []));
      this.outbox.push(...(parsed.outbox ?? []));
    } catch {
      /* corrupt local state stays empty; runs fail closed */
    }
  }

  override async insertWorkOrder(order: WorkOrder): Promise<void> {
    await super.insertWorkOrder(order);
    this.persist();
  }

  override async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string) {
    const result = await super.applyTransition(workOrderId, toState, causeId, actor);
    this.persist();
    return result;
  }

  override async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    await super.insertRun(run);
    this.persist();
  }

  override async insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void> {
    await super.insertStage(runId, stage, status, summary, now);
    this.persist();
  }

  override async putExecutionPlan(plan: ExecutionPlan): Promise<void> {
    await super.putExecutionPlan(plan);
    this.persist();
  }

  override async putCostEstimate(planId: string, estimate: CostEstimate): Promise<void> {
    await super.putCostEstimate(planId, estimate);
    this.persist();
  }

  override async putCostActual(input: { planId: string; runId: string; usage: ProviderUsage; now: string }): Promise<void> {
    await super.putCostActual(input);
    this.persist();
  }

  override async insertApprovalRecord(input: InlineApprovalRecord) {
    const result = await super.insertApprovalRecord(input);
    this.persist();
    return result;
  }

  override async putEvalSuite(suite: EvalSuite): Promise<void> {
    await super.putEvalSuite(suite);
    this.persist();
  }

  override async insertEvalAttempt(attempt: EvalAttempt): Promise<void> {
    await super.insertEvalAttempt(attempt);
    this.persist();
  }

  override async enqueueOutbox(event: OutboxEvent): Promise<void> {
    await super.enqueueOutbox(event);
    this.persist();
  }

  override async markOutboxSynced(eventId: string, now: string): Promise<void> {
    await super.markOutboxSynced(eventId, now);
    this.persist();
  }
}
