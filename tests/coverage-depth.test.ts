import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { DEFAULT_CONFIG, TOOL_VERSION } from "../packages/core/src";
import type { Finding, PrProofReport, FileDiff, CoverageReport } from "../packages/core/src";
import { appendHistory, compareHistory, historyRecordFromReport, readHistory, readHistoryDetails } from "../packages/history/src";
import { applyBaselineStates, compareBaseline, createBaseline, readBaseline, writeBaseline } from "../packages/baseline/src";
import { createGitContext, getDiff, getRepoRoot, listFilesAtRevision, makeTempWorktree, parseUnifiedDiff, readFileAtRevision, resolveRevision, runCommandAtRevision } from "../packages/git/src";
import { renderMarkdown, renderReport, renderReviewContext, renderSarif, renderTerminal, verdictEmoji } from "../packages/reporters/src";
import { detectArtifactType, loadArtifact, parseArtifact } from "../packages/artifacts/src";
import { parseCoveragePyJson, parseGoCoverprofile, parseLlvmCovJson, parseGcov, parseIstanbulJson, parseLcov } from "../packages/coverage/src";
import { analyzeImpact } from "../packages/impact-analysis/src";
import { analyzeTestDiffs, analyzeTestIntegrity } from "../packages/test-integrity/src";
import { mutationScope, normalizeMutationReport, runTargetedMutation } from "../packages/mutation/src";
import { analyzeContracts } from "../packages/contracts/src";
import { applyPolicy, getPolicyPack } from "../packages/policy/src";
import { selectTests } from "../packages/selection/src";
import { createReport, main, runCli } from "../packages/cli/src";
import { createControlPlaneServer } from "../packages/cli/src/serve";
import { renderDoctor, runDoctor } from "../packages/cli/src/doctor";
import { runTui } from "../packages/cli/src/tui";
import { createAssuranceBundle, createReleaseManifest, createRuntimeOutcome, createVerificationReceipt, serializeReceipt } from "../packages/assurance/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function initRepo(prefix: string): { root: string; base: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "coverage@example.com"]);
  git(root, ["config", "user.name", "Coverage Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/core.ts"), "export function run(value: number) { return value + 1; }\n");
  fs.writeFileSync(path.join(root, "src/consumer.ts"), "import { run } from './core';\nexport function consume(value: number) { return run(value); }\n");
  fs.writeFileSync(path.join(root, "src/core.test.ts"), "import { run } from './core';\ntest('run', () => run(1));\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "src/core.ts"), "export const route = (app: any) => app.get('/health', run);\n");
  fs.writeFileSync(path.join(root, "src/dynamic.ts"), "export const dynamic = 1;\n");
  fs.appendFileSync(path.join(root, "src/consumer.ts"), "export async function load(name: string) { return import(name); }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "head"]);
  return { root, base, head: git(root, ["rev-parse", "HEAD"]) };
}

function finding(id: string, ruleId = "impact.unverified", file = "src/core.ts"): Finding {
  return {
    id,
    ruleId,
    category: "impact",
    severity: "high",
    file,
    line: 1,
    message: `Finding ${id}`,
    explanation: "Evidence is intentionally incomplete for this test.",
    suggestedAction: "Add deterministic evidence.",
    confidence: "medium",
    resolution: "open",
    blocking: true,
  };
}

function report(overrides: Record<string, unknown> = {}): PrProofReport {
  const value = {
    schemaVersion: 1,
    schemaId: "https://pr-proof.dev/schemas/report/v1",
    toolVersion: TOOL_VERSION,
    repository: "local/coverage",
    base: "base",
    head: "head",
    generatedAt: "2026-01-01T00:00:00.000Z",
    verdict: "NEEDS_REVIEW",
    summary: {
      assertionsWeakened: 1,
      newTests: 2,
      testsPassingOnBase: 1,
      changedLinesCoveredPercentage: 50,
      mutantsKilled: 1,
      mutantsTotal: 2,
      changedSymbols: 1,
      downstreamConsumers: 1,
      impactedTests: 1,
      impactedPathsExecuted: 1,
      impactedPathsTotal: 2,
      unverifiedPaths: 1,
    },
    findings: [finding("f-1")],
    limitations: ["coverage is partial"],
    ...overrides,
  };
  return value as unknown as PrProofReport;
}

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write);
  try {
    return { code: fn(), stdout, stderr };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}

test("history records, reads, compares, and diagnoses durable local history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-history-depth-"));
  expect(readHistory(root)).toEqual([]);
  expect(compareHistory(root, "head").unknowns).toContain("No local verification history exists yet.");

  const first = historyRecordFromReport(report({ findings: [finding("f-1"), { ...finding("f-2"), resolution: "unknown" }] }), 42, undefined, 2, "local/coverage", "2026-01-01T00:00:00.000Z");
  appendHistory(root, first);
  appendHistory(root, { ...first, head: "other", toolVersion: "0.0.0" });
  fs.appendFileSync(path.join(root, ".pr-proof/history.jsonl"), "not-json\n{}\n");

  const details = readHistoryDetails(root);
  expect(details.records).toHaveLength(2);
  expect(details.malformedLines).toBe(1);
  expect(details.ignoredSchemaLines).toBe(1);
  expect(details.records[0]?.unknownRate).toBe(0.5);
  const comparison = compareHistory(root, "head");
  expect(comparison.current?.head).toBe("other");
  expect(comparison.matches).toHaveLength(1);
  expect(comparison.unknowns).toEqual(expect.arrayContaining([
    "1 malformed history record(s) were ignored.",
    "1 history record(s) used an unsupported schema.",
    "History contains records from a different PR Proof tool version.",
  ]));
});

