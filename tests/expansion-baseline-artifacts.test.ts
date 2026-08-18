import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyBaselineStates, compareBaseline, createBaseline } from "../packages/baseline/src";
import { parseArtifact } from "../packages/artifacts/src";
import type { Finding } from "../packages/core/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "test:finding",
    ruleId: "impact.unverified",
    category: "impact",
    severity: "high",
    file: "src/session.ts",
    line: 4,
    message: "Changed path is not verified",
    explanation: "The test graph did not verify the changed path.",
    suggestedAction: "Add a focused test.",
    confidence: "medium",
    blocking: true,
    ...overrides,
  };
}

test("baseline comparison distinguishes existing, new, resolved, expired, stale, and renamed findings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-baseline-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.writeFileSync(path.join(root, "src.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(root, "src.txt"), "head\n");
  git(root, ["commit", "-qam", "head"]);
  const base = git(root, ["rev-parse", "HEAD~1"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const existing = finding();
  const resolved = finding({ id: "resolved", file: "src/resolved.ts", message: "Resolved path is not verified" });
  const baseline = createBaseline("local", base, "0.1.0", [existing, resolved]);
  const renamed = finding({ file: "src/renamed-session.ts" });
  baseline.entries.find((entry) => entry.file === existing.file)!.aliases = [renamed.file!];
  baseline.waivers = [{ ruleId: "fixture.snapshot-deleted", reason: "Tracked migration", owner: "team", createdAt: "2025-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }];
  const waiverFinding = finding({ ruleId: "fixture.snapshot-deleted", category: "fixture", file: "tests/__snapshots__/a.snap", message: "Snapshot file deleted" });
  const expiredFinding = finding({ ruleId: "fixture.snapshot-churn", category: "fixture", file: "tests/__snapshots__/b.snap", message: "Large snapshot change" });
  baseline.waivers.push({ ruleId: expiredFinding.ruleId, reason: "Temporary", owner: "team", createdAt: "2025-01-01T00:00:00Z", expiresAt: "2025-01-02T00:00:00Z" });
  const comparison = compareBaseline(root, baseline, [existing, finding({ id: "new", file: "src/new.ts" }), renamed, waiverFinding, expiredFinding], head, "local", [], new Date("2026-01-01T00:00:00Z"));
  expect(comparison.stale).toBe(false);
  expect(comparison.existingCount).toBe(2);
  expect(comparison.newCount).toBe(2);
  expect(comparison.waivedCount).toBe(1);
  expect(comparison.expiredWaiverCount).toBe(1);
  expect(comparison.resolvedCount).toBe(1);
  const states = new Map(comparison.findings.map((item) => [item.ruleId + ":" + item.file, item.state]));
  expect(states.get("impact.unverified:src/session.ts")).toBe("existing");
  expect(states.get("fixture.snapshot-deleted:tests/__snapshots__/a.snap")).toBe("waived");
  expect(states.get("fixture.snapshot-churn:tests/__snapshots__/b.snap")).toBe("expired");
  expect(applyBaselineStates([existing], comparison)[0].blocking).toBe(false);

  const stale = compareBaseline(root, { ...baseline, revision: "not-a-revision" }, [existing], head, "local");
  expect(stale.stale).toBe(true);
  expect(stale.findings[0].state).toBe("unknown");
});

test("artifact adapters parse evidence and surface malformed or partial input", () => {
  const lcov = parseArtifact("TN:\nSF:src/a.ts\nDA:2,1\nDA:3,0\nend_of_record\n", "coverage/lcov.info");
  expect(lcov.type).toBe("lcov");
  expect(lcov.status).toBe("parsed");
  expect(lcov.records[0]?.covered).toBe(1);

  const junit = parseArtifact("<testsuite name=\"unit\"><testcase name=\"ok\" time=\"0.1\"></testcase></testsuite>", "junit.xml");
  expect(junit.type).toBe("junit");
  expect(junit.metrics.tests).toBe(1);

  const sarif = parseArtifact(JSON.stringify({ version: "2.1.0", runs: [{ results: [{ ruleId: "x" }] }] }), "results.sarif");
  expect(sarif.type).toBe("sarif");
  expect(sarif.records).toHaveLength(1);

  const malformed = parseArtifact("{not-json", "coverage-final.json", "istanbul");
  expect(malformed.status).toBe("malformed");
  const partial = parseArtifact("TN:\n", "coverage/lcov.info");
  expect(partial.status).toBe("partial");
  expect(partial.unknowns.length).toBeGreaterThan(0);

  const go = parseArtifact("mode: set\nsrc/main.go:1.1,2.2 1 1\n", "coverage.out");
  expect(go.type).toBe("go-coverprofile");
  expect(go.records[0]?.coveredLines).toContain(2);
  const python = parseArtifact(JSON.stringify({ files: { "src/main.py": { executed_lines: [1], missing_lines: [2] } } }), "coverage.json");
  expect(python.type).toBe("coverage.py");
  expect(python.metrics.files).toBe(1);
  const llvm = parseArtifact(JSON.stringify({ data: [{ files: [{ filename: "src/main.c", segments: [[3, 1, 1, true, true]] }] }] }), "llvm-cov.json");
  expect(llvm.type).toBe("llvm-cov");
  const gcov = parseArtifact("        -:    0:Source:src/main.c\n        1:    2:return 1;\n", "coverage.gcov");
  expect(gcov.type).toBe("gcov");
});
