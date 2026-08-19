import { parse as parseYaml } from "yaml";

export type FactoryOsStageId = "foreman" | "triage" | "specification" | "architecture" | "implementation" | "review" | "verification" | "release" | "test" | "security" | "outcome";
export type FactoryOsSourceType =
  | "github_issue"
  | "github_pull_request"
  | "manual"
  | "mcp"
  | "slack"
  | "linear"
  | "jira"
  | "github_dependabot"
  | "github_code_scanning"
  | "github_secret_scanning"
  | "incident"
  | "support"
  | "roadmap"
  | "scheduled"
  | "gitlab_issue"
  | "gitlab_merge_request";
export type FactoryOsWorkOrderState =
  | "intake"
  | "triage"
  | "specification"
  | "implementation"
  | "review"
  | "verification"
  | "approval"
  | "ready"
  | "merged"
  | "released"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unknown";

export interface FactoryOsDefinition {
  product?: FactoryProductDefinition;
  lines?: ProductionLineDefinition[];
  autonomy?: AutonomyPolicy;
}

export interface RoutableWorkOrder {
  sourceType: FactoryOsSourceType;
  repositoryId: string;
  intent?: string;
  issueOrPullRequest?: string;
  productId?: string;
  lineId?: ProductionLineId;
  risk?: RiskLevel;
  autonomyMode?: AutonomyMode;
  outputKind?: OutputKind;
  status: FactoryOsWorkOrderState;
}

export const PRODUCTION_LINES = ["feature", "bugfix", "security", "dependency", "incident", "refactor", "migration", "release", "maintenance"] as const;
export type ProductionLineId = (typeof PRODUCTION_LINES)[number];