test("baseline validation and comparison distinguish existing, waived, expired, new, and stale findings", () => {
  const fixture = initRepo("pr-proof-baseline-depth-");
  const existing = finding("existing");
  const waived = finding("waived", "test_assertion_removed", "src/waived.ts");
  const expired = finding("expired", "impact.unverified", "src/expired.ts");
  const newcomer = finding("new", "impact.new", "src/new.ts");
  const waivers = [
    { ruleId: "test_assertion_removed", path: "src/*.ts", reason: "Tracked separately", owner: "qa", createdAt: "2025-01-01T00:00:00.000Z" },
    { ruleId: expired.ruleId, path: "src/expired.ts", reason: "Expired exception", owner: "qa", createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2025-06-01T00:00:00.000Z" },
  ];
  const baseline = createBaseline("local/coverage", fixture.base, TOOL_VERSION, [existing, expired], waivers, new Date("2025-01-01T00:00:00.000Z"));
  const config = structuredClone(DEFAULT_CONFIG);
  const baselinePath = writeBaseline(fixture.root, config, baseline);
  expect(readBaseline(fixture.root, config)?.entries).toHaveLength(2);
  expect(baselinePath).toContain(".pr-proof");

  const comparison = compareBaseline(fixture.root, baseline, [existing, waived, expired, newcomer], fixture.head, "local/coverage", [], new Date("2026-01-01T00:00:00.000Z"));
  expect(comparison.stale).toBe(false);
  expect(comparison.existingCount).toBe(1);
  expect(comparison.waivedCount).toBe(1);
  expect(comparison.expiredWaiverCount).toBe(1);
  expect(comparison.newCount).toBe(2);
  expect(comparison.findings.map((item) => item.state)).toEqual(["existing", "waived", "expired", "new"]);
  expect(applyBaselineStates([existing, waived, expired, newcomer], comparison).map((item) => [item.baselineState, item.blocking, item.resolution])).toEqual([
    ["existing", false, "informational"],
    ["waived", false, "informational"],
    ["expired", true, "open"],
    ["new", true, "open"],
  ]);

  const stale = compareBaseline(fixture.root, { ...baseline, revision: "does-not-exist" }, [existing], fixture.head, "remote/repository");
  expect(stale.stale).toBe(true);
  expect(stale.unknowns.join(" ")).toMatch(/does not match|could not be resolved/);
  expect(() => writeBaseline(fixture.root, config, { ...baseline, entries: [baseline.entries[0]!, baseline.entries[0]!] })).toThrow(/duplicate/i);
  fs.writeFileSync(baselinePath, "{bad json");
  expect(() => readBaseline(fixture.root, config)).toThrow(/Invalid baseline file/);
});

test("git adapters cover revisions, file reads, renames, quoted paths, worktrees, and command execution", () => {
  const fixture = initRepo("pr-proof-git-depth-");
  expect(getRepoRoot(fixture.root)).toBe(fs.realpathSync(fixture.root));
  expect(resolveRevision(fixture.head, fixture.root)).toBe(fixture.head);
  expect(() => resolveRevision("missing-revision", fixture.root)).toThrow(/exited/);
  expect(listFilesAtRevision(fixture.head, fixture.root)).toContain("src/core.ts");
  expect(readFileAtRevision(fixture.head, "src/core.ts", fixture.root)).toContain("route");
  expect(readFileAtRevision(fixture.head, "missing.ts", fixture.root)).toBeUndefined();
  expect(readFileAtRevision(fixture.head, ".", fixture.root)).toBeUndefined();
  expect(getDiff(fixture.base, fixture.head, fixture.root).some((item) => item.path === "src/consumer.ts")).toBe(true);
  expect(createGitContext(fixture.root, fixture.base, fixture.head).diffs.length).toBeGreaterThan(0);

  const parsed = parseUnifiedDiff([
    'diff --git "a/old name.ts" "b/new name.ts"',
    "similarity index 90%",
    "rename from old name.ts",
    "rename to new name.ts",
    "diff --git a/added.ts b/added.ts",
    "new file mode 100644",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/deleted.ts b/deleted.ts",
    "deleted file mode 100644",
    "@@ -1,1 +0,0 @@",
    "-gone",
  ].join("\n"));
  expect(parsed.map((item) => item.status)).toEqual(["renamed", "added", "deleted"]);
  expect(parsed[1]?.changedLines).toEqual([1, 2]);
  expect(parsed[2]?.deletedLines).toEqual([1]);

  const edgeParsed = parseUnifiedDiff([
    "ignored before a header\r",
    "diff --git malformed\r",
    'diff --git "a/tab\\tname.ts" "b/tab\\tname.ts"\r',
    "@@ malformed\r",
    "@@ -1 +1 @@\r",
    " context\r",
    "-old\r",
    "+new\r",
    "\\ No newline at end of file\r",
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    "@@ -0,0 +0,0 @@",
  ].join("\n"));
  expect(edgeParsed.map((item) => item.path)).toEqual(["tab\tname.ts", "café.ts"]);
  expect(edgeParsed[0]?.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
  expect(parseUnifiedDiff('diff --git "a/foo\\q.ts" "b/foo\\q.ts"\n@@ -1 +1 @@\n-old\n+new')[0]?.path).toBe("fooq.ts");

  for (let index = 0; index < 130; index += 1) {
    const tag = `coverage-cache-${index}`;
    git(fixture.root, ["tag", tag, fixture.head]);
    expect(resolveRevision(tag, fixture.root)).toBe(fixture.head);
  }

  fs.renameSync(path.join(fixture.root, "src/core.ts"), path.join(fixture.root, "src/renamed.ts"));
  fs.unlinkSync(path.join(fixture.root, "src/dynamic.ts"));
  fs.writeFileSync(path.join(fixture.root, "src/added.ts"), "export const added = true;\n");
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["commit", "-q", "-m", "status variants"]);
  const statusHead = git(fixture.root, ["rev-parse", "HEAD"]);
  expect(getDiff(fixture.head, statusHead, fixture.root).map((item) => item.status)).toEqual(expect.arrayContaining(["added", "deleted", "renamed"]));

  fs.mkdirSync(path.join(fixture.root, "node_modules"));
  const worktree = makeTempWorktree(fixture.root, fixture.head);
  expect(fs.existsSync(path.join(worktree.directory, "src/core.ts"))).toBe(true);
  expect(fs.lstatSync(path.join(worktree.directory, "node_modules")).isSymbolicLink()).toBe(true);
  worktree.cleanup();
  worktree.cleanup();
  expect(() => makeTempWorktree(fixture.root, "missing-revision")).toThrow(/temporary worktree/);
  expect(runCommandAtRevision(fixture.root, fixture.head, "node -e \"process.stdout.write('ok')\"", 5)).toMatchObject({ status: 0, timedOut: false, stdout: "ok" });
  expect(runCommandAtRevision(fixture.root, fixture.head, "node -e \"process.stdout.write('shell')\"", 5, true)).toMatchObject({ status: 0, timedOut: false, stdout: "shell" });
  expect(runCommandAtRevision(fixture.root, fixture.head, "node 'unterminated", 5).error).toMatch(/unterminated/);
  expect(runCommandAtRevision(fixture.root, fixture.head, "definitely-missing-command", 5)).toMatchObject({ status: null, timedOut: false, signal: undefined });
});

test("reporters render complete and minimized views with escaping and explicit formats", () => {
  const rich = report({
    findings: [{ ...finding("rich", "assertion.removed", "src/a_[x].ts"), message: "line\nwith Bearer abc123", explanation: "explain *this*", suggestedAction: "fix [it]", startLine: 4, endLine: 5, column: 2, evidenceRefs: ["e-1"] }],
    testIntegrity: { findings: [finding("assertion", "assertion.removed")], newTests: 2, testsPassingOnBase: 1, coverage: { available: true, percentage: 75, changedLinesCoveredByModifiedTests: 2, coverageDelta: 1.5 }, mutation: { enabled: true, killed: 1, results: [{ status: "killed" }, { status: "survived" }], attempted: 2 } },
    impact: { changedSymbols: [{ name: "run", file: "src/core.ts", line: 1, kind: "function", change: "modified", exported: true }], downstreamConsumers: 1, impactedTests: 1, impactedPathsExecuted: 1, paths: [{ id: "p", sourceFile: "src/core.ts", sourceSymbol: "run", file: "src/consumer.ts", symbol: "consume", classification: "downstream", verificationState: "verified", testFiles: ["src/core.test.ts"], reason: "import" }], unverifiedPaths: [] },
    policy: { pack: "strict", rationale: "strict policy", unknownHandling: "fail" },
    baseline: { stale: true, newCount: 1, existingCount: 2, resolvedCount: 3, waivedCount: 4 },
    selection: { status: "partial", confidence: "medium", selected: ["src/core.test.ts"], related: [], unrelated: [], unknown: [], requiresFullSuite: true, fallback: "uncertain" },
    contracts: { filesAnalyzed: 1, changes: [] },
    fixtures: { filesAnalyzed: 1, snapshotFiles: [], findings: [] },
    artifacts: [{ type: "lcov", status: "parsed", completeness: "complete", records: [], unknowns: [], metrics: {}, source: "coverage.info" }],
    languages: [{ language: "typescript", files: 1, unknowns: [], capabilities: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["lcov"], mutation: ["stryker"] } }],
  });
  expect(renderTerminal(rich)).toContain("Baseline");
  expect(renderTerminal(rich)).toContain("Coverage delta from base");
  expect(renderMarkdown(rich)).toContain("src/a\\_\\[x\\].ts:1");
  expect(renderReviewContext(rich)).not.toContain("Bearer abc123");
  expect(renderSarif(rich)).toContain('"startLine": 4');
  for (const format of ["json", "markdown", "sarif", "review-context", "receipt", "change-assurance", "release-manifest", "terminal"] as const) expect(renderReport(rich, format)).toBeTruthy();
  expect(verdictEmoji("PASS")).toBe("✅");
  expect(verdictEmoji("NEEDS_REVIEW")).toBe("⚠️");
  expect(verdictEmoji("FAIL")).toBe("❌");
  expect(verdictEmoji("UNKNOWN")).toBe("❔");
});

