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
import type { FactoryCommandInput, FactoryCommandResult } from "./spine";
import type { FactoryEvent } from "./graph";
import { createVerificationRecordedEvent, isFactoryCommandBoundaryEventType } from "./graph";
import type { InferenceProvider } from "./inference";
import { factoryAiFromProvider } from "./inference";
import type { FactoryAi, FactoryDefinition, FactoryRunStepResult, FactoryStageId, WorkOrder, WorkOrderState } from "./index";

const AGENT_OUTPUT_SECRET_PATTERNS = [
  /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|(?:xai|pplx)-[A-Za-z0-9_-]{8,})/gi,
  /((?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|signing[_-]?secret|webhook[_-]?secret)\s*[:=]\s*)\S+/gi,
];

function sanitizeAgentOutput(value: string, limit = 2_000): string {
  let result = value;
  for (const pattern of AGENT_OUTPUT_SECRET_PATTERNS) result = result.replace(pattern, (match, prefix?: string) => prefix ? `${prefix}[redacted]` : "[redacted]");
  return result.slice(0, limit);
}

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
  /** Previously persisted stages when resuming an implementation handoff. */
  priorStages?: FactoryRunStepResult[];
  /** The durable execution plan for a resumed run, when one exists. */
  priorPlan?: ExecutionPlan;
  workOrderId?: string;
  factoryId?: string;
  organizationId?: string;
  changeSetId?: string;
  changeSetDigest?: string;
  verificationRunId?: string;
  paths?: string[];
  diffs?: { paths: string[]; changedFileCount: number; changedLines: number };
  impactUnknown?: boolean;
  testIntegrityUnknown?: boolean;
  priorFailures?: number;
  store?: Pick<FactoryStore, "putExecutionPlan" | "putCostEstimate" | "putCostActual"> & Partial<Pick<FactoryStore, "appendFactoryEvent">> & { dispatchFactoryCommand?: <T>(command: FactoryCommandInput<T>) => Promise<FactoryCommandResult> };
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
  const plan = input.priorPlan ?? built.plan;
  const { decision, autonomyMode, lineId } = built;
  const estimatedTokens = plan.cost.estimatedInputTokens + plan.cost.estimatedOutputTokens;
  const estimatedCents = plan.cost.byokSpendCents + plan.cost.managedCogsCents;
  const appendGraph = async (
    type: FactoryEvent["type"],
    payload: Record<string, unknown>,
    overrides: Partial<Pick<FactoryEvent, "actorId" | "actorType" | "provenance">> = {},
  ): Promise<void> => {
    if (!input.workOrderId || !input.store?.appendFactoryEvent) return;
    // Graph events are keyed by plan and semantic event type so a queue
    // redelivery or self-hosted completion retry cannot create a second copy
    // merely because the in-process event ordering changed.
    const eventId = `${plan.planId}:${type}`;
    if (type === "verification.recorded") {
      const changeSetId = typeof payload.changeSetId === "string" ? payload.changeSetId : input.changeSetId ?? input.workOrderId;
      const changeSetDigest = typeof payload.changeSetDigest === "string" ? payload.changeSetDigest : input.changeSetDigest ?? `sha256:${plan.planId}`;
      const verificationRunId = typeof payload.verificationRunId === "string" ? payload.verificationRunId : input.verificationRunId ?? plan.planId;
      const verificationEvent = createVerificationRecordedEvent({ eventId: `${eventId}:${verificationRunId}`, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId ?? "local", factoryId: input.factoryId ?? "local-factory", actorId: overrides.actorId ?? "deterministic-verifier", actorType: "system", occurredAt: new Date().toISOString(), correlationId: plan.planId, policyVersion: "default", workOrderId: input.workOrderId, changeSetId: changeSetId ?? input.workOrderId, changeSetDigest, verificationRunId, verdict: payload.verdict === "PASS" || payload.verdict === "FAIL" ? payload.verdict : "UNKNOWN" });
      if (input.store.dispatchFactoryCommand) {
        await input.store.dispatchFactoryCommand({ organizationId: input.organizationId ?? "local", factoryId: input.factoryId ?? "local-factory", workOrderId: input.workOrderId, actorId: overrides.actorId ?? "deterministic-verifier", actorType: "system", idempotencyKey: `verification:${verificationRunId}:${changeSetDigest}`, payload: { changeSetId: changeSetId ?? input.workOrderId, changeSetDigest, verificationRunId, verdict: verificationEvent.payload.verdict }, now: verificationEvent.occurredAt, buildEvents: () => [verificationEvent] });
      } else {
        throw new Error("factory_command_boundary_required");
      }
      return;
    }
    const event: FactoryEvent = {
      eventId,
      type,
      aggregateId: input.workOrderId,
      aggregateType: "work_order",
      organizationId: input.organizationId ?? "local",
      factoryId: input.factoryId ?? "local-factory",
      actorId: overrides.actorId ?? (input.actorKind === "human" ? "local-human" : "factory-orchestrator"),
      actorType: overrides.actorType ?? "system",
      occurredAt: new Date().toISOString(),
      correlationId: plan.planId,
      schemaVersion: 1,
      policyVersion: "default",
      provenance: overrides.provenance ?? "ATTESTED",
      payload: { ...payload, planId: plan.planId },
    };
    const bindingEvent = isFactoryCommandBoundaryEventType(type);
    if (bindingEvent) {
      if (!input.store.dispatchFactoryCommand) throw new Error("factory_command_boundary_required");
      await input.store.dispatchFactoryCommand({ organizationId: input.organizationId ?? "local", factoryId: input.factoryId ?? "local-factory", workOrderId: input.workOrderId, actorId: event.actorId, actorType: event.actorType, idempotencyKey: `run:${plan.planId}:${type}`, payload, now: event.occurredAt, buildEvents: () => [event] });
      return;
    }
    await input.store.appendFactoryEvent(event);
  };
  const overBudget = input.definition.budgets.tokens <= 0
    || input.definition.budgets.usdCents <= 0
    || estimatedTokens > input.definition.budgets.tokens
    || estimatedCents > input.definition.budgets.usdCents;
  if (input.store && !input.priorPlan) {
    await input.store.putExecutionPlan(plan);
    await input.store.putCostEstimate(plan.planId, plan.cost);
  }
  if (!input.priorPlan) {
    await appendGraph("task.decomposed", { planId: plan.planId, selectedPipeline: plan.selectedPipeline, stages: plan.stages.map((stage) => stage.id), skip: plan.skip });
    if (estimatedCents > 0) await appendGraph("cost.recorded", { costCents: estimatedCents, category: "cogs", planId: plan.planId });
    await appendGraph("change.proposed", { workOrderId: input.workOrderId, changeSetId: input.changeSetId ?? input.workOrderId ?? plan.planId, changeSetDigest: input.changeSetDigest ?? `sha256:${plan.planId}`, planId: plan.planId });
  }
  const product = resolveProduct(input.definition, input.definition.repositories[0] ?? "unknown/unknown");
  const skip = plan.skip.filter((stage) => stage !== "verification" && autonomyAllowsSkip(autonomyMode ?? "approval_gated", stage as FactoryStageId));
  const planned = runForeman(input.definition, input.sourceType, skip as FactoryStageId[], lineId);
  if (!planned.length) return { stages: [{ stage: "foreman", status: "skipped", summary: "Source is not enabled for this factory." }], terminal: "cancelled", lineId, autonomyMode, plan };
  if (product.blocked) return { stages: [{ stage: "foreman", status: "blocked", summary: product.action ?? "map repository to product" }], terminal: "blocked", lineId, autonomyMode, plan };
  if (planned.includes("verification")) {
    await appendGraph("verification.started", { verdict: input.verificationVerdict ?? "UNKNOWN" });
    if ((input.verificationVerdict === "PASS" || input.verificationVerdict === "FAIL") && (input.verificationIngested ?? true)) {
      await appendGraph("verification.recorded", { verdict: input.verificationVerdict, changeSetId: input.changeSetId ?? input.workOrderId, changeSetDigest: input.changeSetDigest ?? `sha256:${plan.planId}`, verificationRunId: input.verificationRunId ?? plan.planId }, { actorId: "deterministic-verifier", actorType: "system", provenance: "DETERMINISTICALLY_VERIFIED" });
    }
  }
  if (planned.includes("review")) await appendGraph("review.requested", { requiredReviewer: "independent-human-or-agent" });
  if (planned.includes("release")) await appendGraph("release.requested", { authority: "human", workOrderId: input.workOrderId, requestId: `${plan.planId}:release`, changeSetId: input.changeSetId ?? input.workOrderId ?? plan.planId, changeSetDigest: input.changeSetDigest ?? `sha256:${plan.planId}` });
  if (planned.includes("outcome")) await appendGraph("outcome.measurement_started", { maturity: "IMMATURE" });
  const ai = input.inference ? factoryAiFromProvider(input.inference) : input.ai;
  const inline = mayUseInlineSelfReview({ approval: profile.approval, autonomyMode, lineId, actorKind: input.actorKind ?? "agent" });
  const specApproved = Boolean(input.specApproved || inline.allowed);
  // A self-hosted completion resumes the same run. Reuse the durable stages
  // already emitted before the handoff so triage/specification (and their AI
  // calls/costs) are not executed and billed a second time.
  const stages: FactoryRunStepResult[] = [...(input.priorStages ?? [])];
  let escalated = Boolean(plan.escalated);
  if (plan.selectedPipeline === "single_agent") {
    if (!input.priorStages?.length) {
      const composite = await runSingleAgentPipeline(ai, input.untrustedText, input.paths, sanitizeUntrustedPromptInput, reviewRequestsRevision);
      stages.push({ stage: "foreman", status: "ok", summary: `single_agent composite line=${lineId} autonomy=${autonomyMode}` });
      stages.push(...composite.stages);
      if (composite.escalate) {
        escalated = true;
        plan.escalated = true;
        plan.escalationReason = composite.escalateReason;
        if (input.store) await input.store.putExecutionPlan(plan);
      } else if (!planned.includes("implementation") || input.sandboxComplete) {
        return completeFactoryStages(stages, { definition: input.definition, verificationVerdict: input.verificationVerdict, verificationIngested: input.verificationIngested }, planned, autonomyMode, lineId, plan, false);
      }
    } else if (input.sandboxComplete) {
      return completeFactoryStages(stages, { definition: input.definition, verificationVerdict: input.verificationVerdict, verificationIngested: input.verificationIngested }, planned, autonomyMode, lineId, plan, escalated);
    }
  } else {
    if (!stages.some((stage) => stage.stage === "foreman")) stages.push({ stage: "foreman", status: "ok", summary: `${decision.summary || planned.join(",")} line=${lineId} autonomy=${autonomyMode} pipeline=${plan.selectedPipeline}` });
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
    const existingImplementation = stages.findIndex((stage) => stage.stage === "implementation");
    if (overBudget) {
      if (existingImplementation < 0) stages.push({ stage: "implementation", status: "skipped", summary: "Budget exceeded. Implementation skipped. Verification still runs." });
    } else if (lineId !== "release" && !input.sandboxComplete) {
      if (existingImplementation < 0) stages.push({ stage: "implementation", status: "ok", summary: "Queued Cloudflare Sandbox implement in a leased work cell. GitHub Actions remains verification-only. No application code has been written yet." });
      return { stages, terminal: "implementation", wait: decision.requestRevision ? "revision" : "sandbox", lineId, autonomyMode, plan, escalated };
    }
    if (lineId !== "release") {
      if (existingImplementation >= 0 && input.sandboxComplete) stages[existingImplementation] = { stage: "implementation", status: "ok", summary: "Self-hosted harness pushed a tinkerbot/* branch. Merge is forbidden." };
      else if (existingImplementation < 0) stages.push({ stage: "implementation", status: "ok", summary: "Sandbox pushed a tinkerbot/* branch. Merge is forbidden." });
    }
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
    if (body.escalate === "true" || reviewRevision(String(body.review ?? ""))) return { stages: [{ stage: "triage", status: "ok", summary: sanitizeAgentOutput(String(body.triage ?? text)) }], escalate: true, escalateReason: "repeated_corrections" };
    return {
      stages: [
        { stage: "triage", status: "ok", summary: sanitizeAgentOutput(String(body.triage ?? "triage")) },
        { stage: "specification", status: "ok", summary: sanitizeAgentOutput(String(body.implementation ?? "implementation notes")) },
        { stage: "review", status: "ok", summary: sanitizeAgentOutput(String(body.review ?? "advisory self-review")) },
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