export const AUTONOMY_MODES = ["advisory", "assisted", "approval_gated", "policy_autonomous", "restricted"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const OUTPUT_KINDS = ["pr", "issue", "spec", "test_plan", "release_candidate", "deployment", "rollback", "maintenance"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const CELL_KINDS = ["github_branch", "github_actions", "sandbox", "preview", "customer_runner"] as const;
export type WorkCellKind = (typeof CELL_KINDS)[number];

export const SKILL_ROLLOUT = ["draft", "evaluate", "review", "canary", "active", "deprecated"] as const;
export type SkillRollout = (typeof SKILL_ROLLOUT)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const OS_INTAKE_SOURCES = [
  "github_issue",
  "github_pull_request",
  "manual",
  "mcp",
  "slack",
  "linear",
  "jira",
  "github_dependabot",
  "github_code_scanning",
  "github_secret_scanning",
  "incident",
  "support",
  "roadmap",
  "scheduled",
  "gitlab_issue",
  "gitlab_merge_request",
] as const satisfies readonly FactoryOsSourceType[];

export const SPECIALIST_SKILLS = [
  "foreman",
  "product-analyst",
  "architect",
  "specification",
  "implementer",
  "test",
  "reviewer",
  "security",
  "verification",
  "release",
  "maintenance",
  "factory-analyst",
  "skill-builder",
  "evaluator",
  "factory-reviewer",
  "release-steward",
] as const;

export const ASSURANCE_CHECKPOINTS = ["intent", "specification", "architecture", "implementation", "test", "impact", "security", "release", "outcome"] as const;
export type AssuranceCheckpoint = (typeof ASSURANCE_CHECKPOINTS)[number];

export const LINE_STAGES: Record<ProductionLineId, FactoryOsStageId[]> = {
  feature: ["foreman", "triage", "specification", "architecture", "implementation", "review", "verification", "release"],
  bugfix: ["foreman", "triage", "implementation", "review", "verification", "release"],
  security: ["foreman", "triage", "specification", "security", "implementation", "review", "verification", "release"],
  dependency: ["foreman", "triage", "implementation", "review", "verification", "release"],
  incident: ["foreman", "triage", "implementation", "verification", "release"],
  refactor: ["foreman", "triage", "specification", "architecture", "implementation", "review", "verification", "release"],
  migration: ["foreman", "triage", "specification", "architecture", "implementation", "review", "verification", "release"],
  release: ["foreman", "triage", "verification", "release"],
  maintenance: ["foreman", "triage", "implementation", "verification", "release"],
};

export const LINE_OUTPUT: Record<ProductionLineId, OutputKind> = {
  feature: "pr",
  bugfix: "pr",
  security: "pr",
  dependency: "pr",
  incident: "pr",
  refactor: "pr",
  migration: "pr",
  release: "release_candidate",
  maintenance: "maintenance",
};

export const LINE_DEFAULT_AUTONOMY: Record<ProductionLineId, AutonomyMode> = {
  feature: "approval_gated",
  bugfix: "approval_gated",
  security: "restricted",
  dependency: "assisted",
  incident: "restricted",
  refactor: "approval_gated",
  migration: "restricted",
  release: "restricted",
  maintenance: "assisted",
};

const RESTRICTED_PATH = /(^|\/)(auth|authentication|billing|payment|permissions?|iam|secret|crypto)(\/|\.|$)/i;
const DOCS_PATH = /(^|\/)(docs?|readme|changelog|license|\.md$)(\/|\.|$)/i;
const FORMAT_TEXT = /\b(format|prettier|eslint --fix|whitespace|typo|nits?|docs?|readme|changelog)\b/i;

export interface FactoryProductDefinition {
  portfolio?: string;
  name: string;
  owners: string[];
  environments: string[];
  riskClass: RiskLevel;
  customerFacing: boolean;
  services: Array<{ id: string; repository: string; path?: string; owners: string[]; apis?: string[]; constraints?: string[]; deprecated?: boolean }>;
}

export interface ProductionLineDefinition {
  id: ProductionLineId;
  stages: FactoryOsStageId[];
  agents: string[];
  autonomy: AutonomyMode;
  requiredEvidence: string[];
  approvalRoles: string[];
}

export interface SkillDefinition {
  id: string;
  purpose: string;
  triggerConditions: string[];
  inputs: string[];
  allowedTools: string[];
  permissionScope: string[];
  model: string;
  harness: string;
  procedure: string;
  outputSchema: string;
  constraints: string[];
  benchmarkSuite: string;
  owner: string;
  version: string;
  rollout: SkillRollout;
}

export interface AutonomyRule {
  match: "path" | "line" | "text";
  pattern: string;
  mode: AutonomyMode;
}

export interface AutonomyPolicy {
  defaultMode: AutonomyMode;
  rules: AutonomyRule[];
  neverMerge: true;
}

export interface EvolutionPolicy {
  schedule: string;
  allowedProposalKinds: string[];
  forbiddenMutations: string[];
  autoMerge: false;
  customerSourceTraining: false;
}

export interface WorkCell {
  cellId: string;
  factoryId: string;
  workOrderId?: string;
  kind: WorkCellKind;
  repository: string;
  branch: string;
  status: "free" | "leased" | "held" | "abandoned";
  leasedBy?: string;
  heldBy?: string;
  credentialScope: string;
  cleanupAt: string;
  createdAt: string;
}

export interface ImprovementProposal {
  proposalId: string;
  factoryId: string;
  title: string;
  evidence: string[];
  proposedChanges: string[];
  expectedEffect: string;
  kind: "skill" | "policy" | "test" | "workflow" | "factory-definition";
  status: "draft" | "evaluate" | "review" | "approved" | "rejected" | "canary" | "active" | "rolled_back";
  benchmarkDelta?: { metric: string; before: number; after: number }[];
  humanApproved: boolean;
  stewardActor?: string;
  opensPullRequest: true;
  autoMerge: boolean;
}

export interface MergeReadiness {
  ready: boolean;
  blocking: string[];
  advisory: string[];
  humanMergeRequired: true;
}

export interface ReleaseCandidate {
  releaseId: string;
  commitSha: string;
  receiptIds: string[];
  rollbackRefs: string[];
  status: "ready" | "blocked" | "unknown";
  blocking: string[];
}

export interface DeploymentRecord {
  deploymentId: string;
  releaseId: string;
  environment: string;
  status: "dispatched" | "succeeded" | "failed" | "rolled_back" | "unknown";
  workflow?: string;
  executedOnCustomerCluster: false;
}

export function isProductionLineId(value: string): value is ProductionLineId {
  return (PRODUCTION_LINES as readonly string[]).includes(value);
}

export function isAutonomyMode(value: string): value is AutonomyMode {
  return (AUTONOMY_MODES as readonly string[]).includes(value);
}

export function isOsIntakeSource(value: string): value is FactoryOsSourceType {
  return (OS_INTAKE_SOURCES as readonly string[]).includes(value);
}

export function routeProductionLine(input: { sourceType: FactoryOsSourceType; text?: string; paths?: string[]; labels?: string[] }): { lineId: ProductionLineId; risk: RiskLevel; outputKind: OutputKind; reason: string } {
  const text = `${input.text ?? ""} ${(input.labels ?? []).join(" ")}`.toLowerCase();
  const paths = input.paths ?? [];
  if (input.sourceType === "github_dependabot" || /dependabot|dependency bump|bump \S+ from/.test(text)) {
    return { lineId: "dependency", risk: "medium", outputKind: "pr", reason: "Dependency intake." };
  }
  if (input.sourceType === "github_code_scanning" || input.sourceType === "github_secret_scanning" || /cve|secret scanning|code scanning|vulnerability/.test(text)) {
    return { lineId: "security", risk: "high", outputKind: "pr", reason: "Security finding." };
  }
  if (input.sourceType === "incident" || /outage|incident|sev[0-3]|pagerduty/.test(text)) {
    return { lineId: "incident", risk: "high", outputKind: /rollback|revert/.test(text) ? "rollback" : "pr", reason: "Incident intake." };
  }
  if (input.sourceType === "scheduled" || input.sourceType === "support" && /decay|stale|maintenance/.test(text)) {
    return { lineId: "maintenance", risk: "low", outputKind: "maintenance", reason: "Scheduled or support maintenance." };
  }
  if (input.sourceType === "roadmap") return { lineId: "feature", risk: "medium", outputKind: "spec", reason: "Roadmap item." };
  if (input.sourceType === "support") return { lineId: "bugfix", risk: "medium", outputKind: "issue", reason: "Support request." };
  if (/rollback|revert production/.test(text)) return { lineId: "incident", risk: "high", outputKind: "rollback", reason: "Rollback requested." };
  if (/release candidate|cut release|promote to prod/.test(text) || paths.some((path) => /deploy|helm|k8s/.test(path))) {
    return { lineId: "release", risk: "high", outputKind: "release_candidate", reason: "Release preparation." };
  }
  if (/migrat(e|ion)|schema change/.test(text)) return { lineId: "migration", risk: "high", outputKind: "pr", reason: "Migration work." };
  if (/refactor|boundary|architecture/.test(text)) return { lineId: "refactor", risk: "medium", outputKind: "pr", reason: "Architecture/refactor work." };
  if (/\bbug\b|\bfix\b|regression|flaky/.test(text)) return { lineId: "bugfix", risk: "medium", outputKind: "pr", reason: "Defect repair." };
  return { lineId: "feature", risk: paths.some((path) => RESTRICTED_PATH.test(path)) ? "high" : "medium", outputKind: "pr", reason: "Feature delivery." };
}

export function resolveAutonomy(input: { lineId: ProductionLineId; paths?: string[]; text?: string; policy?: AutonomyPolicy }): AutonomyMode {
  const paths = input.paths ?? [];
  if (input.lineId === "security" || input.lineId === "release" || input.lineId === "incident" || input.lineId === "migration") return "restricted";
  if (paths.some((path) => RESTRICTED_PATH.test(path)) || /auth|billing|permission/.test(input.text ?? "")) return "restricted";
  if (input.policy?.rules.length) {
    for (const rule of input.policy.rules) {
      const haystack = rule.match === "path" ? paths.join("\n") : rule.match === "line" ? input.lineId : input.text ?? "";
      if (new RegExp(rule.pattern, "i").test(haystack)) return rule.mode;
    }
  }
  if (paths.every((path) => DOCS_PATH.test(path)) && paths.length || FORMAT_TEXT.test(input.text ?? "")) return "policy_autonomous";
  if (input.lineId === "dependency") return "assisted";
  return input.policy?.defaultMode ?? LINE_DEFAULT_AUTONOMY[input.lineId];
}

export function autonomyAllowsSkip(mode: AutonomyMode, stage: FactoryOsStageId): boolean {
  if (stage === "verification" || stage === "release") return false;
  if (mode === "restricted") return false;
  if (mode === "advisory") return stage !== "specification";
  if (mode === "policy_autonomous") return stage === "specification" || stage === "architecture";
  return stage === "architecture";
}

export function stagesForLine(definition: FactoryOsDefinition | undefined, lineId: ProductionLineId): FactoryOsStageId[] {
  const configured = definition?.lines?.find((line) => line.id === lineId)?.stages;
  const stages = configured?.length ? configured : LINE_STAGES[lineId];
  if (!stages.includes("verification")) return [...stages, "verification"];
  return stages;
}

export function foremanMaySelectStage(definition: FactoryOsDefinition | undefined, lineId: ProductionLineId, stage: FactoryOsStageId): boolean {
  return stagesForLine(definition, lineId).includes(stage);
}

export function resolveProduct(definition: FactoryOsDefinition | undefined, repository: string): { product?: FactoryProductDefinition; service?: FactoryProductDefinition["services"][number]; blocked: boolean; action?: string } {
  const product = definition?.product;
  if (!product) return { blocked: false };
  const service = product.services.find((item) => item.repository.toLowerCase() === repository.toLowerCase());
  if (!service) return { product, blocked: true, action: "map repository to product" };
  return { product, service, blocked: false };
}

export function acquireWorkCellLease(input: {
  cells: WorkCell[];
  factoryId: string;
  workOrderId: string;
  repository: string;
  branch: string;
  kind?: WorkCellKind;
  actor: string;
  now: string;
  ttlMs?: number;
  concurrencyLimit?: number;
}): { ok: true; cell: WorkCell } | { ok: false; reason: "collision" | "concurrency" } {
  const active = input.cells.filter((cell) => cell.factoryId === input.factoryId && (cell.status === "leased" || cell.status === "held"));
  if (active.length >= (input.concurrencyLimit ?? 8)) return { ok: false, reason: "concurrency" };
  const collision = input.cells.find((cell) => cell.repository === input.repository && cell.branch === input.branch && (cell.status === "leased" || cell.status === "held") && cell.workOrderId !== input.workOrderId);
  if (collision) return { ok: false, reason: "collision" };
  const existing = input.cells.find((cell) => cell.workOrderId === input.workOrderId && cell.repository === input.repository && cell.branch === input.branch);
  const cleanupAt = new Date(Date.parse(input.now) + (input.ttlMs ?? 3_600_000)).toISOString();
  const cell: WorkCell = {
    cellId: existing?.cellId ?? `cell_${input.workOrderId.slice(0, 8)}`,
    factoryId: input.factoryId,
    workOrderId: input.workOrderId,
    kind: input.kind ?? "sandbox",
    repository: input.repository,
    branch: input.branch,
    status: "leased",
    leasedBy: input.actor,
    credentialScope: `repo:${input.repository}:contents:write:tinkerbot/*`,
    cleanupAt,
    createdAt: existing?.createdAt ?? input.now,
  };
  return { ok: true, cell };
}

export function takeWorkCell(cell: WorkCell, actor: string, now: string): WorkCell {
  return { ...cell, status: "held", heldBy: actor, leasedBy: actor, cleanupAt: new Date(Date.parse(now) + 7_200_000).toISOString() };
}

export function returnWorkCell(cell: WorkCell, now: string): WorkCell {
  return { ...cell, status: "leased", heldBy: undefined, leasedBy: "factory-agent", cleanupAt: new Date(Date.parse(now) + 3_600_000).toISOString() };
}

export function releaseExpiredCells(cells: WorkCell[], now: string): WorkCell[] {
  return cells.map((cell) => Date.parse(cell.cleanupAt) <= Date.parse(now) && cell.status !== "free" ? { ...cell, status: "abandoned" as const, leasedBy: undefined, heldBy: undefined } : cell);
}

export function cellCredentialScope(cell: Pick<WorkCell, "repository" | "branch">): { ok: true; scope: string } | { ok: false; reason: string } {
  if (!cell.branch.startsWith("tinkerbot/")) return { ok: false, reason: "Work-cell credentials cannot target protected branches." };
  return { ok: true, scope: `repo:${cell.repository}:contents:write:${cell.branch}` };
}

export function parseSkillDocument(input: unknown): SkillDefinition {
  const source = typeof input === "string" ? parseYaml(input) : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Skill must be a mapping.");
  const raw = source as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : typeof raw.purpose === "string" ? raw.purpose.toLowerCase().replace(/\s+/g, "-") : "";
  if (!id) throw new Error("Skill requires an id.");
  const rollout = SKILL_ROLLOUT.includes(raw.rollout as SkillRollout) ? raw.rollout as SkillRollout : "draft";
  const asList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
  return {
    id,
    purpose: typeof raw.purpose === "string" ? raw.purpose : id,
    triggerConditions: asList(raw.triggerConditions ?? raw.triggers),
    inputs: asList(raw.inputs),
    allowedTools: asList(raw.allowedTools ?? raw.tools),
    permissionScope: asList(raw.permissionScope ?? raw.permissions),
    model: typeof raw.model === "string" ? raw.model : "@cf/openai/gpt-oss-120b",
    harness: typeof raw.harness === "string" ? raw.harness : "default",
    procedure: typeof raw.procedure === "string" ? raw.procedure : "",
    outputSchema: typeof raw.outputSchema === "string" ? raw.outputSchema : "agent-receipt",
    constraints: asList(raw.constraints),
    benchmarkSuite: typeof raw.benchmarkSuite === "string" ? raw.benchmarkSuite : "factory-golden",
    owner: typeof raw.owner === "string" ? raw.owner : "factory",
    version: typeof raw.version === "string" ? raw.version : "0.1.0",
    rollout,
  };
}

export function evaluateSkillProposal(input: {
  candidate: SkillDefinition;
  active?: SkillDefinition;
  goldenVerdicts?: Array<{ id: string; before: string; after: string }>;
  currentPermissions?: string[];
}): { passed: boolean; blocking: string[]; upgradesVerdict: false } {
  const blocking: string[] = [];
  if (input.candidate.rollout === "active" && !input.active) blocking.push("A skill cannot skip review into active.");
  if ((input.candidate.allowedTools.length > (input.active?.allowedTools.length ?? 0)) && input.candidate.allowedTools.some((tool) => !(input.active?.allowedTools ?? input.currentPermissions ?? []).includes(tool) && !["skip_stage", "ask_human", "dispatch_verify"].includes(tool))) {
    blocking.push("Skill builder cannot grant new tools or credentials.");
  }
  if (input.candidate.permissionScope.some((scope) => /admin|merge|delete-evidence|verdict/.test(scope))) blocking.push("Skills cannot request merge, evidence rewrite, or verdict authority.");
  for (const verdict of input.goldenVerdicts ?? []) {
    if (verdict.before !== verdict.after) blocking.push(`Proposal would change tb check verdict on ${verdict.id}.`);
  }
  if (/lower severity|suppress finding|rewrite evidence|auto-?merge/i.test(`${input.candidate.purpose} ${input.candidate.procedure}`)) {
    blocking.push("Proposal attempts to lower verification standards.");
  }
  return { passed: blocking.length === 0, blocking, upgradesVerdict: false };
}

export function activateSkill(input: { candidate: SkillDefinition; humanApproved: boolean; stewardActor?: string; approver?: string }): { ok: true; skill: SkillDefinition; autoMerge: false } | { ok: false; reason: string } {
  if (!input.humanApproved || !input.approver) return { ok: false, reason: "Human approval is required to activate a skill." };
  if (input.stewardActor && input.approver === input.stewardActor) return { ok: false, reason: "Release Steward cannot approve its own activation." };
  if (input.candidate.rollout !== "review" && input.candidate.rollout !== "canary" && input.candidate.rollout !== "evaluate") {
    return { ok: false, reason: "Only evaluated skills may be activated." };
  }
  return { ok: true, skill: { ...input.candidate, rollout: "active" }, autoMerge: false };
}

export function factoryAnalystReport(input: { failures: Array<{ stage: string; reason: string }>; rework: number; costCents: number }): { readOnly: true; patterns: string[]; mayMutate: false } {
  const counts = new Map<string, number>();
  for (const failure of input.failures) counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);
  const patterns = [...counts.entries()].filter(([, count]) => count >= 2).map(([reason, count]) => `${count}× ${reason}`);
  if (input.rework >= 3) patterns.push("Repeated human corrections.");
  if (input.costCents > 50_000) patterns.push("Excessive model cost.");
  return { readOnly: true, patterns, mayMutate: false };
}

export function draftImprovementProposal(input: { factoryId: string; patterns: string[]; kind?: ImprovementProposal["kind"] }): ImprovementProposal {
  return {
    proposalId: `prop_${input.factoryId.slice(0, 8)}`,
    factoryId: input.factoryId,
    title: input.patterns[0] ? `Improve factory: ${input.patterns[0]}` : "Factory improvement proposal",
    evidence: input.patterns,
    proposedChanges: ["add specification checklist", "add reviewer skill", "keep tb check verdicts unchanged"],
    expectedEffect: "Fewer incomplete changes without lowering verification standards.",
    kind: input.kind ?? "skill",
    status: "draft",
    humanApproved: false,
    opensPullRequest: true,
    autoMerge: false,
  };
}

export function stewardSelfMergeRejected(proposal: ImprovementProposal, actor: string): boolean {
  return proposal.autoMerge === true || (proposal.stewardActor !== undefined && proposal.stewardActor === actor && proposal.humanApproved !== true);
}

export function evaluateMergeReadiness(input: { verdict?: string; approvals: number; requiredApprovals?: number; evidenceFresh?: boolean; unknowns?: string[]; restricted?: boolean }): MergeReadiness {
  const blocking: string[] = [];
  if (input.verdict !== "PASS") blocking.push("tb check has not passed.");
  if ((input.unknowns ?? []).length) blocking.push("Blocking UNKNOWN evidence remains.");
  if (input.evidenceFresh === false) blocking.push("Evidence is stale.");
  if ((input.approvals ?? 0) < (input.requiredApprovals ?? 1) || input.restricted) blocking.push("Required human approval is missing.");
  return { ready: blocking.length === 0, blocking, advisory: blocking.length ? [] : ["Human must click merge."], humanMergeRequired: true };
}

export function createReleaseCandidate(input: { releaseId: string; commitSha: string; receiptIds?: string[]; rollbackRefs?: string[] }): ReleaseCandidate {
  const blocking: string[] = [];
  if (!input.commitSha) blocking.push("Merged SHA is required.");
  if (!(input.receiptIds ?? []).length) blocking.push("Release candidate is blocked without verification receipts.");
  if (!(input.rollbackRefs ?? []).length) blocking.push("Release candidate is blocked without rollback refs.");
  return {
    releaseId: input.releaseId,
    commitSha: input.commitSha,
    receiptIds: input.receiptIds ?? [],
    rollbackRefs: input.rollbackRefs ?? [],
    status: blocking.length ? "blocked" : "ready",
    blocking,
  };
}

export function recordDeployment(input: { releaseId: string; environment: string; workflow?: string }): DeploymentRecord {
  return {
    deploymentId: `deploy_${input.releaseId.slice(0, 8)}`,
    releaseId: input.releaseId,
    environment: input.environment,
    status: "dispatched",
    workflow: input.workflow,
    executedOnCustomerCluster: false,
  };
}

export function createRollbackWorkOrder(order: { repositoryId: string }, releaseId: string): { lineId: "incident"; outputKind: "rollback"; intent: string; autonomyMode: "restricted" } {
  return {
    lineId: "incident",
    outputKind: "rollback",
    intent: `Rollback ${releaseId} for ${order.repositoryId}`,
    autonomyMode: "restricted",
  };
}

export function recordOutcome(input: { kind: "successful_release" | "rollback" | "deployment_failure" | "regression" | "post_merge_ci_failure"; confirmedBy: "ci" | "human" | "incident" }): { kind: string; association: string; authoritativeVerdictUnchanged: true } {
  return { kind: input.kind, association: input.confirmedBy, authoritativeVerdictUnchanged: true };
}

export function runAssuranceCheckpoint(checkpoint: AssuranceCheckpoint, input: {
  intent?: string;
  acceptanceCriteria?: string;
  architectureFit?: boolean;
  specHash?: string;
  implementationSpecHash?: string;
  verdict?: string;
  impacted?: boolean;
  securityChecked?: boolean;
  rollbackRefs?: string[];
  outcomeConfirmed?: boolean;
}): { checkpoint: AssuranceCheckpoint; status: "ok" | "blocked" | "unknown"; summary: string; upgradesVerdict: false } {
  if (checkpoint === "intent") {
    const ok = Boolean(input.intent && input.intent.trim().length > 12);
    return { checkpoint, status: ok ? "ok" : "blocked", summary: ok ? "Request is bounded." : "Intent is ambiguous.", upgradesVerdict: false };
  }
  if (checkpoint === "specification") {
    const ok = Boolean(input.acceptanceCriteria && /given|when|then|must|shall/i.test(input.acceptanceCriteria));
    return { checkpoint, status: ok ? "ok" : "blocked", summary: ok ? "Acceptance criteria are testable." : "Missing testable acceptance criteria.", upgradesVerdict: false };
  }
  if (checkpoint === "architecture") {
    return { checkpoint, status: input.architectureFit === false ? "blocked" : input.architectureFit ? "ok" : "unknown", summary: input.architectureFit ? "Design fits declared boundaries." : "Architecture fit is unknown or violated.", upgradesVerdict: false };
  }
  if (checkpoint === "implementation") {
    const ok = Boolean(input.specHash && input.implementationSpecHash && input.specHash === input.implementationSpecHash);
    return { checkpoint, status: ok ? "ok" : "unknown", summary: ok ? "Change matches approved spec hash." : "Implementation-to-spec correspondence is unknown.", upgradesVerdict: false };
  }
  if (checkpoint === "test" || checkpoint === "impact" || checkpoint === "security") {
    if (input.verdict && input.verdict !== "PASS" && input.verdict !== "FAIL") return { checkpoint, status: "unknown", summary: "tb check has not been ingested.", upgradesVerdict: false };
    if (checkpoint === "impact" && input.impacted === false) return { checkpoint, status: "blocked", summary: "Impacted paths were not evaluated.", upgradesVerdict: false };
    if (checkpoint === "security" && input.securityChecked === false) return { checkpoint, status: "blocked", summary: "Security agent has not run.", upgradesVerdict: false };
    return { checkpoint, status: input.verdict === "FAIL" ? "blocked" : input.verdict === "PASS" ? "ok" : "unknown", summary: `Checkpoint defers to tb check ${input.verdict ?? "UNKNOWN"}.`, upgradesVerdict: false };
  }
  if (checkpoint === "release") {
    const ok = Boolean((input.rollbackRefs ?? []).length && input.verdict === "PASS");
    return { checkpoint, status: ok ? "ok" : "blocked", summary: ok ? "Release evidence is complete." : "Release is not reversible or not evidenced.", upgradesVerdict: false };
  }
  return { checkpoint, status: input.outcomeConfirmed ? "ok" : "unknown", summary: input.outcomeConfirmed ? "Runtime outcome confirmed." : "Post-release outcome is not confirmed.", upgradesVerdict: false };
}

export function controlTowerGroup(order: { status: FactoryOsWorkOrderState; highFindings?: number; unknownEvidence?: boolean; missingProduct?: boolean; leaseCollision?: boolean; awaitingDecision?: boolean }): "needs_attention" | "in_progress" | "waiting_for_approval" | "blocked" | "completed" {
  if (order.missingProduct || order.leaseCollision || order.status === "blocked") return "blocked";
  if (order.status === "failed" || order.status === "unknown" || (order.highFindings ?? 0) > 0 || order.unknownEvidence) return "needs_attention";
  if (order.status === "approval" || order.status === "ready" || order.awaitingDecision) return "waiting_for_approval";
  if (order.status === "merged" || order.status === "released" || order.status === "cancelled") return "completed";
  return "in_progress";
}

export function secondaryTowerLane(order: { status: FactoryOsWorkOrderState; currentStage: string }): "needs_specification" | "architecture_review" | "verification" | "post_release" | "evolution" | undefined {
  if (order.status === "specification" || order.currentStage === "specification") return "needs_specification";
  if (order.currentStage === "architecture") return "architecture_review";
  if (order.status === "verification" || order.currentStage === "verification") return "verification";
  if (order.status === "merged" || order.status === "released") return "post_release";
  return undefined;
}

export function parseProductDocument(input: unknown): FactoryProductDefinition {
  const source = typeof input === "string" ? parseYaml(input) : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("product.yaml must be a mapping.");
  const raw = source as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("product.yaml requires a name.");
  const servicesRaw = Array.isArray(raw.services) ? raw.services : [];
  return {
    portfolio: typeof raw.portfolio === "string" ? raw.portfolio : undefined,
    name,
    owners: Array.isArray(raw.owners) ? raw.owners.filter((item): item is string => typeof item === "string") : [],
    environments: Array.isArray(raw.environments) ? raw.environments.filter((item): item is string => typeof item === "string") : ["preview", "production"],
    riskClass: RISK_LEVELS.includes(raw.riskClass as RiskLevel) ? raw.riskClass as RiskLevel : "medium",
    customerFacing: raw.customerFacing !== false,
    services: servicesRaw.flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const id = typeof record.id === "string" ? record.id : "";
      const repository = typeof record.repository === "string" ? record.repository : "";
      if (!id || !repository) return [];
      return [{
        id,
        repository,
        path: typeof record.path === "string" ? record.path : undefined,
        owners: Array.isArray(record.owners) ? record.owners.filter((owner): owner is string => typeof owner === "string") : [],
        apis: Array.isArray(record.apis) ? record.apis.filter((api): api is string => typeof api === "string") : [],
        constraints: Array.isArray(record.constraints) ? record.constraints.filter((constraint): constraint is string => typeof constraint === "string") : [],
        deprecated: record.deprecated === true,
      }];
    }),
  };
}

