import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  WorkOrder,
  WorkOrderEvent,
  WorkOrderState,
  applyFactoryTree,
  assertFactoryEventAuthority,
  classifyActivityColumn,
  classifyWorkOrderGroup,
  createWorkOrder,
  factoryDashboardMetrics,
  factoryDefinitionDigest,
  parseFactoryDefinition,
  transitionWorkOrder,
  projectFactoryEvents,
  type FactoryEvent,
  type FactoryProjection,
  type FactoryDefinition,
} from "../../../packages/factory/src";

export class D1FactoryStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async listFactories(organizationId: string): Promise<Array<{ factoryId: string; name: string; status: string; updatedAt: string }>> {
    const statement = this.database.prepare("SELECT factory_id, name, status, updated_at FROM tinkerbot_factories WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ factory_id: string; name: string; status: string; updated_at: string }>();
    return (result.results ?? []).map((row) => ({ factoryId: row.factory_id, name: row.name, status: row.status, updatedAt: row.updated_at }));
  }

  async getFactory(factoryId: string): Promise<{ factoryId: string; organizationId: string; name: string; status: string; definitionDigest?: string } | null> {
    const row = await this.database.prepare("SELECT factory_id, organization_id, name, status, definition_digest FROM tinkerbot_factories WHERE factory_id = ?1").bind(factoryId).first<{ factory_id: string; organization_id: string; name: string; status: string; definition_digest?: string | null }>();
    return row ? { factoryId: row.factory_id, organizationId: row.organization_id, name: row.name, status: row.status, definitionDigest: row.definition_digest ?? undefined } : null;
  }

