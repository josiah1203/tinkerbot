import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, finalizeReport, loadConfig } from "../packages/core/src";

test("loads safe defaults and repository YAML overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-config-"));
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\ntest_integrity:\n  mode: blocking\nimpact:\n  max_dependency_depth: 3\n");
  const config = loadConfig(root);
  expect(config.framework.test_runner).toBe(DEFAULT_CONFIG.framework.test_runner);
  expect(config.validation.toolchain_checks).toBe(true);
  expect(config.test_integrity.mode).toBe("blocking");
  expect(config.impact.max_dependency_depth).toBe(3);
});

test("allows repository owners to disable external toolchain checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-toolchain-config-"));
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\nvalidation:\n  toolchain_checks: false\n");
  expect(loadConfig(root).validation.toolchain_checks).toBe(false);
});

test("accepts repository-native runner identifiers for expanded ecosystems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-language-config-"));
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "version: 1\nframework:\n  test_runner: pytest\n  command: pytest -q\nlanguages:\n  mode: explicit\n  include: [python]\n  exclude: []\n");
  const config = loadConfig(root);
  expect(config.framework.test_runner).toBe("pytest");
  expect(config.languages.include).toEqual(["python"]);
});

test("rejects invalid report verdicts before rendering", () => {
  expect(() => finalizeReport({
    schemaVersion: 1,
    toolVersion: "0.1.0",
    repository: "fixture",
    base: "base",
    head: "head",
    verdict: "BROKEN" as never,
    summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
    findings: [],
    limitations: [],
  })).toThrow(/Invalid report verdict/);
});
