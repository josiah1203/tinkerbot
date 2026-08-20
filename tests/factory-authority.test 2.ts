import { describe, expect, test } from "vitest";
import { combineVerification, moduleFeedsVerification, classifyUnknowns } from "../packages/core/src";
import {
  evaluateMergeReadiness,
  sameActorApprovalBlocked,
  classifyAiInvocation,
  workersAiInferenceProvider,
  acquireWorkCellLease,
  checkWorkCell,
  cleanupWorkCell,
  compileFactoryPlan,
  createWorkOrder,
  decayMaintenanceSignals,
  defaultAftercare,
  dispatchTinkerGateway,
  emptyWaiver,
  executeFactoryRun,
  githubTinkerMention,
  inspectRepository,
  linkAcceptanceCriterion,
  MemoryFactoryStore,
  ownershipGraph,
  parseFactoryDefinition,
  parseTinkerIntent,
  pinWorkOrderPlan,
  rejectWorkerVerdict,
  reproduceWorkCell,
  resolveReleaseDecision,
  STARTER_FACTORY_PACKS,
  stewardCannotWriteVerdict,
  STEWARD_LOOP,
  submitWorkerEvidence,
  takeWorkCell,
  productionMetrics,
  improvementLoopStep,
  waiverNeverPassesVerification,
} from "../packages/factory/src";

const source = {
  name: "demo",
  version: 1,
  agents: [{ harness: "tinkerbot-sandbox" }],
  lines: [{ id: "release", stages: ["foreman", "verification", "release"], autonomy: "restricted" }],
  skills: [],
  evolution: { autoMerge: false },
  runtime: { runner: { type: "tinkerbot-sandbox" } },
};

