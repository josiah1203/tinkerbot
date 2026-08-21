import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";

type FactoryLookup = (factoryId: string) => Promise<{ organizationId: string } | null>;

/**
 * Persistence for execution and assurance artifacts. These records support
 * the Factory spine but cannot advance lifecycle state or append graph events.
 */
export class D1FactoryArtifactStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly getFactory: FactoryLookup,
  ) {}

  async listFactoryRuns(factoryId: string): Promise<Array<Record<string, string>>> {
    const statement = this.database.prepare("SELECT run_id, work_order_id, factory_id, definition_digest, status, started_at, completed_at, updated_at FROM tinkerbot_factory_runs WHERE factory_id = ?1 ORDER BY started_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string>>();
    return result.results ?? [];
  }

  async listFactoryUsage(factoryId: string, organizationId: string): Promise<Array<{ kind: string; tokens: number; costCents: number; createdAt: string }>> {
    const statement = this.database.prepare("SELECT kind, tokens, cost_cents, created_at FROM tinkerbot_usage_events WHERE factory_id = ?1 AND organization_id = ?2 ORDER BY created_at DESC").bind(factoryId, organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ kind: string; tokens: number; cost_cents: number; created_at: string }>();
    return (result.results ?? []).map((row) => ({ kind: row.kind, tokens: row.tokens, costCents: row.cost_cents, createdAt: row.created_at }));
  }

  async listFactoryEvidence(factoryId: string, organizationId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT e.evidence_id, e.run_id, e.kind, e.object_key, e.digest, e.signed, e.created_at, r.work_order_id, r.factory_id FROM tinkerbot_evidence_records e JOIN tinkerbot_factory_runs r ON r.run_id = e.run_id JOIN tinkerbot_factories f ON f.factory_id = r.factory_id WHERE r.factory_id = ?1 AND f.organization_id = ?2 ORDER BY e.created_at DESC").bind(factoryId, organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ id: row.evidence_id, evidenceId: row.evidence_id, name: `${String(row.kind)} evidence`, workOrderId: row.work_order_id, factoryId: row.factory_id, type: row.kind, producer: "Factory run", provenance: row.signed ? "signed" : "recorded", recordedAt: row.created_at }));
  }

  async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_factory_runs (run_id, work_order_id, factory_id, definition_digest, status, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)").bind(run.runId, run.workOrderId, run.factoryId, run.definitionDigest, run.status, run.now).run();
  }

  async updateRun(runId: string, status: string, now: string): Promise<void> {
    const terminal = status !== "running" && !status.startsWith("waiting");
    await this.database.prepare("UPDATE tinkerbot_factory_runs SET status = ?1, completed_at = CASE WHEN ?2 = 1 THEN COALESCE(completed_at, ?3) ELSE completed_at END, updated_at = ?3 WHERE run_id = ?4").bind(status, terminal ? 1 : 0, now, runId).run();
  }

  async updateRunDefinition(runId: string, definitionDigest: string, now: string): Promise<void> {
    await this.database.prepare("UPDATE tinkerbot_factory_runs SET definition_digest = ?1, updated_at = ?2 WHERE run_id = ?3").bind(definitionDigest, now, runId).run();
  }

  async getRun(runId: string): Promise<Record<string, string> | null> {
    return this.database.prepare("SELECT run_id, work_order_id, factory_id, definition_digest, status, started_at, completed_at, updated_at FROM tinkerbot_factory_runs WHERE run_id = ?1").bind(runId).first<Record<string, string>>();
  }

  async getRunForOrganization(runId: string, organizationId: string): Promise<Record<string, string> | null> {
    const run = await this.getRun(runId);
    if (!run) return null;
    const factory = await this.getFactory(run.factory_id);
    if (!factory || factory.organizationId !== organizationId) return null;
    return run;
  }

  async getRunByWorkOrder(workOrderId: string): Promise<Record<string, string> | null> {
    return this.database.prepare("SELECT run_id, work_order_id, factory_id, definition_digest, status, started_at, completed_at, updated_at FROM tinkerbot_factory_runs WHERE work_order_id = ?1 ORDER BY started_at DESC").bind(workOrderId).first<Record<string, string>>();
  }

  async consumeOidcReplayKey(key: string, now: string): Promise<"ok" | "replay"> {
    const result = await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_oidc_jti (jti, consumed_at) VALUES (?1, ?2)").bind(key, now).run() as { meta?: { changes?: number } };
    return result.meta?.changes === 0 ? "replay" : "ok";
  }

  async listRunStages(runId: string): Promise<Array<{ stage: string; status: string; summary?: string }>> {
    const statement = this.database.prepare("SELECT stage, status, summary FROM tinkerbot_run_stages WHERE run_id = ?1 ORDER BY started_at").bind(runId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ stage: string; status: string; summary?: string }>();
    return result.results ?? [];
  }

  async insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<boolean> {
    // The stable key makes concurrent queue deliveries converge on one row;
    // the runtime can then avoid issuing a second receipt/cost record when it
    // loses the insert race.
    const result = await this.database.prepare("INSERT INTO tinkerbot_run_stages (run_stage_id, run_id, stage, status, summary, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(run_stage_id) DO NOTHING").bind(`${runId}:${stage}`, runId, stage, status, summary, now).run() as { meta?: { changes?: number } };
    return result.meta?.changes !== 0;
  }

  /** Complete an already-persisted stage without appending a duplicate row. */
  async updateStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void> {
    await this.database.prepare("UPDATE tinkerbot_run_stages SET status = ?1, summary = ?2, completed_at = ?3 WHERE run_id = ?4 AND stage = ?5").bind(status, summary, now, runId, stage).run();
  }

  async insertUsage(event: { organizationId: string; factoryId?: string; runId?: string; kind: string; tokens: number; costCents: number; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_usage_events (usage_id, organization_id, factory_id, run_id, kind, tokens, cost_cents, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(crypto.randomUUID(), event.organizationId, event.factoryId ?? null, event.runId ?? null, event.kind, event.tokens, event.costCents, event.now).run();
  }

  async insertAiCostEvent(event: { organizationId: string; factoryId?: string; workOrderId?: string; runId?: string; stageId?: string; agentId?: string; modelId: string; tokens: number; costMinor: number; now: string; provider?: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_ai_cost_events (event_id, organization_id, factory_id, seat_id, service_identity_id, work_order_id, run_id, stage_id, agent_id, model_id, provider, input_tokens, cached_input_tokens, output_tokens, retry_count, estimated_cost_minor, cost_catalog_version, created_at) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, 0, ?11, '2026-08-18.seat-v1', ?12)").bind(crypto.randomUUID(), event.organizationId, event.factoryId ?? null, event.workOrderId ?? null, event.runId ?? null, event.stageId ?? null, event.agentId ?? null, event.modelId, event.provider ?? "workers-ai", event.tokens, event.costMinor, event.now).run();
  }

  async insertAgentReceipt(input: { runId: string; agentId: string; receipt: unknown; digest: string; signed: boolean; now: string }): Promise<void> {
    const agentRunId = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_agent_runs (agent_run_id, run_id, agent_id, status, created_at) VALUES (?1, ?2, ?3, 'recorded', ?4)").bind(agentRunId, input.runId, input.agentId, input.now).run();
    await this.database.prepare("INSERT INTO tinkerbot_agent_receipts (receipt_id, agent_run_id, digest, signed, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), agentRunId, input.digest, input.signed ? 1 : 0, JSON.stringify(input.receipt), input.now).run();
  }

  async insertEvidence(input: { runId: string; kind: string; objectKey: string; digest: string; signed?: boolean; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_evidence_records (evidence_id, run_id, kind, object_key, digest, signed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(crypto.randomUUID(), input.runId, input.kind, input.objectKey, input.digest, input.signed ? 1 : 0, input.now).run();
  }

  async putSeatLedger(organizationId: string, periodStart: string, activeSeats: number, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_seat_ledger (organization_id, period_start, active_seats, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(organization_id, period_start) DO UPDATE SET active_seats = excluded.active_seats, updated_at = excluded.updated_at").bind(organizationId, periodStart, activeSeats, now).run();
  }

  async listUsage(organizationId: string): Promise<Array<{ kind: string; tokens: number; costCents: number; createdAt: string }>> {
    const statement = this.database.prepare("SELECT kind, tokens, cost_cents, created_at FROM tinkerbot_usage_events WHERE organization_id = ?1 ORDER BY created_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ kind: string; tokens: number; cost_cents: number; created_at: string }>();
    return (result.results ?? []).map((row) => ({ kind: row.kind, tokens: row.tokens, costCents: row.cost_cents, createdAt: row.created_at }));
  }

  async putRunToken(tokenId: string, runId: string, repository: string, sha: string | undefined, expiresAt: string, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_run_tokens (token_id, run_id, repository, sha, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(tokenId, runId, repository, sha ?? null, expiresAt, now).run();
  }

  async getRunToken(tokenId: string): Promise<{ runId: string; repository: string; sha?: string; expiresAt: string } | null> {
    const row = await this.database.prepare("SELECT run_id, repository, sha, expires_at FROM tinkerbot_run_tokens WHERE token_id = ?1").bind(tokenId).first<{ run_id: string; repository: string; sha?: string | null; expires_at: string }>();
    return row ? { runId: row.run_id, repository: row.repository, sha: row.sha ?? undefined, expiresAt: row.expires_at } : null;
  }

  async putPublication(input: { runId: string; commitSha: string; fingerprint: string; kind: string; remoteId?: string; now: string }): Promise<"created" | "duplicate"> {
    const existing = await this.database.prepare("SELECT publication_id FROM tinkerbot_github_publications WHERE run_id = ?1 AND fingerprint = ?2 AND commit_sha = ?3 AND kind = ?4").bind(input.runId, input.fingerprint, input.commitSha, input.kind).first<{ publication_id: string }>();
    if (existing) return "duplicate";
    await this.database.prepare("INSERT INTO tinkerbot_github_publications (publication_id, run_id, commit_sha, fingerprint, kind, remote_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)").bind(crypto.randomUUID(), input.runId, input.commitSha, input.fingerprint, input.kind, input.remoteId ?? null, input.now).run();
    return "created";
  }

  async putConversation(input: { workOrderId: string; agentId: string; r2Key: string; now: string }): Promise<string> {
    const conversationId = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_conversations (conversation_id, work_order_id, agent_id, r2_key, zdr, training, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 0, ?5)").bind(conversationId, input.workOrderId, input.agentId, input.r2Key, input.now).run();
    return conversationId;
  }

  async putExecutionPlan(plan: import("../../../packages/factory/src/runtime").ExecutionPlan): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_execution_plans (plan_id, work_order_id, run_id, origin, profile_json, plan_json, selected_pipeline, escalation_reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(plan_id) DO UPDATE SET plan_json = excluded.plan_json, escalation_reason = excluded.escalation_reason").bind(plan.planId, plan.workOrderId ?? null, null, plan.origin, JSON.stringify(plan.profile), JSON.stringify(plan), plan.selectedPipeline, plan.escalationReason ?? null, plan.createdAt).run();
  }

  async getExecutionPlanForWorkOrder(workOrderId: string): Promise<import("../../../packages/factory/src/runtime").ExecutionPlan | null> {
    const row = await this.database.prepare("SELECT plan_json FROM tinkerbot_execution_plans WHERE work_order_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(workOrderId).first<{ plan_json?: string | null }>();
    if (!row?.plan_json) return null;
    try {
      const plan = JSON.parse(row.plan_json) as import("../../../packages/factory/src/runtime").ExecutionPlan;
      return plan && typeof plan === "object" && typeof plan.planId === "string" && plan.workOrderId === workOrderId ? plan : null;
    } catch {
      return null;
    }
  }

  async putCostEstimate(planId: string, estimate: import("../../../packages/factory/src/runtime").CostEstimate): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_cost_estimates (plan_id, catalog_version, estimate_json, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(plan_id) DO UPDATE SET estimate_json = excluded.estimate_json").bind(planId, estimate.catalogVersion, JSON.stringify(estimate), new Date().toISOString()).run();
  }

  async putCostActual(input: { planId: string; runId: string; usage: import("../../../packages/factory/src/runtime").ProviderUsage; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_cost_actuals (actual_id, plan_id, run_id, stage, provider, model, input_tokens, output_tokens, cached_tokens, retries, latency_ms, managed, catalog_version, runner_origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)").bind(crypto.randomUUID(), input.planId, input.runId, input.usage.stage ?? null, input.usage.provider, input.usage.model, input.usage.inputTokens, input.usage.outputTokens, input.usage.cachedTokens, input.usage.retries, input.usage.latencyMs, input.usage.managed ? 1 : 0, input.usage.catalogVersion, input.usage.runnerOrigin, input.now).run();
  }

  async putEvalSuite(suite: import("../../../packages/factory/src/evals").EvalSuite): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_eval_suites (suite_id, name, yaml, baseline_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(suite_id) DO UPDATE SET baseline_digest = excluded.baseline_digest").bind(suite.suiteId, suite.name, JSON.stringify(suite), suite.baselineDigest ?? null, suite.createdAt).run();
  }

  async insertEvalAttempt(attempt: import("../../../packages/factory/src/evals").EvalAttempt): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_eval_attempts (attempt_id, suite_id, task_id, output, metrics_json, passed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(attempt.attemptId, attempt.suiteId, attempt.taskId, attempt.output, JSON.stringify(attempt.metrics), attempt.passed ? 1 : 0, attempt.createdAt).run();
  }
}
