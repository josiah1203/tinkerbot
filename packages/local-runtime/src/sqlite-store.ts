import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MemoryFactoryStore, type FactoryStore, type OutboxEvent, type InlineApprovalRecord } from "../../factory/src/store";
import type { CostEstimate, ExecutionPlan, ProviderUsage } from "../../factory/src/runtime";
import type { EvalAttempt, EvalSuite } from "../../factory/src/evals";
import { assertCanonicalFactoryEvent, assertFactoryEventAuthority, assertFactoryEventOrdering, commandPayloadFingerprint, createApprovalRecordedEvent, createFactoryProjectionCheckpoint, graphEventForWorkOrderTransition, isFactoryCommandBoundaryEventType, projectFactoryAuditEvents, projectFactoryEvents, shadowReadFactoryProjection, validateReleaseApprovalReference, type AftercareRecord, type FactoryCommand, type FactoryCommandInput, type FactoryCommandReceipt, type FactoryCommandResult, type FactoryEvent, type FactoryProjection, type FactoryProjectionCheckpoint, type WorkOrder, type WorkOrderState } from "../../factory/src";
import { openSqliteDatabase, SQLITE_MAGIC, type SqliteDatabase } from "./sqlite-engine";
import { assertNoSecretInPayload } from "./credentials";

