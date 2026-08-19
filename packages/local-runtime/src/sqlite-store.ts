import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MemoryFactoryStore, type FactoryStore, type OutboxEvent, type InlineApprovalRecord } from "../../factory/src/store";
import type { CostEstimate, ExecutionPlan, ProviderUsage } from "../../factory/src/runtime";
import type { EvalAttempt, EvalSuite } from "../../factory/src/evals";
import type { WorkOrder, WorkOrderState } from "../../factory/src";
import { openSqliteDatabase, SQLITE_MAGIC, type SqliteDatabase } from "./sqlite-engine";

export const LOCAL_DB_SCHEMA_VERSION = 13;

export function defaultLocalDbPath(root?: string): string {
  if (process.env.TINKERBOT_LOCAL_DB) return process.env.TINKERBOT_LOCAL_DB;
  if (root) {
    const repoDir = path.join(root, ".tinkerbot");
    const repo = path.join(repoDir, "state.sqlite");
    if (fs.existsSync(repo) || fs.existsSync(repoDir)) return repo;
  }
  return path.join(os.homedir(), ".tinkerbot", "local.db");
}

interface JsonPersistedState {
  schemaVersion?: number;
  orders?: WorkOrder[];
  runs?: Array<[string, Record<string, string>]>;
  stages?: Array<[string, Array<{ stage: string; status: string; summary?: string }>]>;
  plans?: ExecutionPlan[];
  estimates?: Array<[string, CostEstimate]>;
  actuals?: Array<[string, ProviderUsage[]]>;
  approvals?: InlineApprovalRecord[];
  suites?: EvalSuite[];
  attempts?: EvalAttempt[];
  outbox?: OutboxEvent[];
  receipts?: unknown[];
}

const LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS tinkerbot_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_work_orders (
  work_order_id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  issue_or_pull_request TEXT,
  intent TEXT,
  acceptance_criteria TEXT,
  policy_version TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  product_id TEXT,
  line_id TEXT,
  cell_id TEXT,
  owner TEXT,
  risk TEXT,
  autonomy_mode TEXT,
  output_kind TEXT,
  policy_json TEXT,
  dependencies_json TEXT,
  held_by TEXT,
  origin TEXT,
  execution_plan_id TEXT
);
CREATE TABLE IF NOT EXISTS tinkerbot_work_order_events (
  event_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  cause_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_factory_runs (
  run_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_run_stages (
  run_stage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS tinkerbot_agent_runs (
  agent_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_agent_receipts (
  receipt_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_execution_plans (
  plan_id TEXT PRIMARY KEY,
  work_order_id TEXT,
  run_id TEXT,
  origin TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  selected_pipeline TEXT NOT NULL,
  escalation_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_cost_estimates (
  plan_id TEXT PRIMARY KEY,
  catalog_version TEXT NOT NULL,
  estimate_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_cost_actuals (
  actual_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 1,
  catalog_version TEXT NOT NULL,
  runner_origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_provider_metadata (
  provider_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  credential_ref TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_eval_suites (
  suite_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yaml TEXT NOT NULL,
  baseline_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_eval_attempts (
  attempt_id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  output TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_sync_outbox (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS tinkerbot_inline_approvals (
  approval_id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  approver TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  evidence_digest TEXT,
  reviewed_ac TEXT,
  rationale TEXT,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function isSqliteFile(filePath: string): boolean {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 16) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    return buf.toString("utf8").startsWith(SQLITE_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

function isJsonStateFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const start = fs.readFileSync(filePath, { encoding: "utf8" }).trimStart().slice(0, 1);
  return start === "{";
}

/** File-backed FactoryStore using node:sqlite. Never import this module from the Cloudflare Worker. */
export class SqliteFactoryStore extends MemoryFactoryStore implements FactoryStore {
  readonly migratedFromJson: boolean;
  private readonly database: SqliteDatabase;

  constructor(private readonly filePath: string) {
    super();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const jsonPending = isJsonStateFile(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    if (jsonPending) {
      fs.writeFileSync(`${filePath}.json.bak`, jsonPending, { mode: 0o600 });
      fs.unlinkSync(filePath);
    }
    this.database = openSqliteDatabase(filePath);
    this.database.exec(LOCAL_DDL);
    this.migratedFromJson = Boolean(jsonPending);
    if (jsonPending) this.importJson(jsonPending);
    else this.loadSql();
    this.database.prepare("INSERT INTO tinkerbot_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", String(LOCAL_DB_SCHEMA_VERSION));
  }

  schemaVersion(): number {
    const row = this.database.prepare("SELECT value FROM tinkerbot_metadata WHERE key = ?").get("schema_version");
    return Number(row?.value ?? LOCAL_DB_SCHEMA_VERSION);
  }

  private importJson(raw: string): void {
    const parsed = JSON.parse(raw) as JsonPersistedState;
    for (const order of parsed.orders ?? []) void this.insertWorkOrder(order);
    for (const [id, run] of parsed.runs ?? []) {
      void this.insertRun({
        runId: run.run_id ?? id,
        workOrderId: run.work_order_id,
        factoryId: run.factory_id,
        definitionDigest: run.definition_digest,
        status: run.status,
        now: run.started_at ?? new Date().toISOString(),
      });
    }
    for (const [runId, stages] of parsed.stages ?? []) {
      for (const stage of stages) void this.insertStage(runId, stage.stage, stage.status, stage.summary ?? "", new Date().toISOString());
    }
    for (const plan of parsed.plans ?? []) void this.putExecutionPlan(plan);
    for (const [planId, estimate] of parsed.estimates ?? []) void this.putCostEstimate(planId, estimate);
    for (const [runId, usages] of parsed.actuals ?? []) {
      const planId = parsed.plans?.[0]?.planId ?? "migrated";
      for (const usage of usages) void this.putCostActual({ planId, runId, usage, now: new Date().toISOString() });
    }
    for (const approval of parsed.approvals ?? []) void this.insertApprovalRecord(approval);
    for (const suite of parsed.suites ?? []) void this.putEvalSuite(suite);
    for (const attempt of parsed.attempts ?? []) void this.insertEvalAttempt(attempt);
    for (const event of parsed.outbox ?? []) void this.enqueueOutbox(event);
  }

  private loadSql(): void {
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_work_orders").all()) {
      const order = rowToWorkOrder(row);
      this.orders.set(order.workOrderId, order);
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_factory_runs").all()) {
      this.runs.set(String(row.run_id), {
        run_id: String(row.run_id),
        work_order_id: String(row.work_order_id),
        factory_id: String(row.factory_id),
        definition_digest: String(row.definition_digest),
        status: String(row.status),
        started_at: String(row.started_at),
        updated_at: String(row.updated_at),
      });
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_run_stages").all()) {
      const runId = String(row.run_id);
      const list = this.stages.get(runId) ?? [];
      list.push({ stage: String(row.stage), status: String(row.status), summary: row.summary ? String(row.summary) : undefined });
      this.stages.set(runId, list);
    }
    for (const row of this.database.prepare("SELECT plan_json FROM tinkerbot_execution_plans").all()) {
      const plan = JSON.parse(String(row.plan_json)) as ExecutionPlan;
      this.plans.set(plan.planId, plan);
    }
    for (const row of this.database.prepare("SELECT plan_id, estimate_json FROM tinkerbot_cost_estimates").all()) {
      this.estimates.set(String(row.plan_id), JSON.parse(String(row.estimate_json)) as CostEstimate);
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_cost_actuals").all()) {
      const usage = rowToUsage(row);
      const list = this.actuals.get(String(row.run_id)) ?? [];
      list.push(usage);
      this.actuals.set(String(row.run_id), list);
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_inline_approvals").all()) {
      this.approvals.push({
        approvalId: String(row.approval_id),
        workOrderId: String(row.work_order_id),
        requester: String(row.requester),
        approver: String(row.approver),
        actorKind: row.actor_kind === "agent" ? "agent" : "human",
        decision: row.decision === "rejected" ? "rejected" : "approved",
        createdAt: String(row.created_at),
      });
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_eval_suites").all()) {
      this.suites.set(String(row.suite_id), {
        suiteId: String(row.suite_id),
        name: String(row.name),
        tasks: [],
        baselineDigest: row.baseline_digest ? String(row.baseline_digest) : undefined,
        createdAt: String(row.created_at),
      });
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_eval_attempts").all()) {
      this.attempts.push({
        attemptId: String(row.attempt_id),
        suiteId: String(row.suite_id),
        taskId: String(row.task_id),
        output: String(row.output),
        metrics: JSON.parse(String(row.metrics_json)),
        passed: Number(row.passed) === 1,
        createdAt: String(row.created_at),
      });
    }
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_sync_outbox").all()) {
      this.outbox.push({
        eventId: String(row.event_id),
        kind: String(row.kind),
        payloadJson: String(row.payload_json),
        createdAt: String(row.created_at),
        syncedAt: row.synced_at ? String(row.synced_at) : undefined,
      });
    }
    for (const row of this.database.prepare("SELECT payload_json FROM tinkerbot_agent_receipts").all()) {
      this.receipts.push(JSON.parse(String(row.payload_json)));
    }
  }

  override async insertWorkOrder(order: WorkOrder): Promise<void> {
    await super.insertWorkOrder(order);
    this.database.prepare(`INSERT INTO tinkerbot_work_orders (
      work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria,
      policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id,
      owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, origin, execution_plan_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_order_id) DO UPDATE SET status = excluded.status, current_stage = excluded.current_stage, updated_at = excluded.updated_at`).run(
      order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null,
      order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null,
      order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.origin ?? "local", order.executionPlanId ?? null,
    );
  }

  override async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string) {
    const result = await super.applyTransition(workOrderId, toState, causeId, actor);
    if (result.ok && result.event) {
      this.database.prepare("INSERT OR IGNORE INTO tinkerbot_work_order_events (event_id, work_order_id, from_state, to_state, cause_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        result.event.eventId, result.event.workOrderId, result.event.fromState, result.event.toState, result.event.causeId, result.event.actor, result.event.createdAt,
      );
      this.database.prepare("UPDATE tinkerbot_work_orders SET status = ?, current_stage = ?, actor = ?, updated_at = ?, held_by = ? WHERE work_order_id = ?").run(
        result.order.status, result.order.currentStage, result.order.actor, result.order.updatedAt, result.order.heldBy ?? null, workOrderId,
      );
    }
    return result;
  }

  override async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    await super.insertRun(run);
    this.database.prepare("INSERT INTO tinkerbot_factory_runs (run_id, work_order_id, factory_id, definition_digest, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").run(
      run.runId, run.workOrderId, run.factoryId, run.definitionDigest, run.status, run.now, run.now,
    );
  }

  override async insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void> {
    await super.insertStage(runId, stage, status, summary, now);
    this.database.prepare("INSERT INTO tinkerbot_run_stages (run_stage_id, run_id, stage, status, summary, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(), runId, stage, status, summary, now, now,
    );
  }

  override async putExecutionPlan(plan: ExecutionPlan): Promise<void> {
    await super.putExecutionPlan(plan);
    this.database.prepare(`INSERT INTO tinkerbot_execution_plans (plan_id, work_order_id, run_id, origin, profile_json, plan_json, selected_pipeline, escalation_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET plan_json = excluded.plan_json, escalation_reason = excluded.escalation_reason`).run(
      plan.planId, plan.workOrderId ?? null, null, plan.origin, JSON.stringify(plan.profile), JSON.stringify(plan), plan.selectedPipeline, plan.escalationReason ?? null, plan.createdAt,
    );
  }

  override async putCostEstimate(planId: string, estimate: CostEstimate): Promise<void> {
    await super.putCostEstimate(planId, estimate);
    this.database.prepare("INSERT INTO tinkerbot_cost_estimates (plan_id, catalog_version, estimate_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET estimate_json = excluded.estimate_json").run(
      planId, estimate.catalogVersion, JSON.stringify(estimate), new Date().toISOString(),
    );
  }

  override async putCostActual(input: { planId: string; runId: string; usage: ProviderUsage; now: string }): Promise<void> {
    await super.putCostActual(input);
    this.database.prepare(`INSERT INTO tinkerbot_cost_actuals (actual_id, plan_id, run_id, stage, provider, model, input_tokens, output_tokens, cached_tokens, retries, latency_ms, managed, catalog_version, runner_origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), input.planId, input.runId, input.usage.stage ?? null, input.usage.provider, input.usage.model, input.usage.inputTokens, input.usage.outputTokens, input.usage.cachedTokens, input.usage.retries, input.usage.latencyMs, input.usage.managed ? 1 : 0, input.usage.catalogVersion, input.usage.runnerOrigin, input.now,
    );
  }

  override async insertApprovalRecord(input: InlineApprovalRecord) {
    const result = await super.insertApprovalRecord(input);
    if (result.ok) {
      this.database.prepare(`INSERT INTO tinkerbot_inline_approvals (approval_id, work_order_id, requester, approver, actor_kind, base_sha, head_sha, evidence_digest, reviewed_ac, rationale, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.approvalId, input.workOrderId, input.requester, input.approver, input.actorKind, input.baseSha ?? null, input.headSha ?? null, input.evidenceDigest ?? null, input.reviewedAcceptanceCriteria ?? null, input.rationale ?? null, input.decision, input.createdAt,
      );
    }
    return result;
  }

  override async insertAgentReceipt(input: { runId: string; agentId: string; receipt: unknown; digest: string; signed: boolean; now: string }): Promise<void> {
    await super.insertAgentReceipt(input);
    const agentRunId = crypto.randomUUID();
    this.database.prepare("INSERT INTO tinkerbot_agent_runs (agent_run_id, run_id, agent_id, status, created_at) VALUES (?, ?, ?, 'recorded', ?)").run(agentRunId, input.runId, input.agentId, input.now);
    this.database.prepare("INSERT INTO tinkerbot_agent_receipts (receipt_id, agent_run_id, digest, signed, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(), agentRunId, input.digest, input.signed ? 1 : 0, JSON.stringify(input.receipt), input.now,
    );
  }

  override async putEvalSuite(suite: EvalSuite): Promise<void> {
    await super.putEvalSuite(suite);
    this.database.prepare("INSERT INTO tinkerbot_eval_suites (suite_id, name, yaml, baseline_digest, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(suite_id) DO UPDATE SET baseline_digest = excluded.baseline_digest").run(
      suite.suiteId, suite.name, JSON.stringify(suite), suite.baselineDigest ?? null, suite.createdAt,
    );
  }

  override async insertEvalAttempt(attempt: EvalAttempt): Promise<void> {
    await super.insertEvalAttempt(attempt);
    this.database.prepare("INSERT INTO tinkerbot_eval_attempts (attempt_id, suite_id, task_id, output, metrics_json, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      attempt.attemptId, attempt.suiteId, attempt.taskId, attempt.output, JSON.stringify(attempt.metrics), attempt.passed ? 1 : 0, attempt.createdAt,
    );
  }

  override async enqueueOutbox(event: OutboxEvent): Promise<void> {
    await super.enqueueOutbox(event);
    this.database.prepare("INSERT INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING").run(
      event.eventId, event.kind, event.payloadJson, event.createdAt, event.syncedAt ?? null,
    );
  }

  override async markOutboxSynced(eventId: string, now: string): Promise<void> {
    await super.markOutboxSynced(eventId, now);
    this.database.prepare("UPDATE tinkerbot_sync_outbox SET synced_at = ? WHERE event_id = ?").run(now, eventId);
  }
}

function rowToWorkOrder(row: Record<string, unknown>): WorkOrder {
  return {
    workOrderId: String(row.work_order_id),
    factoryId: String(row.factory_id),
    organizationId: String(row.organization_id),
    sourceType: row.source_type as WorkOrder["sourceType"],
    sourceId: String(row.source_id),
    repositoryId: String(row.repository_id),
    issueOrPullRequest: row.issue_or_pull_request ? String(row.issue_or_pull_request) : undefined,
    intent: row.intent ? String(row.intent) : undefined,
    acceptanceCriteria: row.acceptance_criteria ? String(row.acceptance_criteria) : undefined,
    policyVersion: String(row.policy_version),
    definitionVersion: String(row.definition_version),
    definitionDigest: String(row.definition_digest),
    currentStage: row.current_stage as WorkOrder["currentStage"],
    status: row.status as WorkOrder["status"],
    actor: String(row.actor),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    origin: row.origin === "hosted" ? "hosted" : "local",
    executionPlanId: row.execution_plan_id ? String(row.execution_plan_id) : undefined,
  };
}

function rowToUsage(row: Record<string, unknown>): ProviderUsage {
  return {
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cachedTokens: Number(row.cached_tokens ?? 0),
    retries: Number(row.retries ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    managed: Number(row.managed) === 1,
    stage: row.stage ? String(row.stage) : undefined,
    catalogVersion: String(row.catalog_version),
    runnerOrigin: row.runner_origin === "hosted" ? "hosted" : "local",
  };
}
