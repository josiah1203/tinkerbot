import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, startAction } from "../action/run";

const previous = { ...process.env };

afterEach(() => {
  process.exitCode = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeStubCli(root: string): string {
  const cli = path.join(root, "stub-cli.js");
  fs.writeFileSync(cli, `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined;
const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : undefined;
const report = {
  verdict: "PASS",
  findings: [{ severity: "warning", file: "src/a.ts", startLine: 2, message: "nit" }],
  summary: { changedSymbols: 1, impactedPathsExecuted: 1, impactedPathsTotal: 1, unverifiedPaths: 0 },
  head: process.env.GITHUB_SHA || "abc123",
  policy: { pack: "default", unknownHandling: "advisory" },
  baseline: { stale: false, newCount: 0, waivedCount: 0 },
  testIntegrity: { newTests: 0, modifiedTests: 0, testsPassingOnBase: 1, coverage: { percentage: 91 }, mutation: { killed: 0, results: [] } },
  contracts: { changes: [], unknowns: [] },
};
if (args.includes("check") && output) fs.writeFileSync(output, JSON.stringify(report));
else if (format === "receipt" && output) fs.writeFileSync(output, "{}");
else if (format === "json" && args.includes("evidence") && output) fs.writeFileSync(output, JSON.stringify({ evidence: { verdict: "PASS", receiptId: "receipt_1", runId: "run_1", staleStates: [], unknownStates: [] } }));
else if (format === "review-context" && output) fs.writeFileSync(output, "{}");
else if (format === "change-assurance" && output && !process.env.TINKERBOT_SKIP_ASSURANCE) fs.writeFileSync(output, JSON.stringify({ assurance: { schemaVersion: 1, verdict: "PASS" } }));
else if (format === "sarif") process.stdout.write("{}");
`);
  return cli;
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-action-"));
  process.env.GITHUB_WORKSPACE = root;
  process.env.GITHUB_REPOSITORY = "acme/payments";
  process.env.GITHUB_SHA = "abc123def456";
  process.env.GITHUB_TOKEN = "ghs_actiontokenvalue";
  process.env.GITHUB_OUTPUT = path.join(root, "github-output.txt");
  process.env.GITHUB_STEP_SUMMARY = path.join(root, "summary.md");
  process.env.TINKERBOT_ACTION_CLI = writeStubCli(root);
  fs.writeFileSync(process.env.GITHUB_OUTPUT, "");
  fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, "");
  fs.writeFileSync(path.join(root, "pr-proof.yml"), "mode: advisory\n");
  return root;
}

test("Action writes local artifacts, redacts tokens, and keeps fork pull requests write-disabled", async () => {
  const root = workspace();
  const eventFile = path.join(root, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify({
    number: 12,
    pull_request: { head: { sha: "abc123def456", repo: { fork: true, full_name: "contrib/payments" } }, base: { sha: "base", repo: { full_name: "acme/payments" } } },
  }));
  process.env.GITHUB_EVENT_PATH = eventFile;
  process.env.INPUT_CONTROL_PLANE_URL = "http://insecure.example";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: 200 });
  };
  try {
    await main();
    expect(fs.existsSync(path.join(root, ".pr-proof", "report.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".pr-proof", "report.md"), "utf8")).toContain("Tinkerbot Verify — PASS");
    expect(fs.readFileSync(process.env.GITHUB_OUTPUT!, "utf8")).toContain("assurance-bundle=.pr-proof/assurance-bundle.json");
    expect(calls.some((url) => url.includes("/check-runs") || url.includes("/comments"))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Action exchanges OIDC, submits hosted evidence, and publishes Check Runs when the pull request is not a fork", async () => {
  const root = workspace();
  const eventFile = path.join(root, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify({
    number: 8,
    pull_request: { head: { sha: "abc123def456", repo: { fork: false, full_name: "acme/payments" } }, base: { sha: "base", repo: { full_name: "acme/payments" } } },
  }));
  process.env.GITHUB_EVENT_PATH = eventFile;
  process.env.INPUT_CONTROL_PLANE_URL = "https://control.example";
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.actions.githubusercontent.com/token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
  process.env.GITHUB_API_URL = "https://api.github.com";
  const originalFetch = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    posts.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("token.actions.githubusercontent.com")) return new Response(JSON.stringify({ value: "oidc-jwt" }), { status: 200 });
    if (url.includes("/actions/oidc/exchange")) return new Response(JSON.stringify({ runToken: "runtokenvalue0123456789" }), { status: 200 });
    if (url.includes("/assurance/ingest")) return new Response(JSON.stringify({ ingested: true }), { status: 200 });
    if (url.includes("/check-runs?")) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
    if (url.includes("/check-runs")) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    if (url.includes("/comments")) return new Response(JSON.stringify([{ id: 9, body: "<!-- pr-proof:sticky --> old" }]), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  try {
    await main();
    expect(posts.some((item) => item.includes("audience=tinkerbot"))).toBe(true);
    expect(posts.some((item) => item.includes("/assurance/ingest"))).toBe(true);
    expect(posts.some((item) => item.includes("/check-runs"))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Action stays UNKNOWN-safe when the event payload is malformed and hosted submission is rejected", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "event.json"), "{not-json");
  process.env.GITHUB_EVENT_PATH = path.join(root, "event.json");
  process.env.INPUT_CONTROL_PLANE_URL = "https://control.example";
  process.env.INPUT_SESSION_TOKEN = "sessiontokenvalue012345";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/assurance/ingest")) return new Response("no", { status: 503 });
    return new Response("{}", { status: 200 });
  };
  try {
    await main();
    expect(fs.existsSync(path.join(root, ".pr-proof", "report.json"))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Action reports a local failure when the CLI artifact is missing and skips hosted ingest without a run token", async () => {
  const root = workspace();
  delete process.env.TINKERBOT_ACTION_CLI;
  await main();
  expect(process.exitCode).toBe(4);
  process.exitCode = 0;
  process.env.TINKERBOT_ACTION_CLI = writeStubCli(root);
  process.env.INPUT_CONTROL_PLANE_URL = "https://control.example";
  process.env.INPUT_SESSION_TOKEN = "short";
  await main();
  process.env.INPUT_SESSION_TOKEN = "sessiontokenvalue012345";
  process.env.TINKERBOT_SKIP_ASSURANCE = "1";
  fs.rmSync(path.join(root, ".pr-proof"), { recursive: true, force: true });
  await main();
  delete process.env.TINKERBOT_SKIP_ASSURANCE;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  try {
    await main();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startAction reports a pre-result failure when GitHub output cannot be written", async () => {
  workspace();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-output-"));
  process.env.GITHUB_OUTPUT = dir;
  startAction();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(process.exitCode).toBe(4);
});
