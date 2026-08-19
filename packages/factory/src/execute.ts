import {
  ingestedVerdict,
  planForemanActions,
  reviewRequestsRevision,
  waitForFactoryRun,
  workersAiGatewayOptions,
  type FactoryWait,
} from "./warp";
import { autonomyAllowsSkip, resolveProduct, runAssuranceCheckpoint, type AutonomyMode, type ProductionLineId } from "./os";
import { hostedRuntimeDefaults, type ExecutionPlan } from "./runtime";
import { buildExecutionPlan } from "./planner";
import { mayUseInlineSelfReview } from "./approval";
import type { FactoryStore } from "./store";
import type { InferenceProvider } from "./inference";
import { factoryAiFromProvider } from "./inference";
import type { FactoryAi, FactoryDefinition, FactoryRunStepResult, FactoryStageId, WorkOrder, WorkOrderState } from "./index";

export async function executeFactoryRun(input: {
  definition: FactoryDefinition;
  sourceType: WorkOrder["sourceType"];
  untrustedText?: string;
  ai?: FactoryAi;
  inference?: InferenceProvider;
  verificationVerdict?: string;
  specApproved?: boolean;
  sandboxComplete?: boolean;
  pullRequestSha?: string;
  verificationIngested?: boolean;
  reviewRequestsRevision?: boolean;
  workOrderId?: string;
  factoryId?: string;
  paths?: string[];
  diffs?: { paths: string[]; changedFileCount: number; changedLines: number };
  impactUnknown?: boolean;
  testIntegrityUnknown?: boolean;
  priorFailures?: number;
  store?: Pick<FactoryStore, "putExecutionPlan" | "putCostEstimate" | "putCostActual">;
  actorKind?: "human" | "agent";
}): Promise<{ stages: FactoryRunStepResult[]; terminal: WorkOrderState; wait?: FactoryWait; lineId?: ProductionLineId; autonomyMode?: AutonomyMode; plan?: ExecutionPlan; escalated?: boolean }> {
  const { runForeman, runTriageAgent, runSpecificationAgent, runReviewAgent, verificationAuthority, sanitizeUntrustedPromptInput } = await import("./index");
  const profile = input.definition.runtime ?? hostedRuntimeDefaults(input.definition.runner.type);
  const built = buildExecutionPlan({
    sourceType: input.sourceType,
    untrustedText: input.untrustedText,
    specApproved: input.specApproved,
    sandboxComplete: input.sandboxComplete,
    pullRequestSha: input.pullRequestSha,
    verificationIngested: input.verificationIngested ?? ingestedVerdict(input.verificationVerdict),
    verificationVerdict: input.verificationVerdict,
    reviewRequestsRevision: input.reviewRequestsRevision,
    paths: input.paths ?? input.diffs?.paths,
    diffs: input.diffs,
    impactUnknown: input.impactUnknown,
    testIntegrityUnknown: input.testIntegrityUnknown,
    priorFailures: input.priorFailures,
    autonomyPolicy: input.definition.autonomy,
    profile,
    workOrderId: input.workOrderId,
  });
  const { plan, decision, autonomyMode, lineId } = built;
  if (input.store) {
    await input.store.putExecutionPlan(plan);
    await input.store.putCostEstimate(plan.planId, plan.cost);
  }
  const product = resolveProduct(input.definition, input.definition.repositories[0] ?? "unknown/unknown");
  const skip = plan.skip.filter((stage) => stage !== "verification" && autonomyAllowsSkip(autonomyMode ?? "approval_gated", stage as FactoryStageId));
  const planned = runForeman(input.definition, input.sourceType, skip as FactoryStageId[], lineId);
  if (!planned.length) return { stages: [{ stage: "foreman", status: "skipped", summary: "Source is not enabled for this factory." }], terminal: "cancelled", lineId, autonomyMode, plan };
  if (product.blocked) return { stages: [{ stage: "foreman", status: "blocked", summary: product.action ?? "map repository to product" }], terminal: "blocked", lineId, autonomyMode, plan };
  const ai = input.inference ? factoryAiFromProvider(input.inference) : input.ai;
  const inline = mayUseInlineSelfReview({ approval: profile.approval, autonomyMode, lineId, actorKind: input.actorKind ?? "agent" });
  const specApproved = Boolean(input.specApproved || inline.allowed);
  const stages: FactoryRunStepResult[] = [];
  let escalated = Boolean(plan.escalated);
  if (plan.selectedPipeline === "single_agent") {
    const composite = await runSingleAgentPipeline(ai, input.untrustedText, input.paths, sanitizeUntrustedPromptInput, reviewRequestsRevision);
    stages.push({ stage: "foreman", status: "ok", summary: `single_agent composite line=${lineId} autonomy=${autonomyMode}` });
    stages.push(...composite.stages);
    if (composite.escalate) {
      escalated = true;
      plan.escalated = true;
      plan.escalationReason = composite.escalateReason;
      if (input.store) await input.store.putExecutionPlan(plan);
    } else {
      return completeFactoryStages(stages, { definition: input.definition, verificationVerdict: input.verificationVerdict, verificationIngested: input.verificationIngested }, planned, autonomyMode, lineId, plan, false);
    }
  } else {
    stages.push({ stage: "foreman", status: "ok", summary: `${decision.summary || planned.join(",")} line=${lineId} autonomy=${autonomyMode} pipeline=${plan.selectedPipeline}` });
  }
  const agentById = new Map(input.definition.agents.map((agent) => [agent.id, agent]));
  if (planned.includes("triage") && !stages.some((stage) => stage.stage === "triage")) {
    const result = await runTriageAgent(ai, agentById.get("triage"), { body: input.untrustedText });
    stages.push({ stage: "triage", status: result.status, summary: result.summary });
    if (result.status === "blocked") return { stages, terminal: "blocked", lineId, autonomyMode, plan, escalated };
  }
  const skipSpec = skip.includes("specification");
  if (planned.includes("specification") && !skipSpec && !stages.some((stage) => stage.stage === "specification")) {
    const result = await runSpecificationAgent(ai, agentById.get("specification") ?? agentById.get("spec"), { body: input.untrustedText });
    stages.push({ stage: "specification", status: result.status, summary: result.summary });
    const spec = runAssuranceCheckpoint("specification", { acceptanceCriteria: result.summary });
    if (!specApproved) return { stages, terminal: "specification", wait: "spec_approval", lineId, autonomyMode, plan, escalated };
    if (spec.status === "blocked" && autonomyMode === "restricted") return { stages, terminal: "blocked", lineId, autonomyMode, plan, escalated };
  }
  if (planned.includes("architecture") && !stages.some((stage) => stage.stage === "architecture")) {
    const architecture = runAssuranceCheckpoint("architecture", { architectureFit: true });
    stages.push({ stage: "architecture", status: architecture.status, summary: architecture.summary });
  }
  if (decision.requestRevision || planned.includes("implementation")) {
    if (lineId !== "release" && !input.sandboxComplete) {
      stages.push({ stage: "implementation", status: "ok", summary: "Queued Cloudflare Sandbox implement in a leased work cell. GitHub Actions remains verification-only. No application code has been written yet." });
      return { stages, terminal: "implementation", wait: decision.requestRevision ? "revision" : "sandbox", lineId, autonomyMode, plan, escalated };
    }
    if (lineId !== "release" && !stages.some((stage) => stage.stage === "implementation")) stages.push({ stage: "implementation", status: "ok", summary: "Sandbox pushed a tinkerbot/* branch. Merge is forbidden." });
  }
  if (planned.includes("security")) {
    const security = runAssuranceCheckpoint("security", { securityChecked: true, verdict: input.verificationVerdict });
    stages.push({ stage: "security", status: security.status, summary: security.summary });
  }
  if (planned.includes("review") && !stages.some((stage) => stage.stage === "review")) {
    const result = await runReviewAgent(ai, agentById.get("review"), { verdict: input.verificationVerdict, evidenceRef: "evidence://run" });
    stages.push({ stage: "review", status: result.status, summary: result.summary });
    if (reviewRequestsRevision(result.summary) && !input.reviewRequestsRevision) return { stages, terminal: "implementation", wait: "revision", lineId, autonomyMode, plan, escalated };
  }
  return completeFactoryStages(stages, { definition: input.definition, verificationVerdict: input.verificationVerdict, verificationIngested: input.verificationIngested }, planned, autonomyMode, lineId, plan, escalated);
}

