import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../packages/core/src";

test("Action uses pull_request-safe local output and idempotent GitHub writes", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/pr-proof.example.yml"), "utf8");
  const action = fs.readFileSync(path.resolve("action/index.ts"), "utf8");
  expect(workflow).toContain("pull_request:");
  expect(workflow).not.toContain("pull_request_target");
  expect(action).toContain("<!-- pr-proof:sticky -->");
  expect(action).toContain("method: existing?.id ? \"PATCH\" : \"POST\"");
  expect(action).toContain("report.sarif");
  for (const input of ["base:", "head:", "config:", "mode:", "fail-on:", "mutation-enabled:", "mutation-max:", "policy:", "timeout:", "max-files:", "max-findings:", "comment:", "check-run:", "sarif:"]) expect(fs.readFileSync(path.resolve("action.yml"), "utf8")).toContain(input);
  expect(action).toContain("GITHUB_TOKEN");
  expect(action).toContain("safeEnvironment");
});

test("configuration exposes bounded large-diff limits", () => {
  const config = loadConfig(path.resolve("."));
  expect(config.limits.max_changed_files).toBeGreaterThan(0);
  expect(config.limits.max_changed_lines).toBeGreaterThan(0);
});