export function parseLineDocument(input: unknown): ProductionLineDefinition {
  const source = typeof input === "string" ? parseYaml(input) : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Line definition must be a mapping.");
  const raw = source as Record<string, unknown>;
  const id = isProductionLineId(String(raw.id ?? "")) ? raw.id as ProductionLineId : undefined;
  if (!id) throw new Error("Line id is invalid.");
  const stages = Array.isArray(raw.stages) ? raw.stages.filter((item): item is FactoryOsStageId => typeof item === "string") : LINE_STAGES[id];
  if (!stages.includes("verification")) throw new Error("Every production line requires verification.");
  return {
    id,
    stages,
    agents: Array.isArray(raw.agents) ? raw.agents.filter((item): item is string => typeof item === "string") : [],
    autonomy: isAutonomyMode(String(raw.autonomy ?? "")) ? raw.autonomy as AutonomyMode : LINE_DEFAULT_AUTONOMY[id],
    requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((item): item is string => typeof item === "string") : ["verification-receipt"],
    approvalRoles: Array.isArray(raw.approvalRoles) ? raw.approvalRoles.filter((item): item is string => typeof item === "string") : ["maintainer", "admin", "owner"],
  };
}

export function parseAutonomyDocument(input: unknown): AutonomyPolicy {
  const source = typeof input === "string" ? parseYaml(input) : input;
  const raw = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
  const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
  return {
    defaultMode: isAutonomyMode(String(raw.defaultMode ?? "")) ? raw.defaultMode as AutonomyMode : "approval_gated",
    neverMerge: true,
    rules: rulesRaw.flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (!isAutonomyMode(String(record.mode ?? "")) || typeof record.pattern !== "string") return [];
      return [{ match: record.match === "line" || record.match === "text" ? record.match : "path", pattern: record.pattern, mode: record.mode as AutonomyMode }];
    }),
  };
}

