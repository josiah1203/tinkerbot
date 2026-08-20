import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, calculateVerdict, finalizeReport, findingFingerprint, resolveRepositoryPath, tokenizeCommand } from "../packages/core/src";
import { makeTempWorktree, parseUnifiedDiff, runCommandAtRevision } from "../packages/git/src";
import { parseIstanbulJson, parseLcov } from "../packages/coverage/src";
import { parseArtifact, loadArtifact } from "../packages/artifacts/src";
import { parseSource } from "../packages/parser/src";
import { readHistoryDetails } from "../packages/history/src";
import { renderMarkdown, renderSarif } from "../packages/reporters/src";
import { safeControlPlaneFilePath } from "../packages/cli/src/serve";
import type { Finding, PrProofReport } from "../packages/core/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding:one",
    ruleId: "impact.unverified",
    category: "impact",
    severity: "warning",
    file: "src/example.ts",
    line: 2,
    message: "A changed path needs review",
    explanation: "Evidence is incomplete.",
    suggestedAction: "Add a focused test.",
    confidence: "medium",
    blocking: false,
    ...overrides,
  };
}

function report(findings: Finding[], verdict: PrProofReport["verdict"] = "PASS"): PrProofReport {
  return {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    repository: "fixture",
    base: "base-sha",
    head: "head-sha",
    verdict,
    summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
    findings,
    limitations: [],
  };
}

test("safe command tokenization preserves quoted arguments and rejects shell operators", () => {
  expect(tokenizeCommand('node -e "process.exit(1)"')).toEqual(["node", "-e", "process.exit(1)"]);
  expect(tokenizeCommand("pnpm test --run")).toEqual(["pnpm", "test", "--run"]);
  expect(() => tokenizeCommand("node -e 'process.exit(1)'; touch leaked")).toThrow(/shell control/);
  expect(() => tokenizeCommand('node -e "unterminated')).toThrow(/unterminated/);
});

test("repository paths reject traversal and symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-paths-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-outside-"));
  fs.mkdirSync(path.join(root, "safe"));
  expect(resolveRepositoryPath(root, "safe/output.json")).toBe(path.join(root, "safe/output.json"));
  expect(() => resolveRepositoryPath(root, "../outside/output.json")).toThrow(/escapes/);
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    expect(() => resolveRepositoryPath(root, "linked/output.json")).toThrow(/outside/);
  } catch {
    // Symlinks can be unavailable in restricted Windows runners; traversal is still covered above.
  }
});

test("Git diff parsing keeps binary, rename, spaces, and CRLF inputs deterministic", () => {
  const raw = [
    "diff --git a/src/space name.ts b/src/space name.ts\r",
    "--- a/src/space name.ts\r",
    "+++ b/src/space name.ts\r",
    "@@ -1 +1 @@\r",
    "-const old = true;\r",
    "+const next = true;\r",
    "diff --git a/assets/blob.bin b/assets/blob.bin\r",
    "new file mode 100644\r",
    "Binary files /dev/null and b/assets/blob.bin differ\r",
  ].join("\n");
  const parsed = parseUnifiedDiff(raw);
  expect(parsed.map((diff) => diff.path)).toEqual(["src/space name.ts", "assets/blob.bin"]);
  expect(parsed[0]?.changedLines).toEqual([1]);
  expect(parsed[1]?.hunks).toHaveLength(0);
  expect(JSON.stringify(parseUnifiedDiff(raw))).toBe(JSON.stringify(parseUnifiedDiff(raw)));
});

test("revision commands use safe argv, scrub secret environment, time out, and clean up worktrees", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-command-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const revision = git(root, ["rev-parse", "HEAD"]);
  process.env.PR_PROOF_STABILITY_SECRET = "should-not-reach-child";
  const safe = runCommandAtRevision(root, revision, 'node -e "process.exit(process.env.PR_PROOF_STABILITY_SECRET ? 1 : 0)"', 5);
  delete process.env.PR_PROOF_STABILITY_SECRET;
  expect(safe.status).toBe(0);
  const timedOut = runCommandAtRevision(root, revision, "node -e 'setTimeout(function(){}, 30000)'", 1);
  expect(timedOut.timedOut).toBe(true);
  const worktree = makeTempWorktree(root, revision);
  const directory = worktree.directory;
  worktree.cleanup();
  worktree.cleanup();
  expect(fs.existsSync(directory)).toBe(false);
});

test("tb check verdicts are PASS, FAIL, or UNKNOWN", () => {
  const advisory = structuredClone(DEFAULT_CONFIG);
  expect(calculateVerdict([], advisory, [])).toBe("PASS");
  expect(calculateVerdict([], advisory, ["coverage unavailable"])).toBe("UNKNOWN");
  expect(calculateVerdict([baseFinding({ severity: "warning" })], advisory, [])).toBe("UNKNOWN");
  const blocking = structuredClone(DEFAULT_CONFIG);
  blocking.test_integrity.mode = "blocking";
  expect(calculateVerdict([baseFinding({ severity: "high", blocking: true })], blocking, [])).toBe("FAIL");
});

