import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";

type FactoryLookup = (factoryId: string) => Promise<{ organizationId: string } | null>;

/**
 * Persistence for operator and Factory-operations metadata. These rows are
 * projections/configuration records; lifecycle authority remains in the graph
 * command ledger and Foreman.
 */
export class D1FactoryOperationsStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly getFactory: FactoryLookup,
  ) {}

  async insertScorer(input: { factoryId: string; name: string; criteria: string; now: string }): Promise<string> {
    const scorerId = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_scorers (scorer_id, factory_id, name, criteria, enabled, self_improve, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1, ?5)").bind(scorerId, input.factoryId, input.name, input.criteria, input.now).run();
    return scorerId;
  }

  async listScorers(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT scorer_id, factory_id, name, criteria, enabled, self_improve, updated_at FROM tinkerbot_scorers WHERE factory_id = ?1 ORDER BY updated_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ ...row, upgradesVerdict: false }));
  }

  async insertBenchmark(factoryId: string, metric: string, value: number, now: string): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_benchmark_results (benchmark_id, factory_id, metric, value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(crypto.randomUUID(), factoryId, metric, value, now).run();
  }

  async insertSelfImprovement(input: { factoryId: string; title: string; workOrderId?: string; now: string }): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_self_improvement_tasks (task_id, factory_id, work_order_id, title, status, created_at) VALUES (?1, ?2, ?3, ?4, 'open', ?5)").bind(crypto.randomUUID(), input.factoryId, input.workOrderId ?? null, input.title, input.now).run();
  }

  async listSelfImprovement(factoryId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT task_id, factory_id, work_order_id, title, status, created_at FROM tinkerbot_self_improvement_tasks WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ ...row, autoMerge: false }));
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

  async approveProposal(proposalId: string, actor: string, now: string, organizationId?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = await this.database.prepare("SELECT proposal_id, factory_id, steward_actor, auto_merge, status FROM tinkerbot_improvement_proposals WHERE proposal_id = ?1").bind(proposalId).first<{ proposal_id: string; factory_id: string; steward_actor?: string | null; auto_merge: number; status: string }>();
    if (!row) return { ok: false, reason: "not_found" };
    if (organizationId) {
      const factory = await this.getFactory(row.factory_id);
      if (!factory || factory.organizationId !== organizationId) return { ok: false, reason: "not_found" };
    }
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

  async listOutcomes(organizationId: string): Promise<Array<Record<string, unknown>>> {
    const statement = this.database.prepare("SELECT o.outcome_id, o.work_order_id, o.release_id, o.kind, o.association, o.created_at FROM tinkerbot_outcomes o JOIN tinkerbot_work_orders w ON w.work_order_id = o.work_order_id WHERE w.organization_id = ?1 ORDER BY o.created_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return result.results ?? [];
  }
}