export const LOCAL_DB_SCHEMA_VERSION = 18;

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
  execution_plan_id TEXT,
  verification_verdict TEXT NOT NULL DEFAULT 'UNKNOWN',
  review_assessment TEXT NOT NULL DEFAULT 'NEEDS_HUMAN_REVIEW',
  release_decision TEXT NOT NULL DEFAULT 'BLOCKED',
  waiver_json TEXT
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
CREATE TABLE IF NOT EXISTS tinkerbot_factory_commands (
  command_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authorized INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  work_order_id TEXT,
  action TEXT NOT NULL,
  confirmation_required INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_factory_command_receipts (
  organization_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  command_id TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, work_order_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS tinkerbot_aftercare (
  release_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  environment TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tinkerbot_factory_graph_events (
  event_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  aggregate_sequence INTEGER,
  command_id TEXT,
  idempotency_key TEXT,
  payload_fingerprint TEXT,
  policy_version TEXT,
  provenance TEXT NOT NULL,
  external_references_json TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_factory_graph_aggregate ON tinkerbot_factory_graph_events (aggregate_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tinkerbot_factory_graph_sequence ON tinkerbot_factory_graph_events (aggregate_id, aggregate_sequence);
CREATE TABLE IF NOT EXISTS tinkerbot_factory_projection_checkpoints (
  organization_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  last_event_id TEXT,
  last_aggregate_sequence INTEGER,
  projection_json TEXT NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'RETRY_PENDING')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, aggregate_id)
);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_factory_projection_retry
  ON tinkerbot_factory_projection_checkpoints (status, updated_at);
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
    ensureSqliteColumns(this.database);
    this.migratedFromJson = Boolean(jsonPending);
    if (jsonPending) this.importJson(jsonPending);
    else this.loadSql();
    if (!jsonPending) this.backfillLegacyGraph();
    this.database.prepare("INSERT INTO tinkerbot_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", String(LOCAL_DB_SCHEMA_VERSION));
  }

  schemaVersion(): number {
    const row = this.database.prepare("SELECT value FROM tinkerbot_metadata WHERE key = ?").get("schema_version");
    return Number(row?.value ?? LOCAL_DB_SCHEMA_VERSION);
  }

  /**
   * Synchronous command-side persistence for the non-async `tb` CLI. The
   * underlying SQLite adapter is synchronous; keeping this path explicit
   * prevents `tb work new`/`tb intent` from returning before their canonical
   * Factory Graph events are durable.
   */
  appendFactoryEventSync(event: FactoryEvent, options: { migration?: boolean } = {}): void {
    if (!options.migration && isFactoryCommandBoundaryEventType(event.type)) throw new Error("factory_command_boundary_required");
    assertFactoryEventAuthority(event);
    if (!options.migration) assertFactoryEventOrdering(event, this.readFactoryEvents(event.aggregateId));
    assertNoSecretInPayload({ payload: event.payload, externalReferences: event.externalReferences });
    const result = this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
    ) as { changes?: number };
    if (result.changes !== 1) return;
    const outbox: OutboxEvent = { eventId: event.eventId, kind: "factory-graph-event", payloadJson: JSON.stringify({ event }), createdAt: event.occurredAt };
    this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, NULL)").run(outbox.eventId, outbox.kind, outbox.payloadJson, outbox.createdAt);
    if (!this.outbox.some((item) => item.eventId === outbox.eventId)) this.outbox.push(outbox);
    if (event.aggregateType === "work_order") this.refreshLifecycleProjectionSync(event.aggregateId);
  }

  dispatchFactoryCommandSync<T>(input: FactoryCommandInput<T>): FactoryCommandResult {
    if (!input.organizationId || !input.factoryId || !input.workOrderId || !input.idempotencyKey) throw new Error("invalid_factory_command_identity");
    const commandId = input.commandId ?? `cmd_${crypto.randomUUID().replace(/-/g, "")}`;
    const payloadFingerprint = commandPayloadFingerprint(input.payload);
    const receiptKey = `${input.organizationId}:${input.workOrderId}:${input.idempotencyKey}`;
    const durable = this.readFactoryCommandReceiptSync(input.organizationId, input.workOrderId, input.idempotencyKey);
    const known = durable ?? this.commandReceipts.get(receiptKey);
    const priorEvents = this.readFactoryEvents(input.workOrderId);
    if (known) {
      if (known.payloadFingerprint !== payloadFingerprint) throw new Error("idempotency_conflict");
      return { replayed: true, commandId: known.commandId, payloadFingerprint, eventIds: known.eventIds, events: priorEvents.filter((event) => known.eventIds.includes(event.eventId)), projection: projectFactoryEvents(priorEvents) };
    }
    const matching = priorEvents.filter((event) => event.idempotencyKey === input.idempotencyKey);
    if (matching.length) {
      if (matching.some((event) => event.payloadFingerprint !== payloadFingerprint)) throw new Error("idempotency_conflict");
      const recovered: FactoryCommandReceipt = { organizationId: input.organizationId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, commandId: matching[0]!.commandId ?? commandId, eventIds: matching.map((event) => event.eventId), createdAt: input.now ?? new Date().toISOString() };
      this.commandReceipts.set(receiptKey, recovered);
      return { replayed: true, commandId: recovered.commandId, payloadFingerprint, eventIds: recovered.eventIds, events: matching, projection: projectFactoryEvents(priorEvents) };
    }
    const maxSequence = priorEvents.reduce((max, event) => Math.max(max, event.aggregateSequence ?? 0), 0);
    const built = input.buildEvents({ priorEvents, nextSequence: maxSequence + 1, commandId, payloadFingerprint });
    if (!built.length) throw new Error("factory_command_produced_no_events");
    const events = built.map((builtEvent, index) => ({ ...builtEvent, aggregateId: input.workOrderId, organizationId: input.organizationId, factoryId: input.factoryId, actorId: input.actorId, actorType: input.actorType, aggregateSequence: maxSequence + index + 1, commandId, idempotencyKey: input.idempotencyKey, payloadFingerprint }) as FactoryEvent);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.type === "release.decided") validateReleaseApprovalReference(event, priorEvents, events.slice(0, index));
      assertFactoryEventOrdering(event, [...priorEvents, ...events.slice(0, index)]);
      assertCanonicalFactoryEvent(event);
    }
    const receipt: FactoryCommandReceipt = { organizationId: input.organizationId, workOrderId: input.workOrderId, idempotencyKey: input.idempotencyKey, payloadFingerprint, commandId, eventIds: events.map((event) => event.eventId), resultJson: JSON.stringify({ eventIds: events.map((event) => event.eventId) }), createdAt: input.now ?? new Date().toISOString() };
    try {
      this.database.exec("BEGIN");
      for (const event of events) {
        this.database.prepare("INSERT INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
        );
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, NULL)").run(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt);
      }
      this.database.prepare("INSERT INTO tinkerbot_factory_command_receipts (organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey, receipt.payloadFingerprint, receipt.commandId, JSON.stringify(receipt.eventIds), receipt.resultJson ?? null, receipt.createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original persistence failure */ }
      throw error;
    }
    for (const event of events) this.factoryEvents.push(Object.freeze(event));
    this.commandReceipts.set(receiptKey, receipt);
    this.refreshLifecycleProjectionSync(input.workOrderId);
    return { replayed: false, commandId, payloadFingerprint, eventIds: receipt.eventIds, events, projection: projectFactoryEvents([...priorEvents, ...events]) };
  }

  /** Persist a work order and its creation event atomically from the CLI. */
  insertWorkOrderSync(order: WorkOrder, event: FactoryEvent): void {
    this.database.prepare(`INSERT INTO tinkerbot_work_orders (
      work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria,
      policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id,
      owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, origin, execution_plan_id,
      verification_verdict, review_assessment, release_decision, waiver_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_order_id) DO UPDATE SET status = excluded.status, current_stage = excluded.current_stage, updated_at = excluded.updated_at`).run(
      order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null,
      order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null,
      order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.origin ?? "local", order.executionPlanId ?? null,
      order.verificationVerdict ?? "UNKNOWN", order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", order.releaseDecision ?? "BLOCKED", order.waiver ? JSON.stringify(order.waiver) : null,
    );
    this.orders.set(order.workOrderId, order);
    this.appendFactoryEventSync(event);
  }

  private importJson(raw: string): void {
    const parsed = JSON.parse(raw) as JsonPersistedState;
    for (const order of parsed.orders ?? []) this.insertWorkOrderSync(order, {
      eventId: `evt_${order.workOrderId}`, type: "work_order.created", aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId: order.factoryId,
      actorId: order.actor, actorType: order.sourceType === "manual" ? "human" : "integration", occurredAt: order.createdAt, correlationId: order.workOrderId, schemaVersion: 1, policyVersion: order.policyVersion, provenance: "ATTESTED",
      payload: { workOrderId: order.workOrderId, intent: order.intent, sourceType: order.sourceType, sourceId: order.sourceId },
    });
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
    for (const row of this.database.prepare("SELECT * FROM tinkerbot_factory_graph_events").all()) {
      const event = rowToFactoryEvent(row);
      if (!this.factoryEvents.some((item) => item.eventId === event.eventId)) this.factoryEvents.push(event);
    }
    for (const row of this.database.prepare("SELECT payload_json FROM tinkerbot_agent_receipts").all()) {
      this.receipts.push(JSON.parse(String(row.payload_json)));
    }
  }

  /** Backfill the canonical graph once when opening a pre-graph local database. */
  private backfillLegacyGraph(): void {
    const orders = this.database.prepare("SELECT work_order_id, factory_id, organization_id, source_type, source_id, intent, policy_version, actor, created_at FROM tinkerbot_work_orders").all() as Array<Record<string, unknown>>;
    for (const row of orders) {
      const workOrderId = String(row.work_order_id);
      this.appendFactoryEventSync({
        eventId: `evt_${workOrderId}`, type: "work_order.created", aggregateId: workOrderId, aggregateType: "work_order", organizationId: String(row.organization_id), factoryId: String(row.factory_id),
        actorId: String(row.actor), actorType: row.source_type === "manual" ? "human" : "integration", occurredAt: String(row.created_at), correlationId: workOrderId, schemaVersion: 1, policyVersion: String(row.policy_version), provenance: "ATTESTED",
        payload: { workOrderId, intent: row.intent ? String(row.intent) : undefined, sourceType: String(row.source_type), sourceId: String(row.source_id) },
      });
    }
    const transitions = this.database.prepare("SELECT e.event_id, e.work_order_id, e.from_state, e.to_state, e.cause_id, e.actor, e.created_at, w.factory_id, w.organization_id, w.policy_version FROM tinkerbot_work_order_events e JOIN tinkerbot_work_orders w ON w.work_order_id = e.work_order_id ORDER BY e.created_at, e.event_id").all() as Array<Record<string, unknown>>;
    for (const row of transitions) {
      const event = graphEventForWorkOrderTransition({ workOrderId: String(row.work_order_id), factoryId: String(row.factory_id), organizationId: String(row.organization_id), actor: String(row.actor), policyVersion: String(row.policy_version), fromState: String(row.from_state), toState: String(row.to_state), causeId: String(row.cause_id), createdAt: String(row.created_at) });
      if (event) this.appendFactoryEventSync(event, { migration: true });
    }
    const approvals = this.database.prepare("SELECT approval_id, work_order_id, requester, approver, actor_kind, decision, created_at FROM tinkerbot_inline_approvals WHERE actor_kind <> 'agent'").all() as Array<Record<string, unknown>>;
    for (const row of approvals) {
      const order = orders.find((item) => String(item.work_order_id) === String(row.work_order_id));
      if (!order) continue;
      const eventId = `approval_${row.work_order_id}_${row.decision}_${row.approval_id}`;
      if (this.readFactoryEvents(String(row.work_order_id)).some((event) => event.eventId === eventId)) continue;
      const event = createApprovalRecordedEvent({
        eventId,
        aggregateId: String(row.work_order_id),
        aggregateType: "work_order",
        organizationId: String(order.organization_id),
        factoryId: String(order.factory_id),
        actorId: String(row.approver),
        actorType: "human",
        occurredAt: String(row.created_at),
        correlationId: String(row.work_order_id),
        policyVersion: String(order.policy_version),
        provenance: "HUMAN_VERIFIED",
        workOrderId: String(row.work_order_id),
        scope: "SPEC",
        outcome: String(row.decision) === "approved" ? "GRANTED" : "DENIED",
        approverId: String(row.approver),
        rationale: `Migrated legacy approval ${String(row.approval_id)} from ${String(row.requester)}.`,
      });
      this.dispatchFactoryCommandSync({
        organizationId: String(order.organization_id),
        factoryId: String(order.factory_id),
        workOrderId: String(row.work_order_id),
        actorId: String(row.approver),
        actorType: "human",
        commandId: `migration_${eventId}`,
        idempotencyKey: `migration:${eventId}`,
        payload: { approvalId: String(row.approval_id), scope: "SPEC", outcome: event.payload.outcome },
        now: String(row.created_at),
        buildEvents: () => [event],
      });
    }
  }

  override async insertWorkOrder(order: WorkOrder): Promise<void> {
    await super.insertWorkOrder(order);
    this.database.prepare(`INSERT INTO tinkerbot_work_orders (
      work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria,
      policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id,
      owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, origin, execution_plan_id,
      verification_verdict, review_assessment, release_decision, waiver_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_order_id) DO UPDATE SET status = excluded.status, current_stage = excluded.current_stage, updated_at = excluded.updated_at`).run(
      order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null,
      order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null,
      order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.origin ?? "local", order.executionPlanId ?? null,
      order.verificationVerdict ?? "UNKNOWN", order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", order.releaseDecision ?? "BLOCKED", order.waiver ? JSON.stringify(order.waiver) : null,
    );
  }

  override async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string, now?: string) {
    const result = await super.applyTransition(workOrderId, toState, causeId, actor, now);
    if (result.ok && result.event) {
      this.database.prepare("INSERT OR IGNORE INTO tinkerbot_work_order_events (event_id, work_order_id, from_state, to_state, cause_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        result.event.eventId, result.event.workOrderId, result.event.fromState, result.event.toState, result.event.causeId, result.event.actor, result.event.createdAt,
      );
      // Route/status columns are compatibility projections of the graph. The
      // refresh also advances the durable checkpoint for this transition.
      this.refreshLifecycleProjectionSync(workOrderId, result.event.createdAt);
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

  override async insertFactoryCommand(command: FactoryCommand): Promise<void> {
    await super.insertFactoryCommand(command);
    this.database.prepare("INSERT INTO tinkerbot_factory_commands (command_id, organization_id, source_system, source_object_id, actor_id, authorized, idempotency_key, work_order_id, action, confirmation_required, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(command_id) DO NOTHING").run(
      command.commandId, command.organizationId, command.sourceSystem, command.sourceObjectId, command.actorId, command.authorized ? 1 : 0, command.idempotencyKey, command.workOrderId ?? null, command.action, command.confirmationRequired ? 1 : 0, JSON.stringify(command), command.createdAt,
    );
  }

  private readFactoryCommandReceiptSync(organizationId: string, workOrderId: string, idempotencyKey: string): FactoryCommandReceipt | null {
    const row = this.database.prepare("SELECT organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at FROM tinkerbot_factory_command_receipts WHERE organization_id = ? AND work_order_id = ? AND idempotency_key = ?").get(organizationId, workOrderId, idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    let eventIds: string[] = [];
    try { const parsed = JSON.parse(String(row.event_ids_json)); if (Array.isArray(parsed)) eventIds = parsed.filter((item): item is string => typeof item === "string"); } catch { /* malformed receipt is treated as absent */ }
    return { organizationId: String(row.organization_id), workOrderId: String(row.work_order_id), idempotencyKey: String(row.idempotency_key), payloadFingerprint: String(row.payload_fingerprint), commandId: String(row.command_id), eventIds, resultJson: row.result_json ? String(row.result_json) : undefined, createdAt: String(row.created_at) };
  }

  override async getFactoryCommandReceipt(organizationId: string, workOrderId: string, idempotencyKey: string): Promise<FactoryCommandReceipt | null> {
    return this.readFactoryCommandReceiptSync(organizationId, workOrderId, idempotencyKey);
  }

  override async putFactoryCommandReceipt(receipt: FactoryCommandReceipt): Promise<void> {
    const existing = await this.getFactoryCommandReceipt(receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey);
    if (existing && existing.payloadFingerprint !== receipt.payloadFingerprint) throw new Error("idempotency_conflict");
    this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_command_receipts (organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey, receipt.payloadFingerprint, receipt.commandId, JSON.stringify(receipt.eventIds), receipt.resultJson ?? null, receipt.createdAt,
    );
  }

  /** Persist a command's receipt, graph events, and graph outbox atomically. */
  async appendFactoryCommand(events: readonly FactoryEvent[], receipt: FactoryCommandReceipt): Promise<void> {
    if (!events.length) throw new Error("factory_command_produced_no_events");
    const priorByAggregate = new Map<string, FactoryEvent[]>();
    for (const event of events) {
      const prior = priorByAggregate.get(event.aggregateId) ?? this.readFactoryEvents(event.aggregateId);
      assertFactoryEventAuthority(event);
      assertFactoryEventOrdering(event, prior);
      assertNoSecretInPayload({ payload: event.payload, externalReferences: event.externalReferences });
      priorByAggregate.set(event.aggregateId, [...prior, event]);
    }
    try {
      this.database.exec("BEGIN");
      this.database.prepare("INSERT INTO tinkerbot_factory_command_receipts (organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey, receipt.payloadFingerprint, receipt.commandId, JSON.stringify(receipt.eventIds), receipt.resultJson ?? null, receipt.createdAt,
      );
      for (const event of events) {
        this.database.prepare("INSERT INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.schemaVersion, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
        );
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, NULL)").run(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original persistence failure */ }
      throw error;
    }
    for (const event of events) {
      if (!this.factoryEvents.some((candidate) => candidate.eventId === event.eventId)) this.factoryEvents.push(Object.freeze(event));
      const outbox: OutboxEvent = { eventId: event.eventId, kind: "factory-graph-event", payloadJson: JSON.stringify({ event }), createdAt: event.occurredAt };
      if (!this.outbox.some((candidate) => candidate.eventId === outbox.eventId)) this.outbox.push(outbox);
    }
    for (const aggregateId of new Set(events.map((event) => event.aggregateId))) this.refreshLifecycleProjectionSync(aggregateId);
  }

  override async insertAftercare(record: AftercareRecord): Promise<void> {
    await super.insertAftercare(record);
    this.database.prepare("INSERT INTO tinkerbot_aftercare (release_id, owner, environment, payload_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(release_id) DO UPDATE SET payload_json = excluded.payload_json").run(
      record.releaseId, record.owner, record.environment, JSON.stringify(record), new Date().toISOString(),
    );
  }

  override async appendFactoryEvent(event: FactoryEvent, options: { commandBoundary?: boolean } = {}): Promise<void> {
    assertNoSecretInPayload({ payload: event.payload, externalReferences: event.externalReferences });
    await super.appendFactoryEvent(event, options);
    try {
      this.database.prepare("INSERT INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
      );
      await this.enqueueOutbox({ eventId: event.eventId, kind: "factory-graph-event", payloadJson: JSON.stringify({ event }), createdAt: event.occurredAt });
      if (event.aggregateType === "work_order") this.refreshLifecycleProjectionSync(event.aggregateId);
    } catch (error) {
      this.factoryEvents.splice(this.factoryEvents.findIndex((item) => item.eventId === event.eventId), 1);
      throw error;
    }
  }

  override async appendFactoryEvents(events: readonly FactoryEvent[], options: { commandBoundary?: boolean } = {}): Promise<void> {
    await super.appendFactoryEvents(events, options);
    try {
      this.database.exec("BEGIN");
      for (const event of events) {
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
        );
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?, ?, ?, ?, NULL)").run(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt);
      }
      this.database.exec("COMMIT");
      for (const aggregateId of new Set(events.map((event) => event.aggregateId))) this.refreshLifecycleProjectionSync(aggregateId);
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original persistence failure */ }
      const ids = new Set(events.map((event) => event.eventId));
      for (let index = this.factoryEvents.length - 1; index >= 0; index -= 1) if (ids.has(this.factoryEvents[index]!.eventId)) this.factoryEvents.splice(index, 1);
      throw error;
    }
  }

  readFactoryEvents(aggregateId: string): FactoryEvent[] {
    const rows = this.database.prepare("SELECT * FROM tinkerbot_factory_graph_events WHERE aggregate_id = ? ORDER BY COALESCE(aggregate_sequence, 9223372036854775807), occurred_at, event_id").all(aggregateId) as Array<Record<string, unknown>>;
    return rows.map(rowToFactoryEvent).sort((left, right) => (left.aggregateSequence !== undefined && right.aggregateSequence !== undefined && left.aggregateSequence !== right.aggregateSequence ? left.aggregateSequence - right.aggregateSequence : left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId)));
  }

  private readFactoryProjectionCheckpointSync(organizationId: string, aggregateId: string): FactoryProjectionCheckpoint | null {
    const row = this.database.prepare("SELECT organization_id, aggregate_id, aggregate_type, last_event_id, last_aggregate_sequence, projection_json, projection_fingerprint, status, attempt_count, last_error, updated_at FROM tinkerbot_factory_projection_checkpoints WHERE organization_id = ? AND aggregate_id = ?").get(organizationId, aggregateId) as Record<string, unknown> | undefined;
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

  private writeFactoryProjectionCheckpointSync(checkpoint: FactoryProjectionCheckpoint): void {
    this.database.prepare("INSERT INTO tinkerbot_factory_projection_checkpoints (organization_id, aggregate_id, aggregate_type, last_event_id, last_aggregate_sequence, projection_json, projection_fingerprint, status, attempt_count, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id, aggregate_id) DO UPDATE SET aggregate_type = excluded.aggregate_type, last_event_id = excluded.last_event_id, last_aggregate_sequence = excluded.last_aggregate_sequence, projection_json = excluded.projection_json, projection_fingerprint = excluded.projection_fingerprint, status = excluded.status, attempt_count = excluded.attempt_count, last_error = excluded.last_error, updated_at = excluded.updated_at").run(
      checkpoint.organizationId, checkpoint.aggregateId, checkpoint.aggregateType, checkpoint.lastEventId ?? null, checkpoint.lastAggregateSequence ?? null, JSON.stringify(checkpoint.projection), checkpoint.projectionFingerprint, checkpoint.status, checkpoint.attemptCount, checkpoint.lastError ?? null, checkpoint.updatedAt,
    );
  }

  private projectionErrorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  }

  private refreshLifecycleProjectionSync(workOrderId: string, updatedAt = new Date().toISOString()): void {
    const order = this.orders.get(workOrderId);
    if (!order) return;
    const events = this.readFactoryEvents(workOrderId);
    const projection = projectFactoryEvents(events);
    const reviewAssessment = projection.reviewAssessment === "CLEAR" || projection.reviewAssessment === "REVISE" ? projection.reviewAssessment : "NEEDS_HUMAN_REVIEW";
    const releaseDecision = projection.releaseDecision === "RELEASE" ? "READY" : "BLOCKED";
    const priorCheckpoint = this.readFactoryProjectionCheckpointSync(order.organizationId, workOrderId);
    const checkpoint = createFactoryProjectionCheckpoint({ organizationId: order.organizationId, aggregateId: workOrderId, aggregateType: events[0]?.aggregateType ?? "work_order", events, projection, status: "APPLIED", attemptCount: 0, updatedAt });
    try {
      this.database.exec("BEGIN");
      this.database.prepare("UPDATE tinkerbot_work_orders SET status = COALESCE(?, status), current_stage = COALESCE(?, current_stage), actor = COALESCE(?, actor), updated_at = COALESCE(?, updated_at), verification_verdict = ?, review_assessment = ?, release_decision = ? WHERE work_order_id = ?").run(
        projection.workOrderState ?? null,
        projection.currentStage ?? null,
        projection.currentActorId ?? null,
        projection.lastTransitionAt ?? null,
        projection.verificationVerdict,
        reviewAssessment,
        releaseDecision,
        workOrderId,
      );
      this.writeFactoryProjectionCheckpointSync(checkpoint);
      this.database.exec("COMMIT");
      this.orders.set(workOrderId, {
        ...order,
        ...(projection.workOrderState ? { status: projection.workOrderState } : {}),
        ...(projection.currentStage ? { currentStage: projection.currentStage } : {}),
        ...(projection.currentActorId ? { actor: projection.currentActorId } : {}),
        ...(projection.lastTransitionAt ? { updatedAt: projection.lastTransitionAt } : {}),
        verificationVerdict: projection.verificationVerdict,
        reviewAssessment,
        releaseDecision,
      });
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original projection failure */ }
      const retry = createFactoryProjectionCheckpoint({ organizationId: order.organizationId, aggregateId: workOrderId, aggregateType: events[0]?.aggregateType ?? "work_order", events, projection, status: "RETRY_PENDING", attemptCount: (priorCheckpoint?.attemptCount ?? 0) + 1, lastError: this.projectionErrorMessage(error), updatedAt });
      try {
        this.writeFactoryProjectionCheckpointSync(retry);
      } catch {
        // The command remains failed; the ledger is still replayable even if
        // the recovery marker itself needs an operator-level storage retry.
      }
      throw error;
    }
  }

  async getFactoryProjectionCheckpoint(workOrderId: string, organizationId: string): Promise<FactoryProjectionCheckpoint | null> {
    const order = this.orders.get(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    return this.readFactoryProjectionCheckpointSync(organizationId, workOrderId);
  }

  /** Rebuilds the compatibility projection from the authoritative graph. */
  async rebuildFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection | null> {
    const order = this.orders.get(workOrderId);
    if (!order || order.organizationId !== organizationId) return null;
    this.refreshLifecycleProjectionSync(workOrderId, updatedAt);
    return projectFactoryEvents(this.readFactoryEvents(workOrderId));
  }

  async retryFactoryProjection(workOrderId: string, organizationId: string, updatedAt = new Date().toISOString()): Promise<FactoryProjection | null> {
    return this.rebuildFactoryProjection(workOrderId, organizationId, updatedAt);
  }

  override async listFactoryEvents(aggregateId: string): Promise<FactoryEvent[]> { return this.readFactoryEvents(aggregateId); }

  override async reconstructFactoryGraph(aggregateId: string): Promise<FactoryProjection> {
    return projectFactoryEvents(this.readFactoryEvents(aggregateId));
  }

  shadowReadWorkOrder(workOrderId: string): ReturnType<typeof shadowReadFactoryProjection> | null {
    const order = this.orders.get(workOrderId);
    if (!order) return null;
    return shadowReadFactoryProjection(this.reconstructFactoryGraphSync(workOrderId), { verificationVerdict: order.verificationVerdict, reviewAssessment: order.reviewAssessment, releaseDecision: order.releaseDecision });
  }

  listFactoryAuditEvents(workOrderId: string): ReturnType<typeof projectFactoryAuditEvents> {
    return projectFactoryAuditEvents(this.readFactoryEvents(workOrderId));
  }

  private reconstructFactoryGraphSync(workOrderId: string): FactoryProjection {
    return projectFactoryEvents(this.readFactoryEvents(workOrderId));
  }
}