test("coverage and artifact adapters classify valid, partial, malformed, and bounded evidence", () => {
  expect(detectArtifactType("coverage/lcov.info")).toBe("lcov");
  expect(detectArtifactType("coverage.out")).toBe("go-coverprofile");
  expect(detectArtifactType("x", 'mode: set\n')).toBe("go-coverprofile");
  expect(detectArtifactType("x.gcov")).toBe("gcov");
  expect(detectArtifactType("coverage-final.json")).toBe("istanbul");
  expect(detectArtifactType("x", '{"executed_lines":[1]}')).toBe("coverage.py");
  expect(detectArtifactType("x", '{"segments":[],"filename":"a.c"}')).toBe("llvm-cov");
  expect(detectArtifactType("results.xml")).toBe("junit");
  expect(detectArtifactType("mutation.json")).toBe("stryker");
  expect(detectArtifactType("results.sarif")).toBe("sarif");
  expect(detectArtifactType("vitest-results.json")).toBe("vitest");
  expect(detectArtifactType("jest-results.json")).toBe("jest");
  expect(detectArtifactType("x", '{"runs":[],"$schema":"sarif"}')).toBe("sarif");
  expect(detectArtifactType("x", "<testsuite></testsuite>")).toBe("junit");
  expect(detectArtifactType("unknown.txt", "{}")).toBe("generic");

  expect(parseArtifact("SF:src/a.ts\nDA:1,1\nDA:not-valid\n", "/tmp/a.info", "lcov").status).toBe("partial");
  expect(parseArtifact("not json", "/tmp/a.json", "istanbul").status).toBe("malformed");
  expect(parseArtifact("", "/tmp/a.gcov", "gcov").status).toBe("partial");
  expect(parseArtifact("mode: set\nbad\n", "/tmp/a.out", "go-coverprofile").status).toBe("partial");
  expect(parseArtifact("not json", "/tmp/a.json", "coverage.py").status).toBe("malformed");
  expect(parseArtifact("not json", "/tmp/a.json", "llvm-cov").status).toBe("malformed");
  expect(parseLcov("TN:\n", "/tmp/a.info").available).toBe(false);
  expect(parseIstanbulJson("not json", "/tmp/a.json").available).toBe(false);
  expect(parseGcov("", "/tmp/a.gcov").available).toBe(false);
  expect(parseGoCoverprofile("mode: set\nbad\n", "/tmp/a.out").available).toBe(false);
  expect(parseCoveragePyJson("not json", "/tmp/a.json").available).toBe(false);
  expect(parseLlvmCovJson("not json", "/tmp/a.json").available).toBe(false);
  expect(parseArtifact("[]", "results.json", "generic").metrics.records).toBe(0);
  expect(parseArtifact("not json", "results.json", "generic").status).toBe("malformed");
  const junit = parseArtifact("<testsuite><testcase name=\"ok\"/><testcase name=\"bad\"><failure/></testcase><testcase><skipped/></testcase></testsuite>", "results.xml", "junit");
  expect(junit.metrics.tests).toBe(3);
  expect(junit.metrics.failures).toBe(1);
  expect(parseArtifact(JSON.stringify({ testResults: [{ status: "passed" }, { status: "failed" }], numTotalTests: 2 }), "jest.json", "jest").metrics.failed).toBe(1);
  expect(parseArtifact(JSON.stringify({ testResults: [{ status: "passed" }] }), "vitest.json", "vitest").metrics.passed).toBe(1);
  expect(parseArtifact("bad", "jest.json", "jest").status).toBe("malformed");
  expect(parseArtifact(JSON.stringify({ runs: [{ results: [{ ruleId: "x" }] }, "bad"] }), "results.sarif", "sarif").metrics.findings).toBe(1);
  expect(parseArtifact("bad", "results.sarif", "sarif").status).toBe("malformed");
  expect(parseArtifact(JSON.stringify([{ id: "1", status: "Killed", fileName: "src/a.ts" }]), "mutation.json", "stryker").metrics.killed).toBe(1);
  expect(parseArtifact(JSON.stringify({ nope: true }), "mutation.json", "stryker").status).toBe("malformed");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-artifact-depth-"));
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ ok: true }));
  expect(loadArtifact(root, "results.json").status).toBe("parsed");
  expect(loadArtifact(root, "missing.json").status).toBe("missing");
  expect(loadArtifact(root, "../outside.json").status).toBe("missing");
  const oversized = path.join(root, "oversized.json");
  fs.writeFileSync(oversized, "{");
  fs.truncateSync(oversized, 16 * 1024 * 1024 + 1);
  expect(loadArtifact(root, "oversized.json").status).toBe("partial");
});

function coverage(available: boolean): CoverageReport {
  return { format: "lcov", available, percentage: available ? 100 : null, files: available ? { "src/core.ts": { lines: { 1: 1, 2: 0 } }, "src/consumer.ts": { lines: { 1: 1 } } } : {}, unknowns: available ? [] : ["missing coverage"] } as unknown as CoverageReport;
}

function diff(pathname: string, changedLines = [1]): FileDiff {
  return { path: pathname, status: "modified", additions: changedLines.length, deletions: 0, changedLines, deletedLines: [], hunks: [], patch: "" };
}

