import { describe, expect, test } from "vitest";
import { combineVerification, moduleFeedsVerification } from "../packages/core/src";
import {
  acquireWorkCellLease,
  cleanupWorkCell,
  compileFactoryPlan,
  createWorkOrder,
  decayMaintenanceSignals,
  defaultAftercare,
  dispatchTinkerGateway,
  emptyWaiver,
  githubTinkerMention,
  inspectRepository,
  linkAcceptanceCriterion,
  MemoryFactoryStore,
  ownershipGraph,
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

  test("factory commands and aftercare persist off the verdict path", async () => {
    const store = new MemoryFactoryStore();
    const dispatched = dispatchTinkerGateway({
      text: "@tinker status",
      organizationId: "org",
      sourceSystem: "slack",
      sourceObjectId: "1",
      actorId: "u",
      authorized: true,
    });
    await store.insertFactoryCommand(dispatched.command);
    await store.insertAftercare(defaultAftercare("rel_persist", "owner"));
    expect(store.commands).toHaveLength(1);
    expect(store.aftercare[0]?.outcomeStatus).toBe("pending");
  });
});

function factoryPlanIssuesEmpty(issues: string[]): boolean {
  return issues.length === 0;
}