test("report finalization deduplicates independent insertion order and bounds evidence", () => {
  const longEvidence = "x".repeat(20_000);
  const left = baseFinding({ id: "z", line: 8, evidence: { detail: longEvidence } });
  const right = baseFinding({ id: "a", line: 2, evidence: { detail: longEvidence } });
  const first = finalizeReport(report([left, right]));
  const second = finalizeReport(report([right, left]));
  expect(first.findings).toHaveLength(1);
  expect(first.findings[0]?.evidence?.detail?.length).toBeLessThan(8_193);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(findingFingerprint(left)).toBe(findingFingerprint(right));
});

test("coverage adapters preserve malformed and outside-path uncertainty without fabricating coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-coverage-"));
  const lcov = parseLcov("SF:src/a.ts\nDA:2,1\nDA:not-a-line,1\nend_of_record\nSF:../secret.ts\nDA:1,1\nend_of_record\n", root);
  expect(lcov.available).toBe(true);
  expect(lcov.files["src/a.ts"]?.lines[2]).toBe(1);
  expect(lcov.unknowns?.length).toBeGreaterThan(0);
  const malformed = parseIstanbulJson("{not-json", root);
  expect(malformed.available).toBe(false);
  expect(malformed.unknowns?.[0]).toMatch(/could not be parsed/);
});

test("artifact loading and parser diagnostics make unsupported input explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-artifact-"));
  fs.writeFileSync(path.join(root, "result.json"), "null\n");
  expect(loadArtifact(root, "result.json").status).toBe("parsed");
  expect(loadArtifact(root, "../result.json").status).toBe("missing");
  const malformed = parseArtifact("null", "results.sarif", "sarif");
  expect(malformed.status).toBe("malformed");
  const parsed = parseSource("src/broken.ts", "export function broken( {", root);
  expect(parsed.unknowns.length).toBeGreaterThan(0);
});

test("reporters escape hostile text and omit fake SARIF locations", () => {
  const finding = baseFinding({ file: "tests/[evil]|name.ts", message: "bad\n::error file=secret.ts::leak", line: undefined });
  const rendered = renderMarkdown(report([finding], "UNKNOWN"));
  expect(rendered).not.toContain("\n::error");
  expect(rendered).toContain("tests/\\[evil\\]\\|name.ts");
  const sarif = JSON.parse(renderSarif(finalizeReport(report([baseFinding({ file: "repository", line: undefined })])))) as { runs: Array<{ results: Array<{ locations?: unknown[] }> }> };
  expect(sarif.runs[0]?.results[0]?.locations).toBeUndefined();
});

test("history diagnostics expose malformed prior records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-history-"));
  fs.mkdirSync(path.join(root, ".pr-proof"));
  fs.writeFileSync(path.join(root, ".pr-proof/history.jsonl"), "{not-json\n" + JSON.stringify({ schemaVersion: 1, repository: "fixture", base: "base", head: "head", toolVersion: "old", recordedAt: new Date().toISOString(), verdict: "PASS", findingsByRule: {} }) + "\n");
  const details = readHistoryDetails(root);
  expect(details.records).toHaveLength(1);
  expect(details.malformedLines).toBe(1);
});

test("stability fixture manifest remains structured and bounded", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("fixtures/stability/manifest.json"), "utf8")) as Array<Record<string, unknown>>;
  expect(Array.isArray(manifest)).toBe(true);
  expect(manifest.length).toBeGreaterThanOrEqual(12);
  for (const scenario of manifest) {
    expect(typeof scenario.area).toBe("string");
    expect(typeof scenario.scenario).toBe("string");
    expect(Array.isArray(scenario.expectedFindings)).toBe(true);
    expect(["PASS", "UNKNOWN", "FAIL"]).toContain(scenario.expectedVerdict);
    expect(Array.isArray(scenario.expectedUnknowns)).toBe(true);
    expect(Number.isInteger(scenario.expectedExitCode)).toBe(true);
  }
});

test("local control-plane path serving rejects traversal and resolves the preview shell", () => {
  const root = path.resolve("apps/control-plane");
  expect(safeControlPlaneFilePath(root, "/")).toBe(path.join(root, "index.html"));
  expect(safeControlPlaneFilePath(root, "/app.js")).toBe(path.join(root, "app.js"));
  expect(safeControlPlaneFilePath(root, "/app/overview")).toBe(path.join(root, "app/overview"));
  expect(safeControlPlaneFilePath(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  expect(safeControlPlaneFilePath(root, "/%E0%A4%A")).toBeNull();
  expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toContain("app.js");
  expect(fs.existsSync(path.join(root, "app.js"))).toBe(true);
});