describe("factory authority", () => {
  test("FactoryPlan digest is immutable and pins WorkOrders", () => {
    const plan = compileFactoryPlan(source, "sha256:abc");
    expect(plan.digest.startsWith("sha256:")).toBe(true);
    expect(factoryPlanIssuesEmpty(plan.issues)).toBe(true);
    const order = pinWorkOrderPlan(createWorkOrder({
      factoryId: "f",
      organizationId: "o",
      sourceType: "manual",
      sourceId: "s",
      repositoryId: "acme/pay",
      policyVersion: "x",
      definitionVersion: "1",
      definitionDigest: "old",
      actor: "human",
    }), plan);
    expect(order.definitionDigest).toBe(plan.digest);
    expect(order.verificationVerdict).toBe("UNKNOWN");
    expect(order.reviewAssessment).toBe("NEEDS_HUMAN_REVIEW");
    expect(order.releaseDecision).toBe("BLOCKED");
  });

  test("forbidden harness and autoMerge are compile issues, not verdicts", () => {
    const plan = compileFactoryPlan({ ...source, agents: [{ harness: "claude-code" }], evolution: { autoMerge: true } }, "sha256:x");
    expect(plan.issues.some((issue) => /harness/.test(issue))).toBe(true);
    expect(plan.issues.some((issue) => /autoMerge/.test(issue))).toBe(true);
  });

  test("waiver is never a verification PASS", () => {
    const waiver = { ...emptyWaiver(), status: "APPROVED" as const, mayRelease: true, findingOrPolicy: "flake", scope: "test", reason: "known" };
    expect(waiverNeverPassesVerification(waiver)).toBe(true);
    expect(resolveReleaseDecision({ verificationVerdict: "FAIL", waiver, policyAllowsWaivedRelease: true })).toBe("BLOCKED");
    expect(resolveReleaseDecision({ verificationVerdict: "PASS", waiver, policyAllowsWaivedRelease: true })).toBe("READY");
  });

  test("workers cannot submit verificationVerdict", () => {
    expect(rejectWorkerVerdict({ verificationVerdict: "PASS" }).ok).toBe(false);
    expect(submitWorkerEvidence({ logs: "tests passed" })).toEqual({ ok: true, provenance: "reported" });
  });

  test("@tinker high-risk actions require confirmation", () => {
    expect(parseTinkerIntent("@tinker status")?.action).toBe("traveler_status");
    expect(parseTinkerIntent("@tinker apply a waiver")?.confirmationRequired).toBe(true);
    const high = dispatchTinkerGateway({
      text: "@tinker skip verification",
      organizationId: "org",
      sourceSystem: "slack",
      sourceObjectId: "1",
      actorId: "u",
      authorized: true,
    });
    expect(high.command.action).toBe("skip_stage");
    expect(high.authorization).toEqual({ ok: false, reason: "confirmation_required" });
    expect(high.upgradesVerdict).toBe(false);
    expect(githubTinkerMention("issue_comment", { comment: { body: "@tinker what is blocking?" } })).toContain("@tinker");
    expect(githubTinkerMention("push", { comment: { body: "@tinker" } })).toBeUndefined();
  });

  test("cell protocol lease, take, cleanup, reproduce", () => {
    const leased = acquireWorkCellLease({
      cells: [],
      factoryId: "f",
      workOrderId: "wo_aaaaaaaa",
      repository: "acme/pay",
      branch: "tinkerbot/wo",
      pinSha: "abc",
      actor: "human",
      now: "2030-01-01T00:00:00.000Z",
    });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const held = takeWorkCell(leased.cell, "human", "2030-01-01T00:00:01.000Z");
    expect(held.status).toBe("held");
    expect(cleanupWorkCell(held, "2030-01-01T00:00:02.000Z").status).toBe("free");
    expect(reproduceWorkCell(leased.cell).command).toBe("tb cell check");
    expect(reproduceWorkCell(leased.cell).upgradesVerdict).toBe(false);
  });

  test("reported claims do not feed tb check", () => {
    expect(moduleFeedsVerification("worker-claim")).toBe(false);
    expect(moduleFeedsVerification("test-integrity")).toBe(true);
    const combined = combineVerification({
      findings: [],
      config: { test_integrity: { mode: "advisory" } } as never,
      unknowns: [],
      reportedClaims: [{ statement: "tests passed", provenance: "reported" }],
    });
    expect(combined.ignoredReported).toBe(1);
    expect(combined.verificationVerdict).toBe("PASS");
    expect(combined.reviewAssessment).toBe("CLEAR");
    const warned = combineVerification({
      findings: [{ id: "w", ruleId: "impact.unverified", category: "impact", severity: "warning", message: "review", explanation: "x", suggestedAction: "y", confidence: "medium" } as never],
      config: { test_integrity: { mode: "advisory" } } as never,
      unknowns: [],
    });
    expect(warned.verificationVerdict).toBe("UNKNOWN");
    expect(warned.reviewAssessment).toBe("NEEDS_HUMAN_REVIEW");
  });

  test("catalog, aftercare, packs, and steward loop stay off the verdict path", () => {
    expect(stewardCannotWriteVerdict()).toBe(true);
    expect(STEWARD_LOOP[0]).toBe("observe");
    expect(decayMaintenanceSignals()).toContain("stale-waiver");
    expect(STARTER_FACTORY_PACKS.some((pack) => pack.id === "typescript-service")).toBe(true);
    expect(defaultAftercare("rel_1", "owner").outcomeStatus).toBe("pending");
    expect(linkAcceptanceCriterion("login works", "src/auth.ts").releaseDecision).toBe("BLOCKED");
    const graph = ownershipGraph({
      name: "pay",
      portfolio: "fin",
      owners: ["alice"],
      environments: ["prod"],
      services: [{ id: "api", repository: "acme/pay", owners: ["alice"], apis: ["/v1"] }],
    });
    expect(graph.some((node) => node.kind === "repository")).toBe(true);
    expect(inspectRepository(process.cwd()).languages.length).toBeGreaterThan(0);
    expect(productionMetrics({ passedFirst: 8, total: 10, rework: 1, unknowns: 1, cycle: 60, queue: 10, costCents: 0 }).firstPassYield).toBe(0.8);
    expect(improvementLoopStep("propose").silentChangeForbidden).toBe(true);
  });

  test("internal Workers AI cannot serve customer production", async () => {
    expect(() => classifyAiInvocation({ stage: "implementation", providerId: "workers-ai", mode: "managed" })).toThrow(/customer_production_cannot_use_tinkerbot_provider/);
    expect(classifyAiInvocation({ stage: "triage", providerId: "workers-ai", mode: "managed" })).toMatchObject({
      aiPurpose: "internal_factory_intelligence",
      billingOwner: "tinkerbot",
    });
    let productionCalls = 0;
    const provider = workersAiInferenceProvider({
      run: async () => {
        productionCalls += 1;
        return { response: "no" };
      },
    });
    await expect(provider.run({ model: "x", messages: [], stage: "implementation" })).rejects.toThrow(/customer_production/);
    expect(productionCalls).toBe(0);
    await expect(provider.run({ model: "x", messages: [], stage: "triage" })).resolves.toMatchObject({ text: "no" });
  });

  test("restricted lines enforce author-never-approver and never auto-merge", () => {
    expect(sameActorApprovalBlocked({ actorId: "alice", cellHolderId: "alice", lineId: "security", autonomyMode: "restricted" })).toEqual({ blocked: true, reason: "author_cannot_approve" });
    expect(sameActorApprovalBlocked({ actorId: "bob", cellHolderId: "alice", lineId: "security", autonomyMode: "restricted" }).blocked).toBe(false);
    expect(sameActorApprovalBlocked({ actorId: "alice", cellHolderId: "alice", lineId: "feature" }).blocked).toBe(false);
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: [] }).humanMergeRequired).toBe(true);
  });

  test("WIP limits and productionAccess denial", () => {
    const wip = acquireWorkCellLease({
      cells: [],
      factoryId: "f",
      workOrderId: "wo_bbbbbbbb",
      repository: "acme/pay",
      branch: "tinkerbot/wo",
      actor: "agent",
      now: "2030-01-01T00:00:00.000Z",
      wipLimit: 1,
      inProgressCount: 1,
    });
    expect(wip).toMatchObject({ ok: false, reason: "wip" });
    const leased = acquireWorkCellLease({
      cells: [],
      factoryId: "f",
      workOrderId: "wo_cccccccc",
      repository: "acme/pay",
      branch: "tinkerbot/wo",
      actor: "agent",
      now: "2030-01-01T00:00:00.000Z",
    });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    expect(leased.cell.productionAccess).toBe("denied");
    expect(checkWorkCell({ ...leased.cell, productionAccess: "allowed" }, "2030-01-01T00:00:00.000Z").ok).toBe(false);
    expect(checkWorkCell(leased.cell, "2030-01-01T00:00:00.000Z").ok).toBe(true);
  });

  test("Inspect closed-loop contract rehearsals", async () => {
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: [], restricted: false }).humanMergeRequired).toBe(true);
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: [], restricted: true }).ready).toBe(false);
    const missing = combineVerification({
      findings: [],
      config: { test_integrity: { mode: "advisory" } } as never,
      unknowns: classifyUnknowns(["required test was not executed"]),
      reportedClaims: [{ statement: "tests passed", provenance: "reported" }],
    });
    expect(missing.verificationVerdict).toBe("UNKNOWN");
    expect(missing.ignoredReported).toBe(1);
    expect(() => classifyAiInvocation({ stage: "implementation", providerId: "workers-ai" })).toThrow(/customer_production/);
    const leased = acquireWorkCellLease({ cells: [], factoryId: "f", workOrderId: "wo_dddddddd", repository: "acme/pay", branch: "tinkerbot/wo", actor: "inspect", now: "2030-01-01T00:00:00.000Z" });
    expect(leased.ok).toBe(true);
    if (!leased.ok) return;
    const human = takeWorkCell(leased.cell, "human-reviewer", "2030-01-01T00:00:01.000Z");
    expect(human.heldBy).toBe("human-reviewer");
    expect(human.leasedBy).toBe("human-reviewer");
    expect(leased.cell.leasedBy).toBe("inspect");
    expect(productionMetrics({ passedFirst: 1, total: 2, rework: 1, unknowns: 0, cycle: 10, queue: 1, costCents: 42 }).costPerWorkOrderCents).toBe(42);
    expect(defaultAftercare("rel_loop", "owner").releaseId).toBe("rel_loop");
    const definition = parseFactoryDefinition("name: inspect\nrepositories: [acme/pay]\nbudgets:\n  usdCents: 0\n  tokens: 0\nsources:\n  - type: github_issue\n");
    const run = await executeFactoryRun({ definition, sourceType: "github_issue", untrustedText: "add a button", sandboxComplete: false, specApproved: true });
    expect(run.stages.some((stage) => stage.stage === "implementation" && stage.status === "skipped")).toBe(true);
    expect(run.stages.some((stage) => stage.stage === "verification")).toBe(true);
  });
});

function factoryPlanIssuesEmpty(issues: string[]): boolean {
  return issues.length === 0;
}
