import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { canPublish, createGitHubAppJwt, createImplementPullRequest, dispatchGitHubEnvironmentWorkflow, githubEventKind, githubInstallationAccount, hasLegacyCommentMarker, inlineReviewComments, isSafePullRequestEvent, mapCheckAnnotations, mintInstallationToken, publishCheckRun, publishInlineComments, sanitizePublicationBody } from "../packages/github/src";

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
    expect(manifest.default_permissions.contents).toBe("read");
    expect(manifest.default_permissions.metadata).toBe("read");
    expect(manifest.default_permissions.checks).toBe("write");
    expect(manifest.default_permissions.issues).toBe("write");
    expect(manifest.default_permissions.pull_requests).toBe("write");
    expect(manifest.default_events).not.toContain("push");
    expect(manifest.default_events).toEqual(expect.arrayContaining(["pull_request", "issues", "installation", "installation_repositories"]));
  });

  test("Action source preserves one stable publication path and customer-runner execution", () => {
    const source = fs.readFileSync(path.join(root, "action/run.ts"), "utf8");
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

  test("GitHub App publisher mints installation tokens and writes bounded comments", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const jwt = createGitHubAppJwt("123", privateKey);
    expect(jwt.split(".").length).toBe(3);
    expect(githubEventKind("issues")).toBe("issue");
    expect(githubEventKind("pull_request")).toBe("pull_request");
    expect(githubEventKind("dependabot_alert")).toBe("dependabot");
    expect(githubEventKind("code_scanning_alert")).toBe("code_scanning");
    expect(githubEventKind("secret_scanning_alert")).toBe("secret_scanning");
    expect(githubEventKind("deployment_status")).toBe("deployment");
    expect(githubEventKind("check_run")).toBe("check_run");
    expect(githubEventKind("workflow_run")).toBe("check_run");
    expect(githubInstallationAccount({ installation: { account: { id: 9, login: "acme" } } })).toEqual({ id: 9, login: "acme" });
    expect(sanitizePublicationBody("token=ghs_abcdefghijkl")).not.toMatch(/ghs_/);
    expect(inlineReviewComments([{ id: "1", file: "src/a.ts", line: 3, message: "finding", ruleId: "x", severity: "high" }], "abc1234", "https://control.tinkerbot.dev/app/overview").length).toBe(1);
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_installationtokenvalue" }), { status: 201 });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ id: 44 }), { status: 201 });
      if (url.includes("/reviews")) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      if (url.endsWith("/pulls") && init?.method === "POST") return new Response(JSON.stringify({ number: 12 }), { status: 201 });
      if (url.includes("/actions/workflows/")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    };
    expect(await mintInstallationToken({ appId: "123", privateKeyPem: privateKey, installationId: 7, fetcher: fetcher as typeof fetch })).toBe("ghs_installationtokenvalue");
    expect(await publishCheckRun({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { headSha: "abc1234", verdict: "UNKNOWN", summary: "blocked", annotations: [] })).toBe(44);
    expect(await publishInlineComments({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, 3, [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "note", commit_id: "abc1234" }])).toBe(true);
    expect(await createImplementPullRequest({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { title: "tinkerbot", head: "tinkerbot/wo", body: "factory" })).toBe(12);
    expect(await createImplementPullRequest({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { title: "nope", head: "main", body: "factory" })).toBeUndefined();
    expect(await createImplementPullRequest({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { title: "nope", head: "master", body: "factory" })).toBeUndefined();
    expect(await createImplementPullRequest({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { title: "nope", head: "production", body: "factory" })).toBeUndefined();
    expect(await dispatchGitHubEnvironmentWorkflow({ token: "ghs_installationtokenvalue", repository: "acme/payments", fetcher: fetcher as typeof fetch }, { workflow: "deploy.yml", ref: "abc", environment: "production" })).toBe(true);
  });
});
