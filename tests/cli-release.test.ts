import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../packages/core/src";

const cli = path.resolve("dist/packages/cli/src/index.js");

test("exposes version, command help, config validation, and effective config", () => {
  const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  expect(version).toContain("tinkerbot 0.1.0");
  expect(version).toContain("capabilities:");
  expect(execFileSync(process.execPath, [cli, "check", "--help"], { encoding: "utf8" })).toContain("Usage: pr-proof check");
  expect(execFileSync(process.execPath, [cli, "config", "validate"], { encoding: "utf8" })).toContain("Configuration valid");
  expect(execFileSync(process.execPath, [cli, "config", "explain"], { encoding: "utf8" })).toContain('"max_files_analyzed"');
});

test("recognizes unavailable hosted commands without returning successful help", () => {
  for (const args of [["login"], ["org", "list"], ["github", "run"], ["serve"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("recognized but unavailable");
  }
});

test("uses stable configuration error exit code", () => {
  const result = spawnSync(process.execPath, [cli, "check", "--unknown-option"], { encoding: "utf8" });
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("Unknown option");
});

test("strict configuration rejects unknown keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-strict-config-"));
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\nvalidation:\n  strict: true\nunknown_section:\n  enabled: true\n");
  expect(() => loadConfig(root)).toThrow(/Unknown configuration key/);
});

test("strict configuration validates nested mutation and ignore keys", () => {
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-strict-nested-"));
  fs.writeFileSync(path.join(nested, "pr-proof.yml"), "version: 1\nvalidation:\n  strict: true\ntest_integrity:\n  mutation_testing:\n    unexpected: true\n");
  expect(() => loadConfig(nested)).toThrow(/test_integrity\.mutation_testing\.unexpected/);

  const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-unsafe-command-"));
  fs.writeFileSync(path.join(unsafe, "pr-proof.yml"), "version: 1\ntest_integrity:\n  mutation_testing:\n    command: 'rm -rf reports'\n");
  expect(() => loadConfig(unsafe)).toThrow(/mutation_testing\.command contains unsafe shell syntax/);
});

test("prefers Tinkerbot configuration while retaining legacy discovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-config-discovery-"));
  fs.mkdirSync(path.join(root, ".tinkerbot"));
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\nimpact:\n  max_dependency_depth: 1\n");
  fs.writeFileSync(path.join(root, ".tinkerbot", "config.yml"), "version: 1\nimpact:\n  max_dependency_depth: 4\n");
  expect(loadConfig(root).impact.max_dependency_depth).toBe(4);
});