export function parseEvolutionDocument(input: unknown): EvolutionPolicy {
  const source = typeof input === "string" ? parseYaml(input) : input;
  const raw = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
  return {
    schedule: typeof raw.schedule === "string" ? raw.schedule : "0 */6 * * *",
    allowedProposalKinds: Array.isArray(raw.allowedProposalKinds) ? raw.allowedProposalKinds.filter((item): item is string => typeof item === "string") : ["skill", "policy", "test", "workflow"],
    forbiddenMutations: Array.isArray(raw.forbiddenMutations) ? raw.forbiddenMutations.filter((item): item is string => typeof item === "string") : ["verdict-logic", "severity", "evidence-rewrite", "auto-merge"],
    autoMerge: false,
    customerSourceTraining: false,
  };
}

export function defaultProductionLines(): ProductionLineDefinition[] {
  return PRODUCTION_LINES.map((id) => ({
    id,
    stages: LINE_STAGES[id],
    agents: ["foreman", "verification"],
    autonomy: LINE_DEFAULT_AUTONOMY[id],
    requiredEvidence: id === "release" || id === "migration" ? ["verification-receipt", "rollback"] : ["verification-receipt"],
    approvalRoles: ["maintainer", "admin", "owner"],
  }));
}

export function applyWorkOrderRouting<T extends RoutableWorkOrder>(order: T, definition: FactoryOsDefinition | undefined, paths?: string[]): T {
  const routed = routeProductionLine({ sourceType: order.sourceType, text: order.intent ?? order.issueOrPullRequest, paths });
  const autonomyMode = resolveAutonomy({ lineId: routed.lineId, paths, text: order.intent ?? order.issueOrPullRequest, policy: definition?.autonomy });
  const product = resolveProduct(definition, order.repositoryId);
  return {
    ...order,
    productId: product.service?.id ?? order.productId,
    lineId: routed.lineId,
    risk: routed.risk,
    autonomyMode,
    outputKind: routed.outputKind,
    status: product.blocked ? "blocked" : order.status,
  };
}