function languageDiff(file: string, patch: string): FileDiff {
  return parseUnifiedDiff(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${patch}`)[0]!;
}

test("test-integrity covers language-native assertions, test declarations, exclusions, and non-vacuity", () => {
  const languageDiffs = [
    languageDiff("tests/test_auth.py", "@@ -1,3 +1,9 @@\n-def test_auth():\n-    assert value == 1\n+@pytest.mark.skip\n+def test_auth():\n+    assert True\n+    with pytest.raises(ValueError):\n+        raise ValueError()\n+    mock.return_value = True\n+test.todo('later')"),
    languageDiff("pkg/auth_test.go", "@@ -1,2 +1,4 @@\n-func TestAuth(t *testing.T) { t.Error(\"bad\") }\n+func TestAuth(t *testing.T) { t.Log(\"ok\") }\n+func TestNew(t *testing.T) { require.Error(t, err) }\n+mockReturnValue(true)"),
    languageDiff("pkg/auth_test.go", "@@ -1,1 +1,1 @@\n-  t.Error(\"bad\")\n+  t.Log(\"ok\")"),
    languageDiff("tests/auth_test.rs", "@@ -1,2 +1,4 @@\n-#[test] fn test_auth() { assert_eq!(a, b); }\n+#[ignore] fn test_auth() { assert!(true); }\n+#[test] fn test_error() { panic!(\"bad\"); }"),
    languageDiff("test_auth.c", "@@ -1,2 +1,3 @@\n-TEST_ASSERT_EQUAL(1, value);\n+TEST_ASSERT(value);\n+ASSERT_THROW(call(), Error);"),
    languageDiff("test-auth.cpp", "@@ -1,2 +1,3 @@\n-EXPECT_EQ(1, value);\n+EXPECT_TRUE(value);\n+TEST_CASE(\"new\")"),
    languageDiff("src/inline_test.rs", "@@ -1,1 +1,2 @@\n+#[test] fn test_inline() { assert_ne!(a, b); }"),
  ];
  const result = analyzeTestDiffs(languageDiffs, process.cwd());
  expect(result.modifiedTests).toBeGreaterThanOrEqual(5);
  expect(result.newTests).toBeGreaterThan(0);
  expect(result.findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining([
    "assertion.weakened",
    "test.disabled",
    "test.todo-added",
    "mock.unconditional-success",
    "error-assertion.removed",
  ]));
  const explicit = { ...DEFAULT_CONFIG.languages, mode: "explicit" as const, include: ["typescript" as const], exclude: [] };
  expect(analyzeTestDiffs(languageDiffs, process.cwd(), explicit).findings).toHaveLength(0);

  const fixture = initRepo("pr-proof-integrity-depth-");
  const tsDiff = languageDiff("src/core.test.ts", "@@ -1,2 +1,4 @@\n import { run } from './core';\n+test('new regression', () => {\n+  expect(run(1)).toBe(2);\n+});");
  const config = structuredClone(DEFAULT_CONFIG);
  config.test_integrity.run_base_tests = false;
  config.framework.command = "node -e \"process.exit(0)\"";
  const noExecution = analyzeTestIntegrity(fixture.root, [tsDiff], config);
  expect(noExecution.unknowns).toEqual(expect.arrayContaining(["Base/head test execution was not requested."]));
  const executionConfig = structuredClone(config);
  executionConfig.test_integrity.run_base_tests = true;
  executionConfig.test_integrity.require_new_tests_fail_on_base = true;
  const execution = analyzeTestIntegrity(fixture.root, [tsDiff], executionConfig, { base: fixture.base, head: fixture.head, coverage: { format: "lcov", available: true, files: {}, unknowns: [] } as unknown as CoverageReport });
  expect(execution.nonVacuity[0]?.status).toBe("passes_on_base");
  expect(execution.unknowns).toContain("A configured new-test base failure requirement was not met.");
});

test("mutation adapters cover bounded scopes, unsupported languages, supplied results, cache safety, and command outcomes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-depth-"));
  const source = diff("src/value.ts");
  const testFile = diff("src/value.test.ts");
  expect(mutationScope([source, testFile])).toEqual(["src/value.ts"]);
  expect(normalizeMutationReport([{ id: "1", status: "not run", range: { start: { line: 3 } } }, { status: "unknown" }], 1)[0]?.status).toBe("not_run");
  const baseConfig = { enabled: true, max_mutants: 5, changed_lines_only: true, timeout_seconds: 5 };
  expect(runTargetedMutation({ root, diffs: [], config: baseConfig, base: "base", head: "head" }).notRun).toBe(1);
  expect(runTargetedMutation({ root, diffs: [source], config: { ...baseConfig, enabled: false }, base: "base", head: "head" }).limitation).toMatch(/disabled/);
  expect(runTargetedMutation({ root, diffs: [diff("src/value.py")], config: baseConfig, base: "base", head: "head" }).unknown).toBe(1);

  fs.writeFileSync(path.join(root, "bad-results.json"), "not-json");
  process.env.PR_PROOF_MUTATION_RESULTS = "bad-results.json";
  const malformed = runTargetedMutation({ root, diffs: [source], config: baseConfig, base: "base", head: "head" });
  delete process.env.PR_PROOF_MUTATION_RESULTS;
  expect(malformed.limitation).toMatch(/could not be parsed safely/);

  const unsafe = runTargetedMutation({ root, diffs: [source], config: { ...baseConfig, command: "node -e \\\"process.exit(1);\\\"" }, base: "base", head: "head" });
  expect(unsafe.unknown).toBe(1);
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports/mutation.json"), JSON.stringify([{ id: "killed", status: "killed", file: "src/value.ts", line: 1 }]));
  const successful = runTargetedMutation({ root, diffs: [source], config: { ...baseConfig, command: "node -e \\\"process.exit(0)\\\"" }, base: "base", head: "head" });
  expect(successful.killed).toBe(1);
});

test("contract, policy, and selection adapters cover compatibility and confidence branches", () => {
  const contractRepo = initRepo("pr-proof-contract-depth-");
  const baseContract = { openapi: "3.0.0", paths: { "/health": { get: { security: [{ oauth: [] }], parameters: [{ name: "id", in: "query", required: true }], responses: { "200": { content: { "application/json": { schema: { required: ["id"] } } } } } } } } };
  fs.writeFileSync(path.join(contractRepo.root, "openapi.json"), JSON.stringify(baseContract));
  git(contractRepo.root, ["add", "openapi.json"]);
  git(contractRepo.root, ["commit", "-q", "-m", "contract base"]);
  const contractBase = git(contractRepo.root, ["rev-parse", "HEAD"]);
  const headContract = { ...baseContract, paths: { "/health": { get: { security: [], parameters: [{ name: "id", in: "query", required: true }, { name: "tenant", in: "query", required: true }], responses: { "200": { content: { "application/json": { schema: { required: [] } } } } } } }, "/new": { post: { responses: { "201": { description: "created" } } } } } };
  fs.writeFileSync(path.join(contractRepo.root, "openapi.json"), JSON.stringify(headContract));
  fs.appendFileSync(path.join(contractRepo.root, "src/consumer.ts"), "fetch('/health');\n");
  git(contractRepo.root, ["add", "."]);
  git(contractRepo.root, ["commit", "-q", "-m", "contract head"]);
  const contractHead = git(contractRepo.root, ["rev-parse", "HEAD"]);
  const contractReport = analyzeContracts({ root: contractRepo.root, base: contractBase, head: contractHead, config: structuredClone(DEFAULT_CONFIG) });
  expect(contractReport.filesAnalyzed).toBeGreaterThan(0);
  expect(contractReport.changes.map((item) => item.kind)).toEqual(expect.arrayContaining(["breaking", "additive", "potentially_breaking"]));
  fs.writeFileSync(path.join(contractRepo.root, "openapi.json"), "{bad json");
  git(contractRepo.root, ["add", "openapi.json"]);
  git(contractRepo.root, ["commit", "-q", "-m", "malformed contract"]);
  const malformedHead = git(contractRepo.root, ["rev-parse", "HEAD"]);
  expect(analyzeContracts({ root: contractRepo.root, base: contractHead, head: malformedHead, config: structuredClone(DEFAULT_CONFIG) }).unknowns).toContain("Contract file openapi.json could not be parsed.");
  fs.writeFileSync(path.join(contractRepo.root, "openapi.json"), '{"paths":{"/ignored":null}}\n');
  git(contractRepo.root, ["add", "openapi.json"]);
  git(contractRepo.root, ["commit", "-q", "-m", "contract without paths"]);
  const noPathsHead = git(contractRepo.root, ["rev-parse", "HEAD"]);
  expect(analyzeContracts({ root: contractRepo.root, base: malformedHead, head: noPathsHead, config: structuredClone(DEFAULT_CONFIG) }).changes).toHaveLength(0);
  fs.unlinkSync(path.join(contractRepo.root, "openapi.json"));
  git(contractRepo.root, ["add", "-A"]);
  git(contractRepo.root, ["commit", "-q", "-m", "delete contract"]);
  const deletedHead = git(contractRepo.root, ["rev-parse", "HEAD"]);
  expect(analyzeContracts({ root: contractRepo.root, base: noPathsHead, head: deletedHead, config: structuredClone(DEFAULT_CONFIG) }).changes[0]?.kind).toBe("breaking");

  const warning = finding("policy-warning", "impact.unverified", "src/auth/service.ts");
  warning.severity = "warning";
  const disabled = { ...finding("policy-disabled", "mutation.survived"), category: "mutation" as const };
  const strict = applyPolicy([warning, disabled], getPolicyPack("public-api"), { unknowns: ["missing coverage"], sensitivePath: true });
  expect(strict.unknownHandling).toBe("fail");
  expect(strict.findings.find((item) => item.id === warning.id)?.severity).toBe("high");
  expect(strict.findings.find((item) => item.id === disabled.id)).toMatchObject({ resolution: "not_applicable", blocking: false });
  const excludedPack = { ...getPolicyPack("strict"), rules: [{ ...getPolicyPack("strict").rules[0]!, pathExclusions: ["src/ignored.ts"] }] };
  const excluded = applyPolicy([{ ...warning, file: "src/ignored.ts" }], excludedPack, { unknowns: [] });
  expect(excluded.findings[0]?.blocking).toBe(true);
  expect(() => getPolicyPack("missing")).toThrow(/Unknown policy pack/);

  const selectionRepo = initRepo("pr-proof-selection-depth-");
  for (const file of ["related.test.ts", "low.test.ts", "unrelated.test.ts"]) fs.writeFileSync(path.join(selectionRepo.root, "src", file), "test('case', () => {});\n");
  git(selectionRepo.root, ["add", "."]);
  git(selectionRepo.root, ["commit", "-q", "-m", "selection head"]);
  const selectionHead = git(selectionRepo.root, ["rev-parse", "HEAD"]);
  const impact = { filesAnalyzed: 1, symbolsAnalyzed: 1, changedSymbols: [], paths: [
    { id: "high", sourceFile: "src/core.ts", sourceSymbol: "run", file: "src/core.ts", symbol: "run", classification: "direct", reason: "verified", testFiles: ["src/core.test.ts"], verified: true, verificationState: "verified", modifiedByPr: true },
    { id: "medium", sourceFile: "src/core.ts", sourceSymbol: "run", file: "src/core.ts", symbol: "run", classification: "downstream", reason: "related", testFiles: ["src/related.test.ts"], verified: false, verificationState: "partially_verified", modifiedByPr: false },
    { id: "low", sourceFile: "src/core.ts", sourceSymbol: "run", file: "src/core.ts", symbol: "run", classification: "runtime_unknown", reason: "unknown", testFiles: ["src/low.test.ts"], verified: false, verificationState: "unknown", modifiedByPr: false },
  ], downstreamConsumers: 1, impactedTests: 3, impactedPathsExecuted: 1, unverifiedPaths: [], findings: [], unknowns: [] } as never;
  const selectionConfig = structuredClone(DEFAULT_CONFIG);
  selectionConfig.selection.confidence_threshold = "high";
  selectionConfig.selection.full_suite_on_unknown = false;
  const plan = selectTests({ root: selectionRepo.root, head: selectionHead, diffs: [diff("src/core.ts")], impact, config: selectionConfig });
  expect(plan.selected).toContain("src/core.test.ts");
  expect(plan.related).toContain("src/related.test.ts");
  expect(plan.unknown).toContain("src/low.test.ts");
  expect(plan.unrelated).toContain("src/unrelated.test.ts");
  const bounded = structuredClone(selectionConfig);
  bounded.limits.max_changed_files = 0;
  bounded.selection.full_suite_on_unknown = true;
  expect(selectTests({ root: selectionRepo.root, head: selectionHead, diffs: [diff("src/core.ts")], impact, config: bounded }).requiresFullSuite).toBe(true);
});

test("impact analysis reports direct, downstream, dynamic, route, coverage, and bounded states", () => {
  const fixture = initRepo("pr-proof-impact-depth-");
  const config = structuredClone(DEFAULT_CONFIG);
  config.validation.toolchain_checks = false;
  config.impact.include_routes = true;
  config.impact.max_dependency_depth = 3;
  const result = analyzeImpact({ root: fixture.root, base: fixture.base, head: fixture.head, diffs: [diff("src/core.ts", [1, 2]), diff("src/consumer.ts", [3])], config, coverage: coverage(true) });
  expect(result.changedSymbols.length).toBeGreaterThan(0);
  expect(result.paths.some((item) => item.classification === "downstream" || item.classification === "public_api")).toBe(true);
  expect(result.paths.some((item) => item.dynamic)).toBe(true);
  expect(result.unknowns).toContain("Dynamic imports or runtime references could not be resolved statically.");

  const noCoverage = analyzeImpact({ root: fixture.root, base: fixture.base, head: fixture.head, diffs: [diff("src/core.ts")], config, coverage: coverage(false) });
  expect(noCoverage.unknowns).toContain("No coverage artifact was available for impact verification.");
  expect(noCoverage.paths.some((item) => item.verificationState === "partially_verified" || item.verificationState === "unknown")).toBe(true);

  const limited = structuredClone(config);
  limited.limits.max_changed_files = 0;
  const large = analyzeImpact({ root: fixture.root, base: fixture.base, head: fixture.head, diffs: [diff("src/core.ts")], config: limited });
  expect(large.unknowns[0]).toMatch(/bounded because the diff/);
  expect(large.findings[0]?.ruleId).toBe("impact.large-diff-unknown");

  fs.writeFileSync(path.join(fixture.root, "src/core.ts"), "export const replacement = 1;\n");
  git(fixture.root, ["add", "src/core.ts"]);
  git(fixture.root, ["commit", "-q", "-m", "delete exported symbol"]);
  const deletionHead = git(fixture.root, ["rev-parse", "HEAD"]);
  const deletionDiffs = getDiff(fixture.head, deletionHead, fixture.root);
  const deleted = analyzeImpact({ root: fixture.root, base: fixture.head, head: deletionHead, diffs: deletionDiffs, config, coverage: coverage(false) });
  expect(deleted.changedSymbols.some((item) => item.change === "deleted")).toBe(true);
  expect(deleted.paths.some((item) => item.classification === "runtime_unknown")).toBe(true);
  fs.unlinkSync(path.join(fixture.root, "src/core.ts"));
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["commit", "-q", "-m", "delete source file"]);
  const fileDeletionHead = git(fixture.root, ["rev-parse", "HEAD"]);
  const fileDeleted = analyzeImpact({ root: fixture.root, base: deletionHead, head: fileDeletionHead, diffs: getDiff(deletionHead, fileDeletionHead, fixture.root), config, coverage: coverage(false) });
  expect(fileDeleted.changedSymbols.some((item) => item.change === "deleted")).toBe(true);
});

test("CLI dispatch is measured in-process across configuration, report, assurance, and evidence commands", () => {
  const fixture = initRepo("pr-proof-cli-depth-");
  const previous = process.cwd();
  process.chdir(fixture.root);
  try {
    expect(capture(() => runCli(["--help"])).code).toBe(0);
    expect(capture(() => runCli([])).code).toBe(0);
    expect(capture(() => runCli(["check", "--version"])).code).toBe(0);
    expect(capture(() => runCli(["--version"])).stdout).toContain("pr-proof");
    expect(capture(() => runCli(["policy", "list", "--format", "json"])).stdout).toContain("default");
    expect(capture(() => runCli(["policy", "explain", "strict", "--format", "json"])).stdout).toContain("unknownHandling");
    expect(capture(() => runCli(["config", "validate"])).code).toBe(0);
    expect(capture(() => runCli(["config", "explain", "--format", "json"])).stdout).toContain("framework");
    expect(capture(() => runCli(["artifacts", "--input", "missing.json"])).code).toBe(2);
    expect(capture(() => runCli(["history"])).code).toBe(2);
    expect(capture(() => runCli(["history", "compare", "head", "--format", "json"])).code).toBe(2);

    fs.writeFileSync(path.join(fixture.root, "report.json"), `${JSON.stringify(report({ repository: "local/coverage", base: fixture.base, head: fixture.head, findings: [], limitations: [] }))}\n`);
    expect(capture(() => runCli(["report", "--input", "report.json", "--format", "json", "--output", "out/report.json"])).code).toBe(0);
    expect(fs.existsSync(path.join(fixture.root, "out/report.json"))).toBe(true);
    expect(capture(() => runCli(["usage", "--format", "json"])).stdout).toContain("durationMs");

    const proof = capture(() => runCli(["proof", "create", "--input", "report.json", "--format", "json"]));
    expect(proof.code).toBe(0);
    const receipt = JSON.parse(proof.stdout) as { id: string };
    const receiptPath = `.tinkerbot/receipts/${receipt.id}.json`;
    expect(capture(() => runCli(["proof", "verify", "--input", receiptPath, "--format", "json"])).stdout).toContain("valid");
    expect(capture(() => runCli(["proof", "replay", "--input", receiptPath, "--format", "json"])).stdout).toContain("status");
    expect(capture(() => runCli(["evidence", "--input", "report.json", "--format", "review-context"])).stdout).toContain("limitations");

    const changeSet = { kind: "change-set", name: "demo", repositories: [{ repository: "local/coverage", pullRequests: [], commits: [], owners: [], evidenceState: "present" }], sharedApiReferences: [], dependencyRelationships: [], expectedMergeOrder: [] };
    fs.writeFileSync(path.join(fixture.root, "change-set.json"), JSON.stringify(changeSet));
    expect(capture(() => runCli(["change-set", "assess", "--input", "change-set.json", "--format", "json"])).stdout).toContain("ready");
    expect(capture(() => runCli(["change-set", "export", "--input", "change-set.json", "--format", "json"])).stdout).toContain("change-set");

    const outcome = { outcomeType: "incident_reference", observedAt: "2026-01-01T00:00:00.000Z", repository: "local/coverage", facts: { incident: "INC-1" } };
    fs.writeFileSync(path.join(fixture.root, "outcome.json"), JSON.stringify(outcome));
    expect(capture(() => runCli(["outcome", "record", "--input", "outcome.json", "--format", "json"])).stdout).toContain("runtime-outcome");
    expect(capture(() => runCli(["outcome", "export", "--format", "json"])).stdout).toContain("incident_reference");

    expect(capture(() => runCli(["config", "explain"])).stdout).toContain('"framework"');
    expect(capture(() => runCli(["history", "--format", "json"])).code).toBe(0);
    expect(capture(() => runCli(["history", "compare", fixture.head])).code).toBe(0);
    expect(capture(() => runCli(["proof", "verify", "--input", receiptPath])).stdout).toContain("Receipt verification");
    expect(capture(() => runCli(["proof", "replay", "--input", receiptPath])).stdout).toContain("replay preflight");
    expect(capture(() => runCli(["change-set", "assess", "--input", "change-set.json"])).stdout).toContain("Change Set assessment");
    expect(capture(() => runCli(["outcome", "record", "--input", "outcome.json"])).stdout).toContain("Outcome recorded");

    expect(capture(() => runCli(["proof", "create", "--input", "report.json", "--output", "receipt.txt"])).stdout).toBe("");
    const partialReceipt = createVerificationReceipt({ repository: "local/coverage", baseSha: fixture.base, headSha: fixture.head, report: report({ repository: "local/coverage", base: fixture.base, head: fixture.head, limitations: ["partial"] }) });
    fs.writeFileSync(path.join(fixture.root, "partial-receipt.json"), serializeReceipt(partialReceipt));
    expect(capture(() => runCli(["proof", "verify", "--input", "partial-receipt.json"])).code).toBe(2);
    expect(capture(() => runCli(["proof", "verify", "--input", receiptPath, "--repository", "other/repo"])).code).toBe(1);
    const blockedReceipt = createVerificationReceipt({ repository: "local/coverage", baseSha: fixture.base, headSha: fixture.head, replay: { dependencies: ["missing@1"] } });
    fs.writeFileSync(path.join(fixture.root, "blocked-receipt.json"), serializeReceipt(blockedReceipt));
    expect(capture(() => runCli(["proof", "replay", "--input", "blocked-receipt.json"])).code).toBe(1);
    const networkReceipt = createVerificationReceipt({ repository: "local/coverage", baseSha: fixture.base, headSha: fixture.head, replay: { networkRequired: true } });
    fs.writeFileSync(path.join(fixture.root, "network-receipt.json"), serializeReceipt(networkReceipt));
    expect(capture(() => runCli(["proof", "replay", "--input", "network-receipt.json"])).code).toBe(2);
    expect(capture(() => runCli(["proof"])).code).toBe(3);
    expect(capture(() => runCli(["proof", "verify"])).code).toBe(3);
    expect(capture(() => runCli(["history", "compare"])).code).toBe(3);
    expect(capture(() => runCli(["policy", "explain"])).code).toBe(3);
    expect(capture(() => runCli(["policy", "explain", "missing-policy"])).code).toBe(3);

    const invalidSet = { ...changeSet, repositories: [...changeSet.repositories, { repository: "consumer", pullRequests: [], commits: [], owners: [], evidenceState: "present" }], dependencyRelationships: [{ from: "local/coverage", to: "consumer", kind: "api", state: "unknown" }] };
    fs.writeFileSync(path.join(fixture.root, "invalid-change-set.json"), JSON.stringify(invalidSet));
    expect(capture(() => runCli(["change-set", "assess", "--input", "invalid-change-set.json"])).code).toBe(1);
    const unknownSet = { ...changeSet, dependencyRelationships: [{ from: "local/coverage", to: "missing/repo", kind: "api", state: "unknown" }] };
    fs.writeFileSync(path.join(fixture.root, "unknown-change-set.json"), JSON.stringify(unknownSet));
    expect(capture(() => runCli(["change-set", "assess", "--input", "unknown-change-set.json"])).code).toBe(2);
    fs.writeFileSync(path.join(fixture.root, "invalid-kind.json"), "{}\n");
    expect(capture(() => runCli(["change-set", "assess", "--input", "invalid-kind.json"])).code).toBe(3);

    const readyManifest = createReleaseManifest({ releaseId: "ready", includedRepositories: [], policyStatus: "present", externalEvidenceRefs: ["deployment"] });
    fs.writeFileSync(path.join(fixture.root, "ready-manifest.json"), JSON.stringify({ manifest: readyManifest }));
    expect(capture(() => runCli(["release", "assess", "--input", "ready-manifest.json"])).code).toBe(0);
    const partialManifest = createReleaseManifest({ releaseId: "partial", includedRepositories: [], policyStatus: "present", externalEvidenceRefs: ["deployment"], featureFlags: [{ reference: "flag", state: "present" }] });
    fs.writeFileSync(path.join(fixture.root, "partial-manifest.json"), JSON.stringify(partialManifest));
    expect(capture(() => runCli(["release", "assess", "--input", "partial-manifest.json"])).code).toBe(2);
    expect(capture(() => runCli(["release", "assess", "--input", "invalid-kind.json"])).code).toBe(3);

    const fullOutcome = createRuntimeOutcome({ outcomeType: "successful_release", observedAt: "2026-01-02T00:00:00.000Z" });
    fs.writeFileSync(path.join(fixture.root, "full-outcome.json"), JSON.stringify(fullOutcome));
    expect(capture(() => runCli(["outcome", "record", "--input", "full-outcome.json"])).code).toBe(0);

    const assurance = createAssuranceBundle({ repository: "local/coverage", base: fixture.base, head: fixture.head, report: report({ repository: "local/coverage", base: fixture.base, head: fixture.head }) });
    fs.writeFileSync(path.join(fixture.root, "assurance.json"), JSON.stringify(assurance));
    expect(capture(() => runCli(["evidence", "--input", "assurance.json", "--format", "change-assurance"])).code).toBe(0);

    fs.writeFileSync(path.join(fixture.root, "generic.json"), JSON.stringify({ records: [{ id: 1 }] }));
    expect(capture(() => runCli(["artifacts", "--input", "generic.json", "--type", "generic"])).stdout).toContain("Artifact:");

    const overridden = createReport({ cwd: fixture.root, base: fixture.base, head: fixture.head, runBaseTests: false, runMutation: false, mode: "blocking", failOn: ["rule"], mutationMax: 0, comment: false, checkRun: false, sarif: false, policy: "default", timeout: 2, maxFiles: 2, maxFindings: 2 });
    expect(overridden.repository).toBe("local");
    git(fixture.root, ["remote", "add", "origin", "https://token@example.com/acme/project.git"]);
    expect(createReport({ cwd: fixture.root, base: fixture.base, runBaseTests: false, runMutation: true }).repository).toBe("example.com/acme/project");
    expect(() => createReport({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-no-repo-")) })).toThrow();
    fs.writeFileSync(path.join(fixture.root, "failed-report.json"), JSON.stringify(report({ repository: "local", base: fixture.base, head: fixture.head, verdict: "FAIL", findings: [finding("blocking")] })));
    expect(capture(() => runCli(["report", "--input", "failed-report.json", "--mode", "blocking"])).code).toBe(1);
  } finally {
    process.chdir(previous);
  }
});

test("CLI runs analysis, repository, contract, selection, release, and parser error paths in-process", () => {
  const fixture = initRepo("pr-proof-cli-analysis-depth-");
  const previous = process.cwd();
  process.chdir(fixture.root);
  const revisionArgs = ["--base", fixture.base, "--head", fixture.head, "--no-base-tests", "--no-mutation", "--format", "json"];
  try {
    expect(capture(() => runCli(["check", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["impact", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["test-integrity", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["select-tests", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["contracts", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["fixtures", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["repo", "inspect", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["repo", "map", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["change", "assess", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["change", "contract", "validate", "--format", "json"])).code).toBe(2);
    expect(capture(() => runCli(["change", "contract", "assess", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["policy", "simulate", "--format", "json"])).stdout).toContain("simulation");
    expect(capture(() => runCli(["policy", "list"])).stdout).toContain("default:");
    expect(capture(() => runCli(["policy", "explain", "default"])).stdout).toContain("Default");

    fs.writeFileSync(path.join(fixture.root, "mutation-results.json"), JSON.stringify([
      { id: "survived", status: "survived", file: "src/core.ts", line: 1, description: "changed increment" },
      { id: "timeout", status: "timeout", file: "src/core.ts", line: 1 },
      { id: "no-coverage", status: "no_coverage", file: "src/core.ts", line: 1 },
    ]));
    process.env.PR_PROOF_MUTATION_RESULTS = "mutation-results.json";
    const mutationRun = capture(() => runCli(["check", ...revisionArgs, "--mutation-enabled", "true", "--policy", "strict", "--max-files", "1", "--max-findings", "2", "--timeout", "1"]));
    delete process.env.PR_PROOF_MUTATION_RESULTS;
    expect(mutationRun.code).toBeLessThan(3);
    expect(mutationRun.stdout).toContain("mutation");

    expect(capture(() => runCli(["baseline", "init", ...revisionArgs])).code).toBe(0);
    expect(capture(() => runCli(["baseline", "check", ...revisionArgs])).code).toBeLessThan(3);
    expect(capture(() => runCli(["baseline", "update", ...revisionArgs])).code).toBe(0);
    expect(capture(() => runCli(["baseline", "init", ...revisionArgs])).code).toBe(3);

    const manifest = { kind: "release-manifest", releaseId: "release-depth", includedRepositories: [], requiredReceiptIds: [], policyStatus: "unknown", migrationSequence: [], featureFlags: [], deploymentDependencies: [], rollbackReferences: [], requiredRunbooks: [], requiredApprovals: [], externalEvidenceRefs: [] };
    fs.writeFileSync(path.join(fixture.root, "manifest.json"), JSON.stringify(manifest));
    expect(capture(() => runCli(["release", "manifest", "--input", "manifest.json", "--format", "json"])).stdout).toContain("release-manifest");
    expect(capture(() => runCli(["release", "assess", "--input", "manifest.json", "--format", "json"])).code).toBe(2);
    expect(capture(() => runCli(["release", "assess", "--input", "manifest.json"])).stdout).toContain("Release safety assessment");
    expect(capture(() => runCli(["repo", "inspect", "--base", fixture.base, "--head", fixture.head])).stdout).toContain("Repository assurance");
    expect(capture(() => runCli(["repo", "map", "--base", fixture.base, "--head", fixture.head])).stdout).toContain("Verification graph");
    expect(capture(() => runCli(["change", "contract", "validate"])).stdout).toContain("Change contract");
    expect(capture(() => runCli(["change", "assess", "--base", fixture.base, "--head", fixture.head])).stdout).toContain("Change contract assessment");
    expect(capture(() => runCli(["policy", "simulate"])).stdout).toContain("Policy simulation");
    expect(capture(() => runCli(["select-tests", "--base", fixture.base, "--head", fixture.head])).stdout).toContain("Test selection");

    expect(capture(() => runCli(["artifacts"])).code).toBe(3);
    expect(capture(() => runCli(["artifacts", "--input", "manifest.json", "--type", "invalid"])).code).toBe(3);
    expect(capture(() => runCli(["main-does-not-exist"])).code).toBe(3);
    expect(capture(() => runCli(["--unknown"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--mode", "invalid"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--format", "invalid"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--mutation-enabled", "maybe"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--mutation-max", "-1"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--timeout", "0"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--max-files", "0"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--port", "0"])).code).toBe(3);
    expect(capture(() => runCli(["check", "--base"])).code).toBe(3);
    expect(capture(() => runCli(["main-does-not-exist", "--help"])).code).toBe(0);
    fs.writeFileSync(path.join(fixture.root, ".pr-proof/usage.json"), "{}\n");
    expect(capture(() => runCli(["usage"])).code).toBe(2);
    expect(capture(() => runCli(["main-does-not-exist"])).stderr).toContain("error");
    expect(capture(() => runCli(["report", "--input", "missing.json"])).code).toBe(3);
    fs.writeFileSync(path.join(fixture.root, "unapplied.json"), JSON.stringify(report({ base: "missing", head: "missing" })));
    expect(capture(() => runCli(["evidence", "--input", "unapplied.json", "--format", "json"])).code).toBeLessThan(3);
    expect(capture(() => runCli(["--help"])).code).toBe(0);
    expect(capture(() => main(["--help"])).code).toBe(0);
  } finally {
    process.chdir(previous);
  }
});

test("doctor reports healthy and blocked repository states with rendered diagnostics", () => {
  const fixture = initRepo("pr-proof-doctor-depth-");
  const healthy = runDoctor(fixture.root, undefined, fixture.base, fixture.head);
  expect(healthy.checks.length).toBeGreaterThan(5);
  expect(healthy.checks.some((item) => item.name === "Repository" && item.status === "pass")).toBe(true);
  expect(renderDoctor(healthy)).toContain("PR Proof doctor");
  const blocked = runDoctor(fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-doctor-no-repo-")));
  expect(blocked.healthy).toBe(false);
  expect(renderDoctor(blocked)).toContain("Doctor status: blocked");

  fs.writeFileSync(path.join(fixture.root, "pr-proof.yml"), "test_integrity:\n  mutation_testing:\n    enabled: true\n    command: custom-mutator\n");
  fs.writeFileSync(path.join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(path.join(fixture.root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(fixture.root, "action.yml"), "name: PR Proof\n");
  fs.mkdirSync(path.join(fixture.root, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, ".github/workflows/unsafe.yml"), "on: pull_request_target\n");
  fs.mkdirSync(path.join(fixture.root, "coverage"));
  fs.writeFileSync(path.join(fixture.root, "coverage/lcov.info"), "TN:\nSF:src/core.ts\nDA:1,1\nend_of_record\n");
  const previousCi = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  const configured = runDoctor(fixture.root, "pr-proof.yml", "missing-base", fixture.head);
  if (previousCi === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previousCi;
  expect(configured.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Package manager", status: "pass" }),
    expect.objectContaining({ name: "TypeScript configuration", status: "pass" }),
    expect.objectContaining({ name: "Mutation adapter", status: "pass" }),
    expect.objectContaining({ name: "Coverage", status: "pass" }),
    expect.objectContaining({ name: "Action configuration", status: "fail" }),
    expect.objectContaining({ name: "CI environment", status: "pass" }),
  ]));
  fs.writeFileSync(path.join(fixture.root, ".github/workflows/unsafe.yml"), "on:\n  pull_request:\n");
  expect(runDoctor(fixture.root, "pr-proof.yml", fixture.base, fixture.head).checks).toContainEqual(expect.objectContaining({ name: "Action configuration", status: "pass" }));
  fs.writeFileSync(path.join(fixture.root, "invalid.yml"), "version: 2\n");
  expect(runDoctor(fixture.root, "invalid.yml").checks).toContainEqual(expect.objectContaining({ name: "Configuration", status: "fail" }));
  fs.unlinkSync(path.join(fixture.root, "pnpm-lock.yaml"));
  fs.writeFileSync(path.join(fixture.root, "yarn.lock"), "# yarn\n");
  expect(runDoctor(fixture.root, "pr-proof.yml", fixture.base, fixture.head).checks).toContainEqual(expect.objectContaining({ name: "Package manager", detail: expect.stringContaining("yarn") }));
  fs.unlinkSync(path.join(fixture.root, "yarn.lock"));
  fs.writeFileSync(path.join(fixture.root, "package-lock.json"), "{}\n");
  expect(runDoctor(fixture.root, "pr-proof.yml", fixture.base, fixture.head).checks).toContainEqual(expect.objectContaining({ name: "Package manager", detail: expect.stringContaining("npm") }));
});

test("local control-plane server handles safe request methods without binding a socket", () => {
  const root = path.resolve("apps/control-plane");
  expect(() => createControlPlaneServer({ directory: root, port: 65_536 })).toThrow(/port/);
  const server = createControlPlaneServer({ directory: root, port: 0 });
  const defaultServer = createControlPlaneServer({ directory: root });
  defaultServer.close();
  const responses: Array<{ status?: number; body?: string }> = [];
  const response = { writeHead(status: number) { responses.push({ status }); return this; }, end(body?: string) { responses[responses.length - 1]!.body = body; return this; }, destroy() { return this; } };
  server.emit("request", { method: "HEAD", url: "/" }, response);
  server.emit("request", { method: "POST", url: "/" }, response);
  server.emit("request", { method: "GET", url: "/missing.js" }, response);
  server.emit("request", { method: "HEAD" }, response);
  expect(responses.map((item) => item.status)).toEqual([200, 405, 404, 200]);
  const stream = { on: vi.fn(), pipe: vi.fn() };
  stream.on.mockReturnValue(stream);
  const streamSpy = vi.spyOn(fs, "createReadStream").mockReturnValue(stream as unknown as fs.ReadStream);
  server.emit("request", { method: "GET", url: "/" }, response);
  expect(stream.on).toHaveBeenCalledWith("error", expect.any(Function));
  expect(stream.pipe).toHaveBeenCalledWith(response);
  streamSpy.mockRestore();
  server.close();
});

test("TUI launcher resolves configured entries, forwards options, and reports runtime failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-tui-launch-"));
  const entry = path.join(root, "entry.js");
  fs.writeFileSync(entry, "process.exit(process.argv.includes('--base') ? 0 : 2);\n");
  const previousEntry = process.env.TINKERBOT_TUI_ENTRY;
  const previousRuntime = process.env.TINKERBOT_TUI_RUNTIME;
  try {
    process.env.TINKERBOT_TUI_ENTRY = entry;
    process.env.TINKERBOT_TUI_RUNTIME = process.execPath;
    expect(runTui({ cwd: root, base: "base", head: "head", config: "config.yml" })).toBe(0);
    expect(runTui()).toBe(2);
    expect(capture(() => runCli(["tui", "--base", "base", "--head", "head", "--config", "config.yml"])).code).toBe(0);
    delete process.env.TINKERBOT_TUI_RUNTIME;
    expect(runTui({ cwd: root })).toBe(2);
    process.env.TINKERBOT_TUI_RUNTIME = process.execPath;
    process.env.TINKERBOT_TUI_RUNTIME = "definitely-missing-tui-runtime";
    expect(capture(() => runTui({ cwd: root })).code).toBe(4);
    delete process.env.TINKERBOT_TUI_ENTRY;
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(capture(() => runTui({ cwd: root })).code).toBe(4);
    exists.mockRestore();
  } finally {
    if (previousEntry === undefined) delete process.env.TINKERBOT_TUI_ENTRY; else process.env.TINKERBOT_TUI_ENTRY = previousEntry;
    if (previousRuntime === undefined) delete process.env.TINKERBOT_TUI_RUNTIME; else process.env.TINKERBOT_TUI_RUNTIME = previousRuntime;
  }
});

test("CLI argument and subcommand validation covers every public option family", () => {
  const exhaustive = capture(() => runCli([
    "check", "--no-mutation", "--no-base-tests", "--base", "HEAD", "--head", "HEAD",
    "--json", "--config", "config.yml", "--output", "report.json", "--input", "input.json",
    "--mode", "advisory", "--fail-on", "one, two", "--mutation-enabled", "false",
    "--mutation-max", "0", "--comment", "no", "--check-run", "off", "--sarif", "0",
    "--policy", "default", "--timeout", "1", "--max-files", "1", "--max-findings", "1",
    "--type", "generic", "--port", "1", "--host", "127.0.0.1", "--directory", ".",
    "--repository", "acme/example", "--verbose", "--unknown",
  ]));
  expect(exhaustive.code).not.toBe(0);
  expect(exhaustive.stderr).toMatch(/Unknown option/);

  const trueBooleans = capture(() => runCli(["check", "--mutation-enabled", "yes", "--comment", "on", "--check-run", "1", "--sarif", "true", "--unknown"]));
  expect(trueBooleans.stderr).toMatch(/Unknown option/);

  const invalidArguments = [
    ["check", "--base"],
    ["check", "--mode", "unsafe"],
    ["check", "--mutation-enabled", "maybe"],
    ["check", "--mutation-max", "-1"],
    ["check", "--timeout", "0"],
    ["check", "--max-files", "0"],
    ["check", "--max-findings", "NaN"],
    ["check", "--port", "65536"],
    ["check", "--format", "xml"],
    ["check", "unexpected"],
    ["serve", "--format", "json"],
    ["config", "unknown"],
    ["baseline", "unknown"],
    ["policy", "unknown"],
    ["history", "unknown"],
    ["proof", "unknown"],
    ["repo", "unknown"],
    ["change", "unknown"],
    ["change", "contract", "unknown"],
    ["change-set", "unknown"],
    ["release", "unknown"],
    ["outcome", "unknown"],
    ["evidence", "unknown"],
  ];
  for (const argv of invalidArguments) {
    const result = capture(() => runCli(argv));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("configuration error");
  }
  expect(capture(() => runCli(["-V"])).stdout).toContain("pr-proof");
  expect(capture(() => runCli(["check", "-h"])).stdout).toContain("Usage");
  for (const command of ["tui", "serve", "proof", "repo", "change", "change-set", "release", "outcome", "evidence", "impact", "contracts", "fixtures", "select-tests", "artifacts", "config"]) {
    expect(capture(() => runCli([command, "--help"])).code).toBe(0);
  }
});