function ensureSqliteColumns(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(tinkerbot_work_orders)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("verification_verdict")) database.exec("ALTER TABLE tinkerbot_work_orders ADD COLUMN verification_verdict TEXT NOT NULL DEFAULT 'UNKNOWN'");
  if (!names.has("review_assessment")) database.exec("ALTER TABLE tinkerbot_work_orders ADD COLUMN review_assessment TEXT NOT NULL DEFAULT 'NEEDS_HUMAN_REVIEW'");
  if (!names.has("release_decision")) database.exec("ALTER TABLE tinkerbot_work_orders ADD COLUMN release_decision TEXT NOT NULL DEFAULT 'BLOCKED'");
  if (!names.has("waiver_json")) database.exec("ALTER TABLE tinkerbot_work_orders ADD COLUMN waiver_json TEXT");
  const eventColumns = database.prepare("PRAGMA table_info(tinkerbot_factory_graph_events)").all() as Array<{ name: string }>;
  const eventNames = new Set(eventColumns.map((column) => column.name));
  if (!eventNames.has("aggregate_sequence")) database.exec("ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN aggregate_sequence INTEGER");
  if (!eventNames.has("schema_version")) database.exec("ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
  if (!eventNames.has("command_id")) database.exec("ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN command_id TEXT");
  if (!eventNames.has("idempotency_key")) database.exec("ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN idempotency_key TEXT");
  if (!eventNames.has("payload_fingerprint")) database.exec("ALTER TABLE tinkerbot_factory_graph_events ADD COLUMN payload_fingerprint TEXT");
  database.exec("CREATE TABLE IF NOT EXISTS tinkerbot_factory_command_receipts (organization_id TEXT NOT NULL, work_order_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, command_id TEXT NOT NULL, event_ids_json TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (organization_id, work_order_id, idempotency_key))");
  database.exec("CREATE TABLE IF NOT EXISTS tinkerbot_factory_projection_checkpoints (organization_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, last_event_id TEXT, last_aggregate_sequence INTEGER, projection_json TEXT NOT NULL, projection_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('APPLIED', 'RETRY_PENDING')), attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (organization_id, aggregate_id))");
  database.exec("CREATE INDEX IF NOT EXISTS idx_tinkerbot_factory_projection_retry ON tinkerbot_factory_projection_checkpoints (status, updated_at)");
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
    verificationVerdict: (row.verification_verdict as WorkOrder["verificationVerdict"]) || "UNKNOWN",
    reviewAssessment: (row.review_assessment as WorkOrder["reviewAssessment"]) || "NEEDS_HUMAN_REVIEW",
    releaseDecision: (row.release_decision as WorkOrder["releaseDecision"]) || "BLOCKED",
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

function rowToFactoryEvent(row: Record<string, unknown>): FactoryEvent {
  return { eventId: String(row.event_id), aggregateId: String(row.aggregate_id), aggregateType: String(row.aggregate_type), organizationId: String(row.organization_id), factoryId: String(row.factory_id), type: String(row.event_type) as FactoryEvent["type"], actorId: String(row.actor_id), actorType: String(row.actor_type) as FactoryEvent["actorType"], occurredAt: String(row.occurred_at), correlationId: String(row.correlation_id), causationId: row.causation_id ? String(row.causation_id) : undefined, aggregateSequence: row.aggregate_sequence === null || row.aggregate_sequence === undefined ? undefined : Number(row.aggregate_sequence), commandId: row.command_id ? String(row.command_id) : undefined, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined, payloadFingerprint: row.payload_fingerprint ? String(row.payload_fingerprint) : undefined, schemaVersion: Number(row.schema_version ?? 1) as 1, policyVersion: row.policy_version ? String(row.policy_version) : undefined, provenance: String(row.provenance) as FactoryEvent["provenance"], externalReferences: row.external_references_json ? JSON.parse(String(row.external_references_json)) : undefined, payload: JSON.parse(String(row.payload_json)) };
}