export function incidentIntake(payload: Record<string, unknown>): { sourceType: "incident"; sourceId: string; title: string; body: string; actor: string } {
  const incident = payload.incident && typeof payload.incident === "object" ? payload.incident as Record<string, unknown> : payload;
  return {
    sourceType: "incident",
    sourceId: typeof incident.id === "string" ? incident.id : typeof incident.incident_number === "number" ? String(incident.incident_number) : cryptoRandom(),
    title: typeof incident.title === "string" ? incident.title : typeof incident.summary === "string" ? incident.summary : "Incident",
    body: typeof incident.description === "string" ? incident.description : JSON.stringify({ event: payload.event, status: incident.status }),
    actor: "incident",
  };
}

export function supportIntake(payload: Record<string, unknown>): { sourceType: "support"; sourceId: string; title: string; body: string; actor: string } {
  return {
    sourceType: "support",
    sourceId: typeof payload.id === "string" ? payload.id : cryptoRandom(),
    title: typeof payload.subject === "string" ? payload.subject : typeof payload.title === "string" ? payload.title : "Support",
    body: typeof payload.body === "string" ? payload.body : typeof payload.description === "string" ? payload.description : "",
    actor: "support",
  };
}

export function scheduledMaintenanceTask(factoryId: string, now: string): { sourceType: "scheduled"; sourceId: string; title: string; body: string; actor: string; lineId: "maintenance" } {
  return {
    sourceType: "scheduled",
    sourceId: `cron:${factoryId}:${now.slice(0, 13)}`,
    title: "Scheduled factory maintenance",
    body: "Cron-triggered maintenance scan for decay, stale evidence, and abandoned work cells.",
    actor: "scheduler",
    lineId: "maintenance",
  };
}

