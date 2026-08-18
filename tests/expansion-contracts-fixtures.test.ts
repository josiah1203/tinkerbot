import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyzeContracts } from "../packages/contracts/src";
import { analyzeFixtures } from "../packages/fixtures/src";
import { DEFAULT_CONFIG } from "../packages/core/src";
import type { FileDiff } from "../packages/core/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixtureDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return { path: "tests/__snapshots__/users.snap", status: "deleted", additions: 0, deletions: 4, changedLines: [], deletedLines: [1, 2, 3, 4], hunks: [{ oldStart: 1, oldCount: 4, newStart: 0, newCount: 0, header: "@@ -1,4 +0,0 @@", lines: ["-exports[1] = `user`;", "-exports[2] = `error`;", "-exports[3] = `edge`;", "-exports[4] = `ok`;"], }], patch: "diff --git a/tests/__snapshots__/users.snap b/tests/__snapshots__/users.snap\ndeleted file mode 100644\n", ...overrides };
}

test("API Contract Guard reports removed endpoints with consumer evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-contracts-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "openapi.yml"), "openapi: 3.0.0\npaths:\n  /users:\n    get:\n      responses:\n        '200':\n          description: ok\n");
  fs.writeFileSync(path.join(root, "src/client.ts"), "export async function loadUsers() { return fetch('/users'); }\n");
  fs.writeFileSync(path.join(root, "src/client.test.ts"), "test('users', () => {});\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(root, "openapi.yml"), "openapi: 3.0.0\npaths: {}\n");
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["commit", "-qam", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const report = analyzeContracts({ root, base, head, config: structuredClone(DEFAULT_CONFIG) });
  expect(report.changes.some((change) => change.kind === "breaking" && change.location.includes("GET /users"))).toBe(true);
  expect(report.findings.some((finding) => finding.ruleId === "contract.breaking")).toBe(true);
  expect(report.findings[0]?.evidence?.before).toBeTruthy();
});

test("fixture integrity flags deleted and unexplained snapshots while honoring approved paths", () => {
  const report = analyzeFixtures([fixtureDiff()], structuredClone(DEFAULT_CONFIG.fixtures));
  expect(report.snapshotFiles).toContain("tests/__snapshots__/users.snap");
  expect(report.findings.some((finding) => finding.ruleId === "fixture.snapshot-deleted")).toBe(true);
  expect(report.findings.some((finding) => finding.ruleId === "fixture.expected-error-removed")).toBe(true);
  const approved = analyzeFixtures([fixtureDiff()], { ...structuredClone(DEFAULT_CONFIG.fixtures), approved_paths: ["tests/__snapshots__/**"] });
  expect(approved.findings).toHaveLength(0);
});
