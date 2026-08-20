import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeMutationReport, runTargetedMutation } from "../packages/mutation/src";
import { renderMarkdown, renderReport, renderSarif } from "../packages/reporters/src";
import type { FileDiff, PrProofReport } from "../packages/core/src";

test("normalizes killed, survived, timeout, and no-coverage mutant states", () => {
  const raw = JSON.parse(fs.readFileSync("fixtures/mutation/results.json", "utf8"));
  const results = normalizeMutationReport(raw, 20);
  expect(results.map((result) => result.status)).toEqual(["killed", "survived", "timeout", "no_coverage"]);
});

test("reuses a bounded mutation result cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-"));
  const resultFile = path.join(root, "results.json");
  fs.copyFileSync("fixtures/mutation/results.json", resultFile);
  const config = { enabled: true, max_mutants: 20, changed_lines_only: true, timeout_seconds: 10 };
  const options = { root, diffs: [{ path: "src/auth/session.ts", status: "modified", additions: 1, deletions: 1, changedLines: [2], deletedLines: [2], hunks: [], patch: "" }] as FileDiff[], config, base: "base", head: "head" };
  process.env.PR_PROOF_MUTATION_RESULTS = "results.json";
  const first = runTargetedMutation(options);
  const second = runTargetedMutation(options);
  delete process.env.PR_PROOF_MUTATION_RESULTS;
  expect(first.cacheHit).toBe(false);
  expect(second.cacheHit).toBe(true);
  expect(second.survived).toBe(1);
});

test("invalidates mutation cache when the dependency lock changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-lock-"));
  const resultFile = path.join(root, "results.json");
  fs.copyFileSync("fixtures/mutation/results.json", resultFile);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lock-a");
  const config = { enabled: true, max_mutants: 20, changed_lines_only: true, timeout_seconds: 10 };
  const options = { root, diffs: [{ path: "src/auth/session.ts", status: "modified", additions: 1, deletions: 1, changedLines: [2], deletedLines: [2], hunks: [], patch: "" }] as FileDiff[], config, base: "base", head: "head" };
  process.env.PR_PROOF_MUTATION_RESULTS = "results.json";
  runTargetedMutation(options);
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lock-b");
  const result = runTargetedMutation(options);
  delete process.env.PR_PROOF_MUTATION_RESULTS;
  expect(result.cacheHit).toBe(false);
});

test("reports mutation process failure and empty scope without passing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-process-"));
  const config = { enabled: true, max_mutants: 20, changed_lines_only: true, timeout_seconds: 10, command: "node -e \"process.exit(7)\"" };
  const failed = runTargetedMutation({ root, diffs: [{ path: "src/session.ts", status: "modified", additions: 1, deletions: 0, changedLines: [1], deletedLines: [], hunks: [], patch: "" }] as FileDiff[], config, base: "base", head: "head" });
  const empty = runTargetedMutation({ root: fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-empty-")), diffs: [], config, base: "base", head: "head" });
  expect(failed.unknown).toBe(1);
  expect(empty.notRun).toBe(1);
});

test("renders JSON, Markdown, and SARIF with exact finding locations", () => {
  const report = { schemaVersion: 1, toolVersion: "0.1.0", repository: "fixture", base: "a", head: "b", generatedAt: "2026-01-01T00:00:00.000Z", verdict: "UNKNOWN", reviewAssessment: "REVISE" as const, summary: { assertionsWeakened: 1, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: 50, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 1, downstreamConsumers: 1, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 1, unverifiedPaths: 1 }, findings: [{ id: "x", ruleId: "assertion.removed", category: "test_integrity", severity: "high", file: "src/a.test.ts", line: 4, message: "Removed assertion", explanation: "Evidence", suggestedAction: "Restore it", confidence: "high" }], limitations: [] } satisfies PrProofReport;
  expect(renderReport(report, "json")).toContain('"ruleId": "assertion.removed"');
  expect(renderMarkdown(report)).toContain("src/a.test.ts:4");
  expect(renderSarif(report)).toContain('"startLine": 4');
});

test("renders missing assurance artifacts as explicit unknown objects", () => {
  const report = { schemaVersion: 1, toolVersion: "0.1.0", repository: "fixture", base: "a", head: "b", verdict: "PASS", summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 }, findings: [], limitations: [] } satisfies PrProofReport;
  expect(JSON.parse(renderReport(report, "receipt"))).toMatchObject({ kind: "verification-receipt", status: "unknown" });
  expect(JSON.parse(renderReport(report, "change-assurance"))).toMatchObject({ kind: "assurance-bundle", status: "unknown" });
  expect(JSON.parse(renderReport(report, "release-manifest"))).toMatchObject({ kind: "release-manifest", status: "unknown" });
});