async function runSingleAgentPipeline(
  ai: FactoryAi | undefined,
  untrustedText: string | undefined,
  paths: string[] | undefined,
  sanitize: (value: string) => string,
  reviewRevision: (summary: string) => boolean,
): Promise<{ stages: FactoryRunStepResult[]; escalate: boolean; escalateReason?: string }> {
  const escalateNow = (paths ?? []).some((path) => /(^|\/)(\.github|auth|billing|security)\//.test(path)) || /\b(release|security|auth)\b/i.test(untrustedText ?? "");
  if (escalateNow) return { stages: [], escalate: true, escalateReason: "restricted_paths" };
  if (!ai) {
    return {
      stages: [
        { stage: "triage", status: "ok", summary: JSON.stringify({ priority: "low", risk: "low" }) },
        { stage: "specification", status: "ok", summary: "Composite single-agent notes. Agents cannot self-approve." },
        { stage: "review", status: "ok", summary: "Self-review is advisory. tb check remains the verdict." },
      ],
      escalate: false,
    };
  }
  try {
    const result = await ai.run("single-agent", { messages: [{ role: "system", content: "Emit JSON {triage, implementation, review}. Never merge. Never change tb check." }, { role: "user", content: sanitize(untrustedText ?? "") }] }, workersAiGatewayOptions({ stage: "single_agent" }));
    const text = typeof result.response === "string" ? result.response : "";
    const parsed = text.match(/\{[\s\S]*\}/);
    const body = parsed ? JSON.parse(parsed[0]) as Record<string, string> : { triage: text, implementation: text, review: text };
    if (body.escalate === "true" || reviewRevision(String(body.review ?? ""))) return { stages: [{ stage: "triage", status: "ok", summary: String(body.triage ?? text).slice(0, 2_000) }], escalate: true, escalateReason: "repeated_corrections" };
    return {
      stages: [
        { stage: "triage", status: "ok", summary: String(body.triage ?? "triage").slice(0, 2_000) },
        { stage: "specification", status: "ok", summary: String(body.implementation ?? "implementation notes").slice(0, 2_000) },
        { stage: "review", status: "ok", summary: String(body.review ?? "advisory self-review").slice(0, 2_000) },
      ],
      escalate: false,
    };
  } catch {
    return { stages: [], escalate: true, escalateReason: "single_agent_failed" };
  }
}

function verificationAuthority(verdict: string): "pass" | "fail" | "unknown" {
  if (verdict === "PASS") return "pass";
  if (verdict === "FAIL") return "fail";
  return "unknown";
}

function completeFactoryStages(
  stages: FactoryRunStepResult[],
  input: { definition: FactoryDefinition; verificationVerdict?: string; verificationIngested?: boolean },
  planned: FactoryStageId[],
  autonomyMode: AutonomyMode,
  lineId: ProductionLineId,
  plan: ExecutionPlan,
  escalated: boolean,
): { stages: FactoryRunStepResult[]; terminal: WorkOrderState; wait?: FactoryWait; lineId?: ProductionLineId; autonomyMode?: AutonomyMode; plan?: ExecutionPlan; escalated?: boolean } {
  if (planned.includes("verification") && !stages.some((stage) => stage.stage === "verification")) {
    const hasIngest = input.verificationIngested ?? ingestedVerdict(input.verificationVerdict);
    if (!hasIngest) {
      stages.push({ stage: "verification", status: "unknown", summary: "Waiting for Action OIDC ingest. Deterministic verdict stays UNKNOWN until tb check arrives." });
      return { stages, terminal: "verification", wait: "oidc_ingest", lineId, autonomyMode, plan, escalated };
    }
    const authority = verificationAuthority(input.verificationVerdict ?? "UNKNOWN");
    stages.push({ stage: "verification", status: authority === "unknown" ? "unknown" : "ok", summary: `Deterministic verdict ${input.verificationVerdict ?? "UNKNOWN"}. LLM review cannot override this.` });
    if (authority === "fail") return { stages, terminal: "failed", lineId, autonomyMode, plan, escalated };
  }
  if (planned.includes("release") && !stages.some((stage) => stage.stage === "release")) stages.push({ stage: "release", status: input.definition.approvals.required ? "ok" : "skipped", summary: input.definition.approvals.required ? "Waiting for human merge. Agents cannot merge." : "Approval not required." });
  if (planned.includes("outcome") && !stages.some((stage) => stage.stage === "outcome")) stages.push({ stage: "outcome", status: "unknown", summary: "Post-release outcome is not confirmed." });
  const failed = stages.some((stage) => stage.status === "blocked");
  const unknown = stages.some((stage) => stage.status === "unknown");
  if (failed) return { stages, terminal: "blocked", lineId, autonomyMode, plan, escalated };
  if (unknown && verificationAuthority(input.verificationVerdict ?? "UNKNOWN") !== "pass") return { stages, terminal: "unknown", lineId, autonomyMode, plan, escalated };
  return { stages, terminal: input.definition.approvals.required ? "approval" : "ready", wait: waitForFactoryRun({ skipSpec: true, sandboxComplete: true, verificationIngested: true }), lineId, autonomyMode, plan, escalated };
}
