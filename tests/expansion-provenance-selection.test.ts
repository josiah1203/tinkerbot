import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildProvenance } from "../packages/provenance/src";
import { selectTests } from "../packages/selection/src";
import { DEFAULT_CONFIG } from "../packages/core/src";
import type { FileDiff, ImpactReport } from "../packages/core/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function emptyImpact(overrides: Partial<ImpactReport> = {}): ImpactReport {
  return { filesAnalyzed: 1, symbolsAnalyzed: 1, changedSymbols: [], paths: [], downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, unverifiedPaths: [], findings: [], unknowns: [], ...overrides };
}

function diff(pathname: string): FileDiff {
  return { path: pathname, status: "modified", additions: 1, deletions: 0, changedLines: [2], deletedLines: [], hunks: [], patch: "" };
}

test("provenance labels runtime, static, nearby, and unresolved relationships without overstating proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-provenance-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "test('direct case', () => {});\n");
  const records = buildProvenance(root, [diff("src/a.ts")], emptyImpact({ paths: [
    { id: "direct", sourceFile: "src/a.ts", sourceSymbol: "run", file: "src/a.ts", symbol: "run", classification: "direct", reason: "coverage matched changed line", testFiles: ["src/a.test.ts"], verified: true, modifiedByPr: true, verificationState: "verified", coverageLines: [2] },
    { id: "unknown", sourceFile: "src/generated.ts", file: "src/generated.ts", classification: "runtime_unknown", reason: "dynamic import", testFiles: ["src/a.test.ts"], verified: false, modifiedByPr: true, verificationState: "unknown" },
  ] }));
  expect(records.some((record) => record.provenanceMethod === "runtime_coverage" && record.executionEvidence === "executed" && record.confidence === "high")).toBe(true);
  expect(records.some((record) => record.provenanceMethod === "unresolved" && record.executionEvidence === "unknown" && record.confidence === "low")).toBe(true);
});

test("uncertain impact selects the full suite and explains the fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-selection-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "test('a', () => {});\n");
  fs.writeFileSync(path.join(root, "src/b.test.ts"), "test('b', () => {});\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  fs.appendFileSync(path.join(root, "src/a.ts"), "export const b = 2;\n");
  git(root, ["commit", "-qam", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const plan = selectTests({ root, head, diffs: [diff("src/a.ts")], impact: emptyImpact({ unknowns: ["dynamic import could not be resolved"], paths: [{ id: "unknown", sourceFile: "src/a.ts", file: "src/a.ts", classification: "runtime_unknown", reason: "dynamic import", testFiles: ["src/a.test.ts"], verified: false, modifiedByPr: true, verificationState: "unknown" }] }), config: structuredClone(DEFAULT_CONFIG) });
  expect(plan.requiresFullSuite).toBe(true);
  expect(plan.selected).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  expect(plan.fallback).toMatch(/full suite/i);
  expect(plan.unknowns).toContain("dynamic import could not be resolved");
});

test("selection classifies generated paths, empty suites, and mixed confidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-selection-branches-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "no tests"]);
  const emptyHead = git(root, ["rev-parse", "HEAD"]);
  const empty = selectTests({ root, head: emptyHead, diffs: [diff("src/a.ts")], impact: emptyImpact(), config: structuredClone(DEFAULT_CONFIG) });
  expect(empty.unknowns).toContain("No test files were found at the head revision.");
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "test('a', () => {});\n");
  fs.writeFileSync(path.join(root, "src/b.test.ts"), "test('b', () => {});\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "tests"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const generated = selectTests({
    root,
    head,
    diffs: [diff("src/a.ts")],
    impact: emptyImpact({
      paths: [{ id: "gen", sourceFile: "src/a.ts", file: "src/a.ts", classification: "generated", reason: "generated", testFiles: ["src/a.test.ts"], verified: false, modifiedByPr: true, verificationState: "partially_verified" }],
    }),
    config: structuredClone(DEFAULT_CONFIG),
  });
  expect(generated.requiresFullSuite).toBe(true);
  const mixedConfig = structuredClone(DEFAULT_CONFIG);
  mixedConfig.selection.full_suite_on_unknown = false;
  mixedConfig.selection.confidence_threshold = "medium";
  const mixed = selectTests({
    root,
    head,
    diffs: [diff("src/a.ts")],
    impact: emptyImpact({
      paths: [
        { id: "high", sourceFile: "src/a.ts", sourceSymbol: "a", file: "src/a.ts", symbol: "a", classification: "direct", reason: "verified", testFiles: ["src/a.test.ts"], verified: true, modifiedByPr: true, verificationState: "verified" },
        { id: "mid", sourceFile: "src/a.ts", file: "src/a.ts", classification: "downstream", reason: "related", testFiles: ["src/b.test.ts"], verified: false, modifiedByPr: false, verificationState: "partially_verified" },
      ],
    }),
    config: mixedConfig,
  });
  expect(mixed.confidence).toBe("medium");
  expect(mixed.selected).toEqual(["src/a.test.ts", "src/b.test.ts"]);
});
