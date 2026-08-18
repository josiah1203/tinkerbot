import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("dist/packages/cli/src/index.js");

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

test("new CLI surfaces expose policy, artifact, and history contracts", () => {
  const packs = execFileSync(process.execPath, [cli, "policy", "list", "--format", "json"], { encoding: "utf8" });
  expect(packs).toContain('"id": "default"');
  expect(packs).toContain('"id": "public-api"');
  expect(execFileSync(process.execPath, [cli, "policy", "explain", "strict"], { encoding: "utf8" })).toContain('"unknownHandling": "fail"');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-cli-artifact-"));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify({ ok: true, records: [{ name: "test" }] }));
  const artifact = execFileSync(process.execPath, [cli, "artifacts", "--input", "results.json", "--format", "json"], { cwd: root, encoding: "utf8" });
  expect(JSON.parse(artifact).type).toBe("generic");

  const history = spawnSync(process.execPath, [cli, "history", "--format", "json"], { cwd: root, encoding: "utf8" });
  expect(history.status).toBe(2);
  expect(history.stdout).toContain("[]");
});

test("missing artifact returns UNKNOWN with a diagnostic instead of fabricated evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-cli-missing-"));
  git(root, ["init", "-q"]);
  const result = spawnSync(process.execPath, [cli, "artifacts", "--input", "missing.sarif"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stdout).toContain("Status: missing");
  expect(result.stdout).toContain("Artifact not found");
});

test("baseline commands require explicit initialization and expose comparison state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-cli-baseline-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  fs.writeFileSync(path.join(root, "src.ts"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  fs.appendFileSync(path.join(root, "src.ts"), "export const next = 2;\n");
  git(root, ["commit", "-qam", "head"]);
  const init = execFileSync(process.execPath, [cli, "baseline", "init", "--base", "HEAD~1", "--head", "HEAD", "--no-base-tests", "--no-mutation"], { cwd: root, encoding: "utf8" });
  expect(init).toContain("Baseline initialized");
  expect(fs.existsSync(path.join(root, ".pr-proof", "baseline.json"))).toBe(true);
  const check = execFileSync(process.execPath, [cli, "baseline", "check", "--base", "HEAD~1", "--head", "HEAD", "--no-base-tests", "--no-mutation", "--format", "json"], { cwd: root, encoding: "utf8" });
  const report = JSON.parse(check) as { baseline?: { stale: boolean; existingCount: number } };
  expect(report.baseline?.stale).toBe(false);
  expect(report.baseline?.existingCount).toBeGreaterThan(0);
  execFileSync(process.execPath, [cli, "check", "--base", "HEAD~1", "--head", "HEAD", "--no-base-tests", "--no-mutation", "--format", "json"], { cwd: root, encoding: "utf8" });
  const history = JSON.parse(execFileSync(process.execPath, [cli, "history", "--format", "json"], { cwd: root, encoding: "utf8" })) as Array<{ verdict: string; changedFiles: number | null }>;
  expect(history.length).toBe(1);
  expect(history[0]?.changedFiles).toBeGreaterThan(0);
});
