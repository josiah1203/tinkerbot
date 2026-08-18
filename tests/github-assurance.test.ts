import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { canPublish, hasLegacyCommentMarker, isSafePullRequestEvent, mapCheckAnnotations } from "../packages/github/src";

const root = path.resolve(".");

describe("Tinkerbot Verify GitHub fixtures", () => {
  test("Action metadata and workflow use the canonical assurance name and safe events", () => {
    const action = fs.readFileSync(path.join(root, "action.yml"), "utf8");
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/pr-proof.example.yml"), "utf8");
    expect(action).toContain("name: Tinkerbot Verify");
    expect(action).toContain("evidence-contract:");
    expect(action).toContain("using: node20");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("evidence-contract.json");
    expect(isSafePullRequestEvent("pull_request", "synchronize")).toBe(true);
    expect(isSafePullRequestEvent("pull_request_target", "synchronize")).toBe(false);
  });

  test("App manifest is least-privilege and never grants source write access", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "github-app/manifest.json"), "utf8")) as { default_permissions: Record<string, string>; default_events: string[] };
    expect(manifest.default_permissions.contents).toBeUndefined();
    expect(manifest.default_permissions.metadata).toBe("read");
    expect(manifest.default_permissions.checks).toBe("write");
    expect(manifest.default_permissions.issues).toBe("write");
    expect(manifest.default_permissions.pull_requests).toBe("read");
    expect(manifest.default_events).not.toContain("push");
    expect(manifest.default_events).toEqual(expect.arrayContaining(["pull_request", "installation", "installation_repositories"]));
  });

  test("Action source preserves one stable publication path and customer-runner execution", () => {
    const source = fs.readFileSync(path.join(root, "action/index.ts"), "utf8");
    expect(source).toContain("TINKERBOT_CHECK_NAME");
    expect(source).toContain("hasLegacyCommentMarker");
    expect(source).toContain("mapCheckAnnotations");
    expect(source).toContain("isForkPullRequest");
    expect(source).toContain("evidenceContractFile");
    expect(source).not.toContain("pull_request_target");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain("eval(");
    expect(hasLegacyCommentMarker("<!-- tinkerbot:verify -->")).toBe(true);
    expect(hasLegacyCommentMarker("<!-- pr-proof:sticky -->")).toBe(true);
    expect(canPublish("comment", { issues: "write" }, true)).toBe(false);
  });

  test("malicious paths and diff text cannot create unbounded inline output", () => {
    const annotations = mapCheckAnnotations([
      { id: "safe", file: "src/good.ts", line: 4, severity: "high", message: "safe" },
      { id: "traversal", file: "../../outside", line: 4, severity: "critical", message: "do not publish" },
      { id: "control", file: "src/control.ts", line: 3, severity: "warning", message: "line\nwith\rcontrol" },
    ]);
    expect(annotations.map((item) => item.path)).toEqual(["src/control.ts", "src/good.ts"]);
    expect(annotations.every((item) => !/[\r\n]/.test(item.message))).toBe(true);
    expect(annotations.length).toBeLessThanOrEqual(50);
  });

  test("adversarial fixture set is metadata-only and preserves explicit degraded states", () => {
    const securityDirectory = path.join(root, "fixtures/security");
    const fork = JSON.parse(fs.readFileSync(path.join(securityDirectory, "fork-pull-request.json"), "utf8")) as unknown;
    expect(fork).toBeTruthy();
    const partial = JSON.parse(fs.readFileSync(path.join(securityDirectory, "partial-verification.json"), "utf8")) as { verdict: string; expected: string };
    expect(partial).toMatchObject({ verdict: "UNKNOWN", expected: "never-pass" });
    const diff = fs.readFileSync(path.join(securityDirectory, "malicious-diff.txt"), "utf8");
    expect(diff).toContain("../../outside.ts");
    expect(diff).toContain("Bearer fixture-token");
    expect(fs.readdirSync(securityDirectory).sort()).toEqual(expect.arrayContaining(["duplicate-delivery.json", "forged-webhook.json", "malformed-evidence.json", "rerun-race.json", "stale-receipt.json"]));
  });
});
