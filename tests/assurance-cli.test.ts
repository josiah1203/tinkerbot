import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("dist/packages/cli/src/index.js");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixtureReport(base: string, head: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    schemaId: "https://pr-proof.dev/schemas/report/v1",
    toolVersion: "0.1.0",
    repository: "local/example",
    base,
    head,
    verdict: "PASS",
    summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
    findings: [],
    limitations: [],
  };
}

test("proof create and proof verify are offline, deterministic, and machine-readable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-cli-proof-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Tinkerbot Test"]);
  fs.writeFileSync(path.join(root, "src.ts"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "src.ts"), "export const next = 2;\n");
  git(root, ["commit", "-qam", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "report.json"), `${JSON.stringify(fixtureReport(base, head))}\n`);
  const created = JSON.parse(execFileSync(process.execPath, [cli, "proof", "create", "--input", "report.json", "--format", "json"], { cwd: root, encoding: "utf8" })) as { id: string; integrity: { digest: string } };
  expect(created.id).toMatch(/^verification-receipt:/);
  expect(created.integrity.digest).toMatch(/^sha256:/);
  const receiptPath = path.join(root, ".tinkerbot", "receipts", `${created.id}.json`);
  expect(fs.existsSync(receiptPath)).toBe(true);
  const verified = JSON.parse(execFileSync(process.execPath, [cli, "proof", "verify", "--input", path.relative(root, receiptPath), "--repository", "local/example", "--base", base, "--head", head, "--format", "json"], { cwd: root, encoding: "utf8" })) as { valid: boolean; status: string; verdict: string };
  expect(verified.valid).toBe(true);
  expect(verified.status).toBe("valid");
  expect(verified.verdict).toBe("PASS");
});

test("evidence review-context stays source-minimized and contract validation exposes missing configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-cli-evidence-"));
  git(root, ["init", "-q"]);
  const report = fixtureReport("base", "head");
  fs.writeFileSync(path.join(root, "report.json"), `${JSON.stringify(report)}\n`);
  const contextRun = spawnSync(process.execPath, [cli, "evidence", "--input", "report.json", "--format", "review-context"], { cwd: root, encoding: "utf8" });
  const context = JSON.parse(contextRun.stdout) as { findings: unknown[]; limitations: string[] };
  expect(contextRun.status).toBe(2);
  expect(context.findings).toEqual([]);
  expect(JSON.stringify(context)).not.toContain("patch");
  const validation = spawnSync(process.execPath, [cli, "change", "contract", "validate", "--format", "json"], { cwd: root, encoding: "utf8" });
  expect(validation.status).toBe(2);
  expect(JSON.parse(validation.stdout).missing).toBe(true);
});

test("outcome record/export and policy simulation preserve explicit states", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-cli-outcome-"));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "outcome.json"), JSON.stringify({ outcomeType: "incident_reference", observedAt: "2026-01-01T00:00:00.000Z", repository: "local/example", facts: { incident: "INC-1" } }));
  const record = JSON.parse(execFileSync(process.execPath, [cli, "outcome", "record", "--input", "outcome.json", "--format", "json"], { cwd: root, encoding: "utf8" })) as { association: { type: string } };
  expect(record.association.type).toBe("unknown");
  const exported = JSON.parse(execFileSync(process.execPath, [cli, "outcome", "export", "--format", "json"], { cwd: root, encoding: "utf8" })) as Array<{ outcomeType: string }>;
  expect(exported[0]?.outcomeType).toBe("incident_reference");
  const simulation = JSON.parse(execFileSync(process.execPath, [cli, "policy", "simulate", "--format", "json"], { cwd: root, encoding: "utf8" })) as { enforcementChanged: boolean; mode: string };
  expect(simulation.mode).toBe("simulation");
  expect(simulation.enforcementChanged).toBe(false);
});