export function githubSecurityIntake(eventName: string, payload: Record<string, unknown>): { sourceType: FactoryOsSourceType; sourceId: string; title: string } | undefined {
  if (eventName === "dependabot_alert") {
    const alert = payload.alert && typeof payload.alert === "object" ? payload.alert as Record<string, unknown> : {};
    return { sourceType: "github_dependabot", sourceId: String(alert.number ?? payload.number ?? "dependabot"), title: "Dependabot alert" };
  }
  if (eventName === "code_scanning_alert") {
    const alert = payload.alert && typeof payload.alert === "object" ? payload.alert as Record<string, unknown> : {};
    return { sourceType: "github_code_scanning", sourceId: String(alert.number ?? "code-scanning"), title: "Code scanning alert" };
  }
  if (eventName === "secret_scanning_alert") {
    const alert = payload.alert && typeof payload.alert === "object" ? payload.alert as Record<string, unknown> : {};
    return { sourceType: "github_secret_scanning", sourceId: String(alert.number ?? "secret-scanning"), title: "Secret scanning alert" };
  }
  return undefined;
}

function cryptoRandom(): string {
  return `src_${Math.random().toString(36).slice(2, 10)}`;
}

export function terminalFromWait(wait: string | undefined, fallback: FactoryOsWorkOrderState): FactoryOsWorkOrderState {
  if (wait === "spec_approval") return "specification";
  if (wait === "sandbox" || wait === "revision") return "implementation";
  if (wait === "oidc_ingest") return "verification";
  if (wait === "human_merge") return fallback;
  return fallback;
}
