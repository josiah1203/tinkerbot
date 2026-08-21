import crypto from "node:crypto";
import { autonomyAllowsSkip, type ProductionLineId } from "./os";
import { isExternalHarness } from "./harness";
import { UNKNOWN_CODES, type UnknownCode } from "../../core/src/inspection";

export { UNKNOWN_CODES, type UnknownCode };

export interface FactoryPlanSource {
  name: string;
  version: number;
  agents: Array<{ harness: string }>;
  lines: Array<{ id: string; stages: string[]; autonomy: string }>;
  skills: unknown[];
  autonomy?: unknown;
  evolution: { autoMerge: boolean };
  runtime: { runner: { type: string }; controlPlane?: string };
}

export const VERIFICATION_VERDICTS = ["PASS", "FAIL", "UNKNOWN"] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export const REVIEW_ASSESSMENTS = ["CLEAR", "NEEDS_HUMAN_REVIEW", "REVISE"] as const;
export type ReviewAssessment = (typeof REVIEW_ASSESSMENTS)[number];

export const RELEASE_DECISIONS = ["READY", "BLOCKED"] as const;
export type ReleaseDecision = (typeof RELEASE_DECISIONS)[number];

export const WAIVER_STATUSES = ["NONE", "REQUESTED", "APPROVED", "EXPIRED"] as const;
export type WaiverStatus = (typeof WAIVER_STATUSES)[number];

export const FACT_PROVENANCE = ["verified", "attested", "reported", "inferred", "unknown"] as const;
export type FactProvenance = (typeof FACT_PROVENANCE)[number];

export const TINKER_ACTIONS = [
  "traveler_status",
  "what_is_blocking",
  "attach_line",
  "request_clarification",
  "change_autonomy",
  "skip_stage",
  "apply_waiver",
  "dispatch_restricted_worker",
  "change_factory_config",
  "modify_release_policy",
] as const;
export type TinkerAction = (typeof TINKER_ACTIONS)[number];

export const HIGH_RISK_TINKER_ACTIONS: readonly TinkerAction[] = [
  "change_autonomy",
  "skip_stage",
  "apply_waiver",
  "dispatch_restricted_worker",
  "change_factory_config",
  "modify_release_policy",
];

export interface Waiver {
  status: WaiverStatus;
  findingOrPolicy: string;
  scope: string;
  reason: string;
  approver?: string;
  requestedAt?: string;
  approvedAt?: string;
  expiresAt?: string;
  compensatingControls: string[];
  mayRelease: boolean;
}

export interface AcceptanceCriterionLink {
  criterionId: string;
  text: string;
  implementationSurface?: string;
  verificationEvidenceRef?: string;
  reviewAssessment: ReviewAssessment;
  releaseDecision: ReleaseDecision;
  outcomeRef?: string;
}

export interface FactoryPlan {
  schemaVersion: 1;
  digest: string;
  factoryVersion: string;
  lineVersions: Record<string, string>;
  recipeVersion: string;
  policyVersion: string;
  capabilityVersion: string;
  cellPolicyVersion: string;
  definitionDigest: string;
  compiledAt: string;
  issues: string[];
}

export interface FactoryCommand {
  commandId: string;
  organizationId: string;
  sourceSystem: "github" | "slack" | "jira" | "linear" | "manual";
  sourceObjectId: string;
  actorId: string;
  authorized: boolean;
  idempotencyKey: string;
  workOrderId?: string;
  action: TinkerAction;
  confirmationRequired: boolean;
  eventId?: string;
  receiptId?: string;
  createdAt: string;
}

export interface WorkerEnvelope {
  workOrderId: string;
  cellLeaseId: string;
  workerId: string;
  role: string;
  capabilityToken: string;
  instructionVersion: string;
  allowedTools: string[];
  inputArtifactRefs: string[];
  artifactManifest: string[];
  evidenceRefs: string[];
  escalation?: string;
  cellReturnStatus: "held" | "returned" | "expired";
}

export interface AftercareRecord {
  releaseId: string;
  owner: string;
  environment: string;
  rollbackProcedure: string;
  expectedSignals: string[];
  monitoringPeriod: string;
  knownRisks: string[];
  followUpChecks: string[];
  outcomeStatus: "pending" | "observed" | "incident" | "cleared";
  incidentLinks: string[];
}

export interface FactoryPack {
  id: string;
  version: string;
  lines: string[];
  checkModules: string[];
  forkable: true;
}

