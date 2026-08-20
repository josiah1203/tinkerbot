import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReport } from "../packages/cli/src";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

test("creates a unified report from a real base/head Git fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-integration-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/session.ts"), "export function refreshSession(token: string): string { if (!token) throw new Error('missing'); return token; }\n");
  fs.writeFileSync(path.join(root, "src/session.test.ts"), "import { refreshSession } from './session';\ntest('session', () => { expect(refreshSession('u')).toBe('u'); });\n");
  fs.writeFileSync(path.join(root, "src/runtime.ts"), "export async function load(name: string) { return import(name); }\n");
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\nframework:\n  command: node -e \"process.exit(1)\"\ntest_integrity:\n  run_base_tests: false\n  mutation_testing:\n    enabled: false\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(root, "src/session.test.ts"), "import { refreshSession } from './session';\ntest('session', () => { expect(refreshSession('u')).toBeTruthy(); });\n");
  fs.writeFileSync(path.join(root, "src/routes.ts"), "import { refreshSession } from './session';\nexport function route() { return refreshSession('u'); }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "head"]);

  const report = createReport({ cwd: root, base: "HEAD~1", head: "HEAD", runMutation: false, runBaseTests: false });
  const repeated = createReport({ cwd: root, base: "HEAD~1", head: "HEAD", runMutation: false, runBaseTests: false });
  expect(JSON.stringify(report)).toBe(JSON.stringify(repeated));
  expect(report.schemaId).toBe("https://pr-proof.dev/schemas/report/v1");
  expect(report.generatedAt).toBeUndefined();
  expect(report.findings.every((finding) => finding.startLine && finding.endLine && finding.toolVersion && finding.baseSha && finding.headSha && finding.resolution)).toBe(true);
  expect(report.findings.every((finding) => finding.evidence)).toBe(true);
  expect(report.testIntegrity?.findings.every((finding) => finding.evidence && finding.startLine && finding.endLine)).toBe(true);
  expect(report.impact?.filesAnalyzed).toBeGreaterThan(0);
  expect(report.impact?.symbolsAnalyzed).toBeGreaterThan(0);
  expect(report.testIntegrity?.findings.some((finding) => finding.ruleId === "matcher.weakened")).toBe(true);
  expect(report.impact?.changedSymbols.some((symbol) => symbol.file === "src/routes.ts")).toBe(true);
  expect(report.impact?.paths.some((impact) => impact.file === "src/session.ts" || impact.file === "src/routes.ts")).toBe(true);
  expect(report.impact?.paths.some((impact) => impact.classification === "runtime_unknown")).toBe(true);
  expect(report.verdict).toBe("UNKNOWN");
  expect(report.reviewAssessment).toBe("REVISE");
});