  async putFactory(input: { factoryId: string; organizationId: string; name: string; yaml?: string; files?: Array<{ path: string; contents: string }>; now?: string }): Promise<{ factoryId: string; digest?: string }> {
    const now = input.now ?? new Date().toISOString();
    let digest: string | undefined;
    if (input.yaml) {
      let definition = parseFactoryDefinition(input.yaml);
      if (input.files?.length) definition = applyFactoryTree(definition, input.files);
      digest = factoryDefinitionDigest(definition);
      const definitionId = crypto.randomUUID();
      await this.database.prepare("INSERT INTO tinkerbot_factory_definitions (definition_id, factory_id, digest, yaml, files_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(definitionId, input.factoryId, digest, input.yaml, input.files?.length ? JSON.stringify(input.files) : null, now).run();
      await this.database.prepare("INSERT INTO tinkerbot_factory_definition_versions (version_id, factory_id, definition_id, version, digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), input.factoryId, definitionId, Date.now(), digest, now).run();
      await this.replaceAutomations(input.factoryId, definition.automations ?? [], now);
    }
    await this.database.prepare("INSERT INTO tinkerbot_factories (factory_id, organization_id, name, status, definition_digest, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5) ON CONFLICT(factory_id) DO UPDATE SET name = excluded.name, definition_digest = COALESCE(excluded.definition_digest, tinkerbot_factories.definition_digest), updated_at = excluded.updated_at").bind(input.factoryId, input.organizationId, input.name, digest ?? null, now).run();
    return { factoryId: input.factoryId, digest };
  }

  async getLatestDefinition(factoryId: string): Promise<{ yaml: string; files: Array<{ path: string; contents: string }>; digest: string } | null> {
    const row = await this.database.prepare("SELECT yaml, files_json, digest FROM tinkerbot_factory_definitions WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId).first<{ yaml: string; files_json?: string | null; digest: string }>();
    if (!row) return null;
    let files: Array<{ path: string; contents: string }> = [];
    if (row.files_json) {
      try {
        const parsed = JSON.parse(row.files_json) as unknown;
        if (Array.isArray(parsed)) files = parsed.filter((item): item is { path: string; contents: string } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && typeof (item as { contents?: unknown }).contents === "string"));
      } catch { /* Stored files_json that is not an array is treated as missing files. */ }
    }
    return { yaml: row.yaml, files, digest: row.digest };
  }

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
  } | null> {
    const factory = await this.getFactory(factoryId);
    if (!factory || factory.organizationId !== organizationId) return null;
    const orders = (await this.listWorkOrders(organizationId)).filter((order) => order.factoryId === factoryId);
    const latest = await this.getLatestDefinition(factoryId);
    let definition: FactoryDefinition | undefined;
    if (latest) {
      definition = parseFactoryDefinition(latest.yaml);
      if (latest.files.length) definition = applyFactoryTree(definition, latest.files);
    }
    return {
      factory: { ...factory, alias: definition?.alias, schemaVersion: definition?.schemaVersion },
      activity: orders.map((order) => ({ ...order, column: classifyActivityColumn(order.status) })),
      runs: await this.listFactoryRuns(factoryId),
      scorers: await this.listScorers(factoryId),
      selfImprovement: await this.listSelfImprovement(factoryId),
      automations: definition?.automations ?? [],
      agents: definition?.agents ?? [],
      definitionFiles: latest?.files ?? (latest ? [{ path: ".tinkerbot/factory.yaml", contents: latest.yaml }] : []),
      metrics: factoryDashboardMetrics({ statuses: orders.map((order) => order.status) }),
      graph: Object.fromEntries(await Promise.all(orders.map(async (order) => [order.workOrderId, await this.reconstructFactoryGraph(order.workOrderId, organizationId)]))),
    };
  }

  async listFactoryRuns(factoryId: string): Promise<Array<Record<string, string>>> {
    const statement = this.database.prepare("SELECT run_id, work_order_id, factory_id, definition_digest, status, started_at, completed_at, updated_at FROM tinkerbot_factory_runs WHERE factory_id = ?1 ORDER BY started_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string>>();
    return result.results ?? [];
  }

  async listScorers(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT scorer_id, factory_id, name, criteria, enabled, self_improve, updated_at FROM tinkerbot_scorers WHERE factory_id = ?1 ORDER BY updated_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ ...row, upgradesVerdict: false }));
  }

  async listSelfImprovement(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT task_id, factory_id, work_order_id, title, status, created_at FROM tinkerbot_self_improvement_tasks WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ ...row, autoMerge: false }));
  }

  async replaceAutomations(factoryId: string, automations: FactoryDefinition["automations"], now: string): Promise<void> {
    await this.database.prepare("DELETE FROM tinkerbot_automations WHERE factory_id = ?1").bind(factoryId).run();
    for (const automation of automations) {
      await this.database.prepare("INSERT INTO tinkerbot_automations (automation_id, factory_id, trigger, agent_id, enabled, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(`${factoryId}:${automation.name}`, factoryId, JSON.stringify(automation.triggers), automation.agent, automation.enabled ? 1 : 0, now).run();
    }
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

  async insertWorkOrder(order: WorkOrder): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_work_orders (work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)").bind(order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null, order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null, order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.verificationVerdict ?? "UNKNOWN", order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", order.releaseDecision ?? "BLOCKED", order.waiver ? JSON.stringify(order.waiver) : null).run();
  }

  async applyTransition(workOrderId: string, toState: WorkOrderState, causeId: string, actor: string): Promise<{ ok: true; order: WorkOrder; event?: WorkOrderEvent } | { ok: false; code: "not_found" | "invalid_transition" | "idempotent" }> {
    const current = await this.getWorkOrder(workOrderId);
    if (!current) return { ok: false, code: "not_found" };
    const result = transitionWorkOrder(current, toState, causeId, actor);
    if ("error" in result) return { ok: false, code: result.error };
    await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_work_order_events (event_id, work_order_id, from_state, to_state, cause_id, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(result.event.eventId, result.event.workOrderId, result.event.fromState, result.event.toState, result.event.causeId, result.event.actor, result.event.createdAt).run();
    await this.database.prepare("UPDATE tinkerbot_work_orders SET status = ?1, current_stage = ?2, actor = ?3, updated_at = ?4, product_id = COALESCE(?5, product_id), line_id = COALESCE(?6, line_id), cell_id = COALESCE(?7, cell_id), autonomy_mode = COALESCE(?8, autonomy_mode), output_kind = COALESCE(?9, output_kind), held_by = ?10 WHERE work_order_id = ?11").bind(result.order.status, result.order.currentStage, result.order.actor, result.order.updatedAt, result.order.productId ?? null, result.order.lineId ?? null, result.order.cellId ?? null, result.order.autonomyMode ?? null, result.order.outputKind ?? null, result.order.heldBy ?? null, workOrderId).run();
    return { ok: true, order: result.order, event: result.event };
  }

  async insertRun(run: { runId: string; workOrderId: string; factoryId: string; definitionDigest: string; status: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_factory_runs (run_id, work_order_id, factory_id, definition_digest, status, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)").bind(run.runId, run.workOrderId, run.factoryId, run.definitionDigest, run.status, run.now).run();
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

  async insertStage(runId: string, stage: string, status: string, summary: string, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_run_stages (run_stage_id, run_id, stage, status, summary, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)").bind(crypto.randomUUID(), runId, stage, status, summary, now).run();
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

  async insertEvidence(input: { runId: string; kind: string; objectKey: string; digest: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_evidence_records (evidence_id, run_id, kind, object_key, digest, signed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)").bind(crypto.randomUUID(), input.runId, input.kind, input.objectKey, input.digest, input.now).run();
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

  async insertApproval(workOrderId: string, actor: string, decision: "approved" | "rejected", signature: string, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_approvals (approval_id, work_order_id, actor, decision, signature, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), workOrderId, actor, decision, signature, now).run();
  }

  async hasSpecApproval(workOrderId: string): Promise<boolean> {
    const row = await this.database.prepare("SELECT approval_id FROM tinkerbot_approvals WHERE work_order_id = ?1 AND decision = 'approved' LIMIT 1").bind(workOrderId).first<{ approval_id: string }>();
    return Boolean(row);
  }

  async putConversation(input: { workOrderId: string; agentId: string; r2Key: string; now: string }): Promise<string> {
    const conversationId = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_conversations (conversation_id, work_order_id, agent_id, r2_key, zdr, training, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 0, ?5)").bind(conversationId, input.workOrderId, input.agentId, input.r2Key, input.now).run();
    return conversationId;
  }

  async insertScorer(input: { factoryId: string; name: string; criteria: string; now: string }): Promise<string> {
    const scorerId = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_scorers (scorer_id, factory_id, name, criteria, enabled, self_improve, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1, ?5)").bind(scorerId, input.factoryId, input.name, input.criteria, input.now).run();
    return scorerId;
  }

  async insertBenchmark(factoryId: string, metric: string, value: number, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_benchmark_results (benchmark_id, factory_id, metric, value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(crypto.randomUUID(), factoryId, metric, value, now).run();
  }

  async insertSelfImprovement(input: { factoryId: string; title: string; workOrderId?: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_self_improvement_tasks (task_id, factory_id, work_order_id, title, status, created_at) VALUES (?1, ?2, ?3, ?4, 'open', ?5)").bind(crypto.randomUUID(), input.factoryId, input.workOrderId ?? null, input.title, input.now).run();
  }

  async getRunByWorkOrder(workOrderId: string): Promise<Record<string, string> | null> {
    return this.database.prepare("SELECT run_id, work_order_id, factory_id, definition_digest, status, started_at, completed_at, updated_at FROM tinkerbot_factory_runs WHERE work_order_id = ?1 ORDER BY started_at DESC").bind(workOrderId).first<Record<string, string>>();
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

  async patchWorkOrder(workOrderId: string, patch: Partial<Pick<WorkOrder, "productId" | "lineId" | "cellId" | "owner" | "risk" | "autonomyMode" | "outputKind" | "heldBy" | "intent" | "acceptanceCriteria" | "verificationVerdict" | "reviewAssessment" | "releaseDecision">> & { now: string }): Promise<void> {
    const current = await this.getWorkOrder(workOrderId);
    if (!current) return;
    await this.database.prepare("UPDATE tinkerbot_work_orders SET product_id = ?1, line_id = ?2, cell_id = ?3, owner = ?4, risk = ?5, autonomy_mode = ?6, output_kind = ?7, held_by = ?8, intent = ?9, acceptance_criteria = ?10, updated_at = ?11, verification_verdict = ?12, review_assessment = ?13, release_decision = ?14 WHERE work_order_id = ?15").bind(patch.productId ?? current.productId ?? null, patch.lineId ?? current.lineId ?? null, patch.cellId ?? current.cellId ?? null, patch.owner ?? current.owner ?? null, patch.risk ?? current.risk ?? null, patch.autonomyMode ?? current.autonomyMode ?? null, patch.outputKind ?? current.outputKind ?? null, patch.heldBy === undefined ? current.heldBy ?? null : patch.heldBy, patch.intent ?? current.intent ?? null, patch.acceptanceCriteria ?? current.acceptanceCriteria ?? null, patch.now, patch.verificationVerdict ?? current.verificationVerdict ?? "UNKNOWN", patch.reviewAssessment ?? current.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", patch.releaseDecision ?? current.releaseDecision ?? "BLOCKED", workOrderId).run();
  }

  async upsertWorkCell(cell: { cellId: string; factoryId: string; workOrderId?: string; kind: string; repository: string; branch: string; status: string; leasedBy?: string; heldBy?: string; credentialScope: string; cleanupAt: string; now: string; productionAccess?: string; observability?: string; allowedTools?: string[] }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_work_cells (cell_id, factory_id, work_order_id, kind, repository, branch, status, leased_by, held_by, credential_scope, cleanup_at, created_at, updated_at, production_access, observability, allowed_tools_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15) ON CONFLICT(cell_id) DO UPDATE SET work_order_id = excluded.work_order_id, status = excluded.status, leased_by = excluded.leased_by, held_by = excluded.held_by, cleanup_at = excluded.cleanup_at, updated_at = excluded.updated_at, production_access = excluded.production_access, observability = excluded.observability, allowed_tools_json = excluded.allowed_tools_json").bind(cell.cellId, cell.factoryId, cell.workOrderId ?? null, cell.kind, cell.repository, cell.branch, cell.status, cell.leasedBy ?? null, cell.heldBy ?? null, cell.credentialScope, cell.cleanupAt, cell.now, cell.productionAccess ?? "denied", cell.observability ?? "read-only", JSON.stringify(cell.allowedTools ?? [])).run();
  }

  async listWorkCells(factoryId?: string): Promise<Array<Record<string, string | null>>> {
    const statement = this.database.prepare("SELECT cell_id, factory_id, work_order_id, kind, repository, branch, status, leased_by, held_by, credential_scope, cleanup_at, created_at FROM tinkerbot_work_cells WHERE (?1 = '' OR factory_id = ?1) ORDER BY created_at DESC").bind(factoryId ?? "");
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string | null>>();
    return result.results ?? [];
  }

  async listExpiredCells(now: string): Promise<Array<Record<string, string | null>>> {
    const statement = this.database.prepare("SELECT cell_id, factory_id, work_order_id, kind, repository, branch, status, leased_by, held_by, credential_scope, cleanup_at, created_at FROM tinkerbot_work_cells WHERE cleanup_at <= ?1 AND status IN ('leased', 'held')").bind(now);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string | null>>();
    return result.results ?? [];
  }

  async listProducts(organizationId: string): Promise<Array<Record<string, string | null>>> {
    const statement = this.database.prepare("SELECT product_id, organization_id, factory_id, name, risk_class, updated_at FROM tinkerbot_products WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string | null>>();
    return result.results ?? [];
  }

  async upsertProduct(input: { productId: string; organizationId: string; factoryId?: string; name: string; riskClass?: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_products (product_id, organization_id, factory_id, name, risk_class, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(product_id) DO UPDATE SET name = excluded.name, factory_id = excluded.factory_id, risk_class = excluded.risk_class, updated_at = excluded.updated_at").bind(input.productId, input.organizationId, input.factoryId ?? null, input.name, input.riskClass ?? "medium", input.now).run();
  }

  async listSkills(factoryId: string): Promise<Array<Record<string, string | null>>> {
    const statement = this.database.prepare("SELECT s.skill_id, s.factory_id, s.name, s.purpose, s.owner, v.version, v.rollout FROM tinkerbot_skills s LEFT JOIN tinkerbot_skill_versions v ON v.skill_id = s.skill_id WHERE s.factory_id = ?1 ORDER BY s.updated_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, string | null>>();
    return result.results ?? [];
  }

  async upsertSkill(input: { skillId: string; factoryId: string; name: string; purpose: string; owner: string; version: string; yaml: string; rollout: string; allowedTools: string[]; permissions: string[]; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_skills (skill_id, factory_id, name, purpose, owner, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(skill_id) DO UPDATE SET name = excluded.name, purpose = excluded.purpose, owner = excluded.owner, updated_at = excluded.updated_at").bind(input.skillId, input.factoryId, input.name, input.purpose, input.owner, input.now).run();
    await this.database.prepare("INSERT INTO tinkerbot_skill_versions (version_id, skill_id, version, yaml, rollout, allowed_tools_json, permission_scope_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(skill_id, version) DO UPDATE SET yaml = excluded.yaml, rollout = excluded.rollout").bind(crypto.randomUUID(), input.skillId, input.version, input.yaml, input.rollout, JSON.stringify(input.allowedTools), JSON.stringify(input.permissions), input.now).run();
  }

  async listProposals(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT proposal_id, factory_id, title, evidence_json, proposed_changes_json, expected_effect, kind, status, benchmark_json, human_approved, steward_actor, auto_merge, created_at FROM tinkerbot_improvement_proposals WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return result.results ?? [];
  }

  async insertProposal(input: { proposalId: string; factoryId: string; title: string; evidence: string[]; proposedChanges: string[]; expectedEffect: string; kind: string; stewardActor?: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_improvement_proposals (proposal_id, factory_id, title, evidence_json, proposed_changes_json, expected_effect, kind, status, benchmark_json, human_approved, steward_actor, auto_merge, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', '[]', 0, ?8, 0, ?9, ?9)").bind(input.proposalId, input.factoryId, input.title, JSON.stringify(input.evidence), JSON.stringify(input.proposedChanges), input.expectedEffect, input.kind, input.stewardActor ?? null, input.now).run();
  }

  async approveProposal(proposalId: string, actor: string, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = await this.database.prepare("SELECT proposal_id, steward_actor, auto_merge, status FROM tinkerbot_improvement_proposals WHERE proposal_id = ?1").bind(proposalId).first<{ proposal_id: string; steward_actor?: string | null; auto_merge: number; status: string }>();
    if (!row) return { ok: false, reason: "not_found" };
    if (row.auto_merge) return { ok: false, reason: "auto_merge_forbidden" };
    if (row.steward_actor && row.steward_actor === actor) return { ok: false, reason: "steward_cannot_self_approve" };
    await this.database.prepare("UPDATE tinkerbot_improvement_proposals SET human_approved = 1, status = 'approved', updated_at = ?1 WHERE proposal_id = ?2").bind(now, proposalId).run();
    await this.database.prepare("INSERT INTO tinkerbot_human_decisions (decision_id, subject_id, actor, role, decision, reason, created_at) VALUES (?1, ?2, ?3, 'release-approver', 'approved', 'Activate factory improvement', ?4)").bind(crypto.randomUUID(), proposalId, actor, now).run();
    return { ok: true };
  }

  async insertReleaseCandidate(input: { releaseId: string; workOrderId: string; factoryId: string; commitSha: string; receiptIds: string[]; rollbackRefs: string[]; status: string; blocking: string[]; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_release_candidates (release_id, work_order_id, factory_id, commit_sha, receipt_ids_json, rollback_refs_json, status, blocking_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)").bind(input.releaseId, input.workOrderId, input.factoryId, input.commitSha, JSON.stringify(input.receiptIds), JSON.stringify(input.rollbackRefs), input.status, JSON.stringify(input.blocking), input.now).run();
  }

  async listReleaseCandidates(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT release_id, work_order_id, commit_sha, status, blocking_json, created_at FROM tinkerbot_release_candidates WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return result.results ?? [];
  }

  async insertDeployment(input: { deploymentId: string; releaseId: string; environment: string; status: string; workflow?: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_deployments (deployment_id, release_id, environment, status, workflow, executed_on_customer_cluster, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)").bind(input.deploymentId, input.releaseId, input.environment, input.status, input.workflow ?? null, input.now).run();
  }

  async insertOutcome(input: { outcomeId: string; workOrderId?: string; releaseId?: string; kind: string; association: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_outcomes (outcome_id, work_order_id, release_id, kind, association, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(input.outcomeId, input.workOrderId ?? null, input.releaseId ?? null, input.kind, input.association, input.now).run();
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
    await this.database.prepare("INSERT INTO tinkerbot_execution_plans (plan_id, work_order_id, run_id, origin, profile_json, plan_json, selected_pipeline, escalation_reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(plan_id) DO UPDATE SET plan_json = excluded.plan_json, escalation_reason = excluded.escalation_reason").bind(plan.planId, plan.workOrderId ?? null, null, plan.origin, JSON.stringify(plan.profile), JSON.stringify(plan), plan.selectedPipeline, plan.escalationReason ?? null, plan.createdAt).run();
  }

  async putCostEstimate(planId: string, estimate: import("../../../packages/factory/src/runtime").CostEstimate): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_cost_estimates (plan_id, catalog_version, estimate_json, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(plan_id) DO UPDATE SET estimate_json = excluded.estimate_json").bind(planId, estimate.catalogVersion, JSON.stringify(estimate), new Date().toISOString()).run();
  }

  async putCostActual(input: { planId: string; runId: string; usage: import("../../../packages/factory/src/runtime").ProviderUsage; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_cost_actuals (actual_id, plan_id, run_id, stage, provider, model, input_tokens, output_tokens, cached_tokens, retries, latency_ms, managed, catalog_version, runner_origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)").bind(crypto.randomUUID(), input.planId, input.runId, input.usage.stage ?? null, input.usage.provider, input.usage.model, input.usage.inputTokens, input.usage.outputTokens, input.usage.cachedTokens, input.usage.retries, input.usage.latencyMs, input.usage.managed ? 1 : 0, input.usage.catalogVersion, input.usage.runnerOrigin, input.now).run();
  }

  async ingestLocalRuntimePayload(input: { organizationId: string; kind: string; payload: Record<string, unknown>; now: string }): Promise<{ accepted: true; organizationId: string; kind: string }> {
    const kind = input.kind;
    const payload = input.payload;
    if (kind === "factory-graph-event" || payload.event) {
      const event = (payload.event ?? payload) as FactoryEvent;
      if (!event || typeof event !== "object" || typeof event.eventId !== "string" || typeof event.aggregateId !== "string" || event.organizationId !== input.organizationId) throw new Error("invalid_factory_graph_event");
      assertFactoryEventAuthority(event);
      await this.appendFactoryEvent(event);
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
    await this.database.prepare("INSERT INTO tinkerbot_eval_suites (suite_id, name, yaml, baseline_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(suite_id) DO UPDATE SET baseline_digest = excluded.baseline_digest").bind(suite.suiteId, suite.name, JSON.stringify(suite), suite.baselineDigest ?? null, suite.createdAt).run();
  }

  async insertEvalAttempt(attempt: import("../../../packages/factory/src/evals").EvalAttempt): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_eval_attempts (attempt_id, suite_id, task_id, output, metrics_json, passed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(attempt.attemptId, attempt.suiteId, attempt.taskId, attempt.output, JSON.stringify(attempt.metrics), attempt.passed ? 1 : 0, attempt.createdAt).run();
  }

  async listOutcomes(organizationId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT o.outcome_id, o.work_order_id, o.release_id, o.kind, o.association, o.created_at FROM tinkerbot_outcomes o JOIN tinkerbot_work_orders w ON w.work_order_id = o.work_order_id WHERE w.organization_id = ?1 ORDER BY o.created_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return result.results ?? [];
  }

  async appendFactoryEvent(event: FactoryEvent): Promise<void> {
    assertFactoryEventAuthority(event);
    await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version, policy_version, provenance, external_references_json, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)").bind(
      event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.schemaVersion, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
    ).run();
  }

  async listFactoryEvents(aggregateId: string, organizationId: string): Promise<FactoryEvent[]> {
    const statement = this.database.prepare("SELECT * FROM tinkerbot_factory_graph_events WHERE aggregate_id = ?1 AND organization_id = ?2 ORDER BY occurred_at, event_id").bind(aggregateId, organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ eventId: String(row.event_id), aggregateId: String(row.aggregate_id), aggregateType: String(row.aggregate_type), organizationId: String(row.organization_id), factoryId: String(row.factory_id), type: String(row.event_type) as FactoryEvent["type"], actorId: String(row.actor_id), actorType: String(row.actor_type) as FactoryEvent["actorType"], occurredAt: String(row.occurred_at), correlationId: String(row.correlation_id), causationId: row.causation_id ? String(row.causation_id) : undefined, schemaVersion: 1, policyVersion: row.policy_version ? String(row.policy_version) : undefined, provenance: String(row.provenance) as FactoryEvent["provenance"], externalReferences: row.external_references_json ? JSON.parse(String(row.external_references_json)) : undefined, payload: JSON.parse(String(row.payload_json)) }));
  }

  async reconstructFactoryGraph(aggregateId: string, organizationId: string): Promise<FactoryProjection> {
    return projectFactoryEvents(await this.listFactoryEvents(aggregateId, organizationId));
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