export const STARTER_FACTORY_PACKS: FactoryPack[] = [
  { id: "typescript-service", version: "0.1.0", lines: ["feature", "bugfix", "security", "release"], checkModules: ["test-integrity", "change-impact"], forkable: true },
  { id: "python-api", version: "0.1.0", lines: ["feature", "bugfix", "security", "release"], checkModules: ["test-integrity", "api-contracts"], forkable: true },
  { id: "react-application", version: "0.1.0", lines: ["feature", "bugfix", "release"], checkModules: ["test-integrity", "fixture-integrity"], forkable: true },
  { id: "go-service", version: "0.1.0", lines: ["feature", "bugfix", "security", "release"], checkModules: ["test-integrity", "change-impact"], forkable: true },
  { id: "security-remediation", version: "0.1.0", lines: ["security"], checkModules: ["test-integrity"], forkable: true },
  { id: "database-migration", version: "0.1.0", lines: ["migration"], checkModules: ["test-integrity"], forkable: true },
  { id: "monorepo", version: "0.1.0", lines: ["feature", "bugfix", "release"], checkModules: ["test-integrity", "change-impact"], forkable: true },
  { id: "infrastructure-change", version: "0.1.0", lines: ["release", "maintenance"], checkModules: ["test-integrity"], forkable: true },
];

export function emptyWaiver(): Waiver {
  return { status: "NONE", findingOrPolicy: "", scope: "", reason: "", compensatingControls: [], mayRelease: false };
}

export function waiverNeverPassesVerification(waiver: Waiver): true {
  void waiver;
  return true;
}

export function resolveReleaseDecision(input: { verificationVerdict: VerificationVerdict; waiver: Waiver; policyAllowsWaivedRelease: boolean }): ReleaseDecision {
  if (input.verificationVerdict === "FAIL") return "BLOCKED";
  if (input.verificationVerdict === "UNKNOWN") return "BLOCKED";
  if (input.waiver.status === "APPROVED" && input.waiver.mayRelease && input.policyAllowsWaivedRelease) return "READY";
  if (input.waiver.status === "APPROVED" && !input.waiver.mayRelease) return "BLOCKED";
  return input.verificationVerdict === "PASS" ? "READY" : "BLOCKED";
}

