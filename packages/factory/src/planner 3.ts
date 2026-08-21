import crypto from "node:crypto";
import { autonomyAllowsSkip, resolveAutonomy, routeProductionLine, type AutonomyMode, type ProductionLineId } from "./os";
import { estimateCost, type ExecutionPlan, type PipelineMode, type RuntimeProfile, type Uncertainty } from "./runtime";
import { planForemanActions, type FactoryIntakeSource, type ForemanDecision } from "./warp";
type FactoryStageId = "foreman" | "triage" | "specification" | "architecture" | "implementation" | "review" | "verification" | "release" | "test" | "security" | "outcome";

export interface DiffProfile {
  paths: string[];
  changedFileCount: number;
  changedLines: number;
}

export interface PlannerInput {
  sourceType: FactoryIntakeSource;
  untrustedText?: string;
  specApproved?: boolean;
  sandboxComplete?: boolean;
  pullRequestSha?: string;
  verificationIngested?: boolean;
  verificationVerdict?: string;
  reviewRequestsRevision?: boolean;
  paths?: string[];
  diffs?: DiffProfile;
  impactUnknown?: boolean;
  testIntegrityUnknown?: boolean;
  priorFailures?: number;
  autonomyMode?: AutonomyMode;
  lineId?: ProductionLineId;
  autonomyPolicy?: import("./os").AutonomyPolicy;
  profile: RuntimeProfile;
  workOrderId?: string;
  now?: string;
}

const NEVER_SKIP: FactoryStageId[] = ["verification", "release"];

export function diffScale(diffs?: DiffProfile): "small" | "medium" | "large" {
  const files = diffs?.changedFileCount ?? 0;
  const lines = diffs?.changedLines ?? 0;
  if (files >= 12 || lines >= 400) return "large";
  if (files >= 4 || lines >= 80) return "medium";
  return "small";
}

export function shouldEscalateToMultiAgent(input: PlannerInput, autonomyMode: AutonomyMode, lineId: ProductionLineId): { escalate: boolean; reason?: string } {
  if (autonomyMode === "restricted") return { escalate: true, reason: "restricted_paths" };
  if (lineId === "security" || lineId === "release" || lineId === "incident") return { escalate: true, reason: "release_or_security" };
  if (diffScale(input.diffs) === "large") return { escalate: true, reason: "large_or_ambiguous_diff" };
  if (input.impactUnknown || input.testIntegrityUnknown) return { escalate: true, reason: "unknown_impact" };
  if ((input.priorFailures ?? 0) >= 2) return { escalate: true, reason: "repeated_corrections" };
  if (/\b(contract|api|schema)\b/i.test(input.untrustedText ?? "")) return { escalate: true, reason: "contract_change" };
  if (input.verificationVerdict === "FAIL") return { escalate: true, reason: "failed_tests" };
  return { escalate: false };
}

export function selectPipeline(profile: RuntimeProfile, escalate: boolean): PipelineMode {
  if (profile.pipeline === "multi_agent") return "multi_agent";
  if (profile.pipeline === "single_agent") return escalate ? "multi_agent" : "single_agent";
  return escalate ? "multi_agent" : "single_agent";
}

export function buildExecutionPlan(input: PlannerInput): { plan: ExecutionPlan; decision: ForemanDecision; autonomyMode: AutonomyMode; lineId: ProductionLineId } {
  const routed = routeProductionLine({ sourceType: input.sourceType, text: input.untrustedText, paths: input.paths ?? input.diffs?.paths });
  const lineId = input.lineId ?? routed.lineId;
  const autonomyMode = input.autonomyMode ?? resolveAutonomy({ lineId, paths: input.paths ?? input.diffs?.paths, text: input.untrustedText, policy: input.autonomyPolicy });
  const scale = diffScale(input.diffs);
  const localized = /\b(typo|nits?|docs?|readme|changelog)\b/i.test(input.untrustedText ?? "") && scale === "small" && !input.impactUnknown;
  const historyUnknown: Uncertainty = input.priorFailures == null ? "unknown" : "known";
  const decision = planForemanActions({
    sourceType: input.sourceType,
    untrustedText: input.untrustedText,
    specApproved: input.specApproved,
    sandboxComplete: input.sandboxComplete,
    pullRequestSha: input.pullRequestSha,
    verificationIngested: input.verificationIngested,
    verificationVerdict: input.verificationVerdict,
    reviewRequestsRevision: input.reviewRequestsRevision,
    forceSkipSpec: localized && autonomyAllowsSkip(autonomyMode, "specification") && scale === "small",
    forbidSkip: autonomyMode === "restricted" || input.impactUnknown || input.testIntegrityUnknown || historyUnknown === "unknown" && scale !== "small",
  });
  const skip = decision.skip.filter((stage) => !NEVER_SKIP.includes(stage) && autonomyAllowsSkip(autonomyMode, stage));
  const allStages: FactoryStageId[] = ["foreman", "triage", "specification", "architecture", "implementation", "review", "security", "verification", "release"];
  const stages = allStages.map((id) => ({
    id,
    include: id === "verification" || id === "foreman" || !skip.includes(id),
    reason: skip.includes(id) ? (decision.actions.find((action) => action.stage === id)?.reason ?? "Skipped by planner; policy confirmed.") : id === "verification" ? "Verification is never skipped." : "Included by planner.",
  }));
  const plannedIds = stages.filter((stage) => stage.include).map((stage) => stage.id);
  const escalation = shouldEscalateToMultiAgent(input, autonomyMode, lineId);
  const selectedPipeline = selectPipeline(input.profile, escalation.escalate);
  const cost = estimateCost({ profile: input.profile, plannedStages: plannedIds, changedLines: input.diffs?.changedLines });
  const now = input.now ?? new Date().toISOString();
  return {
    plan: {
      planId: crypto.randomUUID(),
      workOrderId: input.workOrderId,
      origin: input.profile.controlPlane === "local" ? "local" : "hosted",
      profile: input.profile,
      selectedPipeline,
      stages,
      skip,
      model: input.profile.inference.model,
      provider: input.profile.inference.provider,
      runner: input.profile.runner,
      estimatedDurationSeconds: cost.estimatedDurationSeconds,
      cost,
      escalationEligible: escalation.escalate,
      escalated: selectedPipeline === "multi_agent" && input.profile.pipeline !== "multi_agent",
      escalationReason: escalation.reason,
      createdAt: now,
    },
    decision: { ...decision, skip },
    autonomyMode,
    lineId,
  };
}
