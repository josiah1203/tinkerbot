import { describe, expect, test } from "vitest";
import {
  groupView,
  normalizeOutcomeStatus,
  normalizeReleaseDecision,
  normalizeReviewDecision,
  normalizeVerificationVerdict,
  stageView,
} from "../packages/factory/src";

describe("control-plane normalized read model", () => {
  test("maps legacy verdicts and keeps agent clear separate from human approval", () => {
    expect(normalizeVerificationVerdict("PASS")).toBe("pass");
    expect(normalizeVerificationVerdict("FAIL")).toBe("fail");
    expect(normalizeReviewDecision("CLEAR")).toBe("not_required");
    expect(normalizeReviewDecision("NEEDS_HUMAN_REVIEW")).toBe("awaiting_human");
    expect(normalizeReleaseDecision("READY", { verification: "pass", review: "not_required" })).toBe("not_eligible");
    expect(normalizeReleaseDecision("READY", { verification: "pass", review: "approved" })).toBe("awaiting_authorization");
  });

  test("groups deterministic failures and unresolved unknowns before release", () => {
    expect(groupView({ status: "failed", verification: "fail", review: "awaiting_human", release: "not_eligible", outcome: "pending" })).toBe("blocked");
    expect(groupView({ status: "verification", verification: "pass", review: "approved", release: "awaiting_authorization", outcome: "pending" })).toBe("ready");
    expect(groupView({ status: "verification", verification: "unknown", review: "awaiting_human", release: "not_eligible", outcome: "unknown" })).toBe("unknown");
    expect(normalizeOutcomeStatus("successful_release")).toBe("accepted");
    expect(stageView("implementation")).toBe("build");
    expect(stageView("complete")).toBe("release");
  });
});