export function compileFactoryPlan(definition: FactoryPlanSource, definitionDigest: string, now = new Date().toISOString()): FactoryPlan {
  const issues: string[] = [];
  for (const agent of definition.agents) {
    if (isExternalHarness(agent.harness) && definition.runtime.controlPlane !== "local" && definition.runtime.runner.type !== "self_hosted") {
      issues.push(`Customer harness '${agent.harness}' requires a local or self-hosted execution boundary.`);
    }
  }
  if (definition.evolution.autoMerge) issues.push("Evolution autoMerge would silently change the plant.");
  for (const line of definition.lines) {
    if (!line.stages.includes("verification") && line.id === "release") issues.push(`Line ${line.id} can reach release without verification.`);
    if (line.autonomy === "policy_autonomous" && (line.id === "security" || line.id === "release")) issues.push(`Line ${line.id} has unbounded autonomy.`);
  }
  if (autonomyAllowsSkip("policy_autonomous", "verification")) issues.push("Verification skip is illegal.");
  const lineVersions = Object.fromEntries(definition.lines.map((line) => [line.id, `${line.id}@${definitionDigest.slice(0, 12)}`]));
  const canonical = JSON.stringify({
    name: definition.name,
    digest: definitionDigest,
    lines: definition.lines.map((line) => ({ id: line.id, stages: line.stages, autonomy: line.autonomy })),
    policy: definition.autonomy,
    runner: definition.runtime.runner.type,
  });
  const digest = `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  return {
    schemaVersion: 1,
    digest,
    factoryVersion: String(definition.version),
    lineVersions,
    recipeVersion: definitionDigest.slice(0, 16),
    policyVersion: "autonomy",
    capabilityVersion: String(definition.skills.length),
    cellPolicyVersion: definition.runtime.runner.type,
    definitionDigest,
    compiledAt: now,
    issues,
  };
}

export function factoryPlanSafe(plan: FactoryPlan): boolean {
  return plan.issues.length === 0;
}

export function parseTinkerIntent(text: string): { action: TinkerAction; confirmationRequired: boolean } | undefined {
  const trimmed = text.replace(/^@tinker(?:bot)?\b[:,]?\s*/i, "").trim().toLowerCase();
  if (!trimmed) return { action: "traveler_status", confirmationRequired: false };
  if (/block|waiting|stuck/.test(trimmed)) return { action: "what_is_blocking", confirmationRequired: false };
  if (/status|traveler|where is/.test(trimmed)) return { action: "traveler_status", confirmationRequired: false };
  if (/feature line|bugfix line|attach/.test(trimmed)) return { action: "attach_line", confirmationRequired: false };
  if (/clarif/.test(trimmed)) return { action: "request_clarification", confirmationRequired: false };
  if (/waiver/.test(trimmed)) return { action: "apply_waiver", confirmationRequired: true };
  if (/skip/.test(trimmed)) return { action: "skip_stage", confirmationRequired: true };
  if (/autonomy/.test(trimmed)) return { action: "change_autonomy", confirmationRequired: true };
  if (/release policy/.test(trimmed)) return { action: "modify_release_policy", confirmationRequired: true };
  return { action: "traveler_status", confirmationRequired: false };
}

export function createFactoryCommand(input: Omit<FactoryCommand, "commandId" | "createdAt" | "confirmationRequired"> & { createdAt?: string }): FactoryCommand {
  const confirmationRequired = HIGH_RISK_TINKER_ACTIONS.includes(input.action);
  return {
    ...input,
    commandId: crypto.randomUUID(),
    confirmationRequired,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function authorizeTinkerCommand(command: FactoryCommand): { ok: boolean; reason: string } {
  if (!command.authorized) return { ok: false, reason: "actor_not_authorized" };
  if (command.confirmationRequired) return { ok: false, reason: "confirmation_required" };
  return { ok: true, reason: "allowed" };
}

export function createWorkerEnvelope(input: Omit<WorkerEnvelope, "capabilityToken"> & { capabilityToken?: string }): WorkerEnvelope {
  return {
    ...input,
    capabilityToken: input.capabilityToken ?? `cap:${input.cellLeaseId}:${input.workerId}`,
  };
}

export function sameActorApprovalBlocked(input: {
  actorId: string;
  implementerId?: string;
  cellHolderId?: string;
  lineId?: string;
  autonomyMode?: string;
}): { blocked: boolean; reason?: string } {
  const restricted = input.autonomyMode === "restricted"
    || input.lineId === "security"
    || input.lineId === "release"
    || input.lineId === "incident"
    || input.lineId === "migration";
  if (!restricted) return { blocked: false };
  const producer = input.implementerId ?? input.cellHolderId;
  if (producer && producer === input.actorId) return { blocked: true, reason: "author_cannot_approve" };
  return { blocked: false };
}

export function rejectWorkerVerdict(payload: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if ("verificationVerdict" in payload) return { ok: false, reason: "workers_cannot_submit_verification_verdict" };
  return { ok: true };
}

export function pinWorkOrderPlan<T extends { definitionDigest: string; policyVersion: string; definitionVersion: string }>(order: T, plan: FactoryPlan): T {
  return { ...order, definitionDigest: plan.digest, policyVersion: plan.policyVersion, definitionVersion: plan.factoryVersion };
}

export function defaultAftercare(releaseId: string, owner: string): AftercareRecord {
  return {
    releaseId,
    owner,
    environment: "production",
    rollbackProcedure: "Revert the release candidate and open a rollback work order.",
    expectedSignals: ["ci", "error-rate"],
    monitoringPeriod: "P7D",
    knownRisks: [],
    followUpChecks: ["tb outcome check"],
    outcomeStatus: "pending",
    incidentLinks: [],
  };
}

export function catalogNode(kind: "portfolio" | "product" | "service" | "repository" | "module" | "environment" | "owner" | "risk" | "deployment", id: string, parentId?: string): { kind: string; id: string; parentId?: string } {
  return { kind, id, parentId };
}

export interface ProductionMetrics {
  firstPassYield: number;
  reworkRate: number;
  unknownRate: number;
  cycleTimeSeconds: number;
  queueTimeSeconds: number;
  costPerWorkOrderCents: number;
}

export function productionMetrics(input: { passedFirst: number; total: number; rework: number; unknowns: number; cycle: number; queue: number; costCents: number }): ProductionMetrics {
  const total = Math.max(1, input.total);
  return {
    firstPassYield: input.passedFirst / total,
    reworkRate: input.rework / total,
    unknownRate: input.unknowns / total,
    cycleTimeSeconds: input.cycle,
    queueTimeSeconds: input.queue,
    costPerWorkOrderCents: input.costCents,
  };
}

export function improvementLoopStep(step: "observe" | "propose" | "evaluate" | "review" | "canary" | "activate" | "monitor" | "rollback"): { step: string; silentChangeForbidden: true } {
  return { step, silentChangeForbidden: true };
}

export const STEWARD_LOOP: ReadonlyArray<"observe" | "propose" | "evaluate" | "review" | "canary" | "activate" | "monitor" | "rollback"> = [
  "observe", "propose", "evaluate", "review", "canary", "activate", "monitor", "rollback",
];

export function stewardCannotWriteVerdict(): true {
  return true;
}

export function decayMaintenanceSignals(): string[] {
  return ["stale-dependencies", "secret-expiry", "api-drift", "config-drift", "test-decay", "unowned-service", "stale-waiver", "repeated-incident"];
}

export function ownershipGraph(product: { name: string; portfolio?: string; owners: string[]; environments: string[]; services: Array<{ id: string; repository: string; owners: string[]; apis?: string[] }> }): Array<{ kind: string; id: string; parentId?: string }> {
  const nodes = [
    catalogNode("portfolio", product.portfolio ?? "default"),
    catalogNode("product", product.name, product.portfolio ?? "default"),
    ...product.owners.map((owner) => catalogNode("owner", owner, product.name)),
    ...product.environments.map((environment) => catalogNode("environment", environment, product.name)),
    ...product.services.flatMap((service) => [
      catalogNode("service", service.id, product.name),
      catalogNode("repository", service.repository, service.id),
      ...(service.apis ?? []).map((api) => catalogNode("module", api, service.id)),
    ]),
  ];
  return nodes;
}

export function linkAcceptanceCriterion(criterion: string, surface: string): AcceptanceCriterionLink {
  return {
    criterionId: `ac:${crypto.createHash("sha256").update(criterion).digest("hex").slice(0, 12)}`,
    text: criterion,
    implementationSurface: surface,
    reviewAssessment: "NEEDS_HUMAN_REVIEW",
    releaseDecision: "BLOCKED",
  };
}

export function dispatchTinkerGateway(input: {
  text: string;
  organizationId: string;
  sourceSystem: FactoryCommand["sourceSystem"];
  sourceObjectId: string;
  actorId: string;
  authorized: boolean;
  workOrderId?: string;
}): { command: FactoryCommand; authorization: { ok: boolean; reason: string }; upgradesVerdict: false } {
  const parsed = parseTinkerIntent(input.text) ?? { action: "traveler_status" as const, confirmationRequired: false };
  const command = createFactoryCommand({
    organizationId: input.organizationId,
    sourceSystem: input.sourceSystem,
    sourceObjectId: input.sourceObjectId,
    actorId: input.actorId,
    authorized: input.authorized,
    idempotencyKey: `${input.sourceSystem}:${input.sourceObjectId}:${parsed.action}`,
    workOrderId: input.workOrderId,
    action: parsed.action,
  });
  return { command, authorization: authorizeTinkerCommand(command), upgradesVerdict: false };
}

export function githubTinkerMention(eventName: string, payload: Record<string, unknown>): string | undefined {
  if (eventName !== "issue_comment" && eventName !== "pull_request_review_comment") return undefined;
  const comment = payload.comment && typeof payload.comment === "object" ? payload.comment as Record<string, unknown> : {};
  const body = typeof comment.body === "string" ? comment.body : "";
  return /@tinker(?:bot)?\b/i.test(body) ? body : undefined;
}

export function submitWorkerEvidence(payload: Record<string, unknown>): { ok: true; provenance: "reported" } | { ok: false; reason: string } {
  const rejected = rejectWorkerVerdict(payload);
  if (!rejected.ok) return rejected;
  return { ok: true, provenance: "reported" };
}

export function mapLineId(text: string): ProductionLineId {
  if (/security|cve|secret/.test(text)) return "security";
  if (/incident|outage|sev-/.test(text)) return "incident";
  if (/dependabot|bump /.test(text)) return "dependency";
  if (/migrat/.test(text)) return "migration";
  if (/release/.test(text)) return "release";
  if (/typo|docs|readme/.test(text)) return "bugfix";
  return "feature";
}
