import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { mainAsync, runCli } from "../packages/cli/src";
import { mainFactoryCli } from "../packages/cli/src/factory-cli";
import { clearStoredCredentials, hostedSession, saveStoredCredentials } from "../packages/cli/src/credentials";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function capture(run: () => number | Promise<number>): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const restore = () => { process.stdout.write = writeOut; process.stderr.write = writeErr; };
  try {
    const result = run();
    if (result && typeof result === "object" && "then" in result) {
      return { code: -1, stdout: "", stderr: "async capture requires await" };
    }
    restore();
    return { code: result as number, stdout: stdout.join(""), stderr: stderr.join("") };
  } catch (error) {
    restore();
    throw error;
  }
}

async function captureAsync(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

const previousCwd = process.cwd();
const previousCredential = process.env.TINKERBOT_CREDENTIAL_FILE;
const previousUrl = process.env.TINKERBOT_CONTROL_PLANE_URL;
const previousToken = process.env.TINKERBOT_SESSION_TOKEN;
const previousLocalDb = process.env.TINKERBOT_LOCAL_DB;

afterEach(() => {
  process.chdir(previousCwd);
  if (previousCredential === undefined) delete process.env.TINKERBOT_CREDENTIAL_FILE; else process.env.TINKERBOT_CREDENTIAL_FILE = previousCredential;
  if (previousUrl === undefined) delete process.env.TINKERBOT_CONTROL_PLANE_URL; else process.env.TINKERBOT_CONTROL_PLANE_URL = previousUrl;
  if (previousToken === undefined) delete process.env.TINKERBOT_SESSION_TOKEN; else process.env.TINKERBOT_SESSION_TOKEN = previousToken;
  if (previousLocalDb === undefined) delete process.env.TINKERBOT_LOCAL_DB; else process.env.TINKERBOT_LOCAL_DB = previousLocalDb;
});

function factoryRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-factory-cli-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "dev@example.test"]);
  git(root, ["config", "user.name", "Dev"]);
  fs.cpSync(path.resolve(".tinkerbot"), path.join(root, ".tinkerbot"), { recursive: true });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "factory"]);
  return root;
}

test("factory validate, receipt validate, login, and hosted inspect commands are exercised in-process", async () => {
  const root = factoryRepo();
  process.chdir(root);
  const credentialFile = path.join(root, "credentials.json");
  process.env.TINKERBOT_CREDENTIAL_FILE = credentialFile;
  delete process.env.TINKERBOT_CONTROL_PLANE_URL;
  delete process.env.TINKERBOT_SESSION_TOKEN;

  expect(capture(() => runCli(["login"])).code).toBe(3);
  expect(capture(() => runCli(["factory", "mcp"])).code).toBe(2);
  expect(capture(() => runCli(["dashboard"])).code).toBe(2);
  const validated = capture(() => runCli(["factory", "validate"]));
  expect(validated.code).toBe(0);
  expect(validated.stdout).toContain('"valid": true');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-factory-missing-"));
  git(bare, ["init", "-q"]);
  git(bare, ["config", "user.email", "dev@example.test"]);
  git(bare, ["config", "user.name", "Dev"]);
  fs.writeFileSync(path.join(bare, "README.md"), "missing factory\n");
  git(bare, ["add", "."]);
  git(bare, ["commit", "-qm", "empty"]);
  process.chdir(bare);
  expect(capture(() => runCli(["factory", "validate"])).code).toBe(3);
  const created = capture(() => runCli(["factory", "new", "demo"]));
  expect(created.code).toBe(0);
  expect(created.stdout).toContain(".tinkerbot");
  expect(fs.existsSync(path.join(bare, ".tinkerbot", "factory.yaml"))).toBe(true);
  expect(capture(() => runCli(["factory", "new"])).code).toBe(3);
  expect(capture(() => runCli(["agents"])).stdout).toContain("storesVendorTokens");
  process.chdir(root);
  expect(capture(() => runCli(["factory", "bogus"])).code).toBe(3);
  expect(capture(() => runCli(["tui", "--help"])).stdout).toContain("pnpm tb tui");
  expect(capture(() => runCli(["work", "frobnicate"])).code).toBe(3);
  expect(capture(() => runCli(["billing", "bogus"])).code).toBe(3);
  expect(capture(() => runCli(["org", "bogus"])).code).toBe(3);
  expect(capture(() => runCli(["billing", "--help"])).stdout).toContain("tb billing");
  expect(capture(() => runCli(["not-a-command"])).code).toBe(3);

  fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify({ repository: "acme/payments", agentIdentity: "triage", workflowId: "run", baseSha: "a", headSha: "b", model: "m", provider: "workers-ai", harness: "default", definitionHash: "sha256:x", inputRef: "in", outputRef: "out" }));
  expect(capture(() => runCli(["receipt", "validate", "--input", "receipt.json"])).code).toBe(0);
  expect(capture(() => runCli(["receipt", "validate", "--input", "missing.json"])).code).toBe(3);
  expect(capture(() => runCli(["receipt", "show"])).code).toBe(3);

  const token = "sessiontokenvalue012345";
  expect(capture(() => runCli(["login", "--url", "https://control.example", "--token", token])).code).toBe(0);
  expect(hostedSession()).toMatchObject({ url: "https://control.example", token });
  fs.writeFileSync(credentialFile, "{not-json");
  expect(hostedSession().token).toBeUndefined();
  saveStoredCredentials({ controlPlaneUrl: "https://control.example", sessionToken: token });
  expect(fs.existsSync(credentialFile)).toBe(true);
  process.env.TINKERBOT_CONTROL_PLANE_URL = "https://control.example";
  process.env.TINKERBOT_SESSION_TOKEN = token;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/session")) return new Response(JSON.stringify({ authenticated: true, user: { id: "user_1" } }), { status: 200 });
    if (url.endsWith("/auth/signout")) return new Response(JSON.stringify({ signedOut: true }), { status: 200 });
    if (url.includes("/factories")) return new Response(JSON.stringify({ factories: [] }), { status: 200 });
    if (url.includes("/work-orders")) return new Response(JSON.stringify({ workOrders: [] }), { status: 200 });
    if (url.includes("/runs/")) return new Response(JSON.stringify({ run: { run_id: "run_1" }, stages: [] }), { status: 200 });
    if (url.includes("/tenant/organizations")) return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
    if (url.includes("/org/seats")) return new Response(JSON.stringify({ activeBillableSeats: 2 }), { status: 200 });
    if (url.includes("/billing/summary")) return new Response(JSON.stringify({ planId: "team", subscriptionState: "active" }), { status: 200 });
    if (url.includes("/billing/catalog")) return new Response(JSON.stringify({ plans: [] }), { status: 200 });
    if (url.includes("/billing/portal")) return new Response(JSON.stringify({ portal: { url: "https://billing.example/session" } }), { status: 200 });
    if (url.includes("/assurance/ingest")) return new Response(JSON.stringify({ ingested: true }), { status: 200 });
    if (init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("not-json", { status: 200 });
  };
  try {
    expect((await captureAsync(() => mainAsync(["whoami"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["factory", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["factory", "show", "fac_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["factory", "sync"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "graph", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "retry", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "approve", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "cancel", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "take", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["work", "return", "wo_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["evolution", "approve", "prop_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["cell", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["cell", "show", "cell_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["product", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["product", "show", "prod_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["skill", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["skill", "show", "sk_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["evolution", "show", "prop_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["evolution", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["run", "show", "run_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["run", "logs", "run_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["org", "list"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["org", "switch", "org_1"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["org", "seats"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["billing", "summary"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["billing", "catalog"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["billing", "portal"]))).code).toBe(0);
    expect((await captureAsync(() => mainAsync(["verify", "--repository", "acme/payments", "--no-base-tests"]))).code).not.toBe(3);
    fs.writeFileSync(path.join(root, "report.json"), JSON.stringify({
      schemaVersion: 1,
      toolVersion: "0.1.0",
      generatedAt: "2030-01-01T00:00:00.000Z",
      repository: "acme/payments",
      base: "base-sha",
      head: "head-sha",
      verdict: "UNKNOWN",
      summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
      findings: [],
      limitations: ["Missing coverage artifact."],
    }));
    expect((await captureAsync(() => mainAsync(["verify", "--input", "report.json", "--repository", "acme/payments"]))).code).toBe(2);
    const dashboard = capture(() => runCli(["dashboard"]));
    expect(dashboard.code).toBe(0);
    expect(dashboard.stdout).toContain("https://control.example/app");
    expect(capture(() => runCli(["factory", "mcp"])).code).toBe(0);
    expect(capture(() => runCli(["factory", "mcp"])).stdout).toContain("https://control.example/mcp");
    expect((await captureAsync(() => mainAsync(["logout"]))).code).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    process.env.TINKERBOT_CONTROL_PLANE_URL = "https://control.example";
    process.env.TINKERBOT_SESSION_TOKEN = token;
    expect((await captureAsync(() => mainAsync(["whoami"]))).code).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "denied" }), { status: 401 });
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify({
    schemaVersion: 1,
    toolVersion: "0.1.0",
    generatedAt: "2030-01-01T00:00:00.000Z",
    repository: "acme/payments",
    base: "base-sha",
    head: "head-sha",
    verdict: "PASS",
    summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
    findings: [],
    limitations: [],
  }));
  try {
    expect((await captureAsync(() => mainAsync(["factory", "list"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["whoami"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["cell", "list"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["verify", "--input", "report.json", "--repository", "acme/payments"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["work", "take", "wo_1"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["work", "list"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["run", "show", "run_1"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["org", "list"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["org", "seats"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["billing", "summary"]))).code).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "unavailable" }), { status: 500 });
  try {
    expect((await captureAsync(() => mainAsync(["whoami"]))).code).toBe(4);
    expect((await captureAsync(() => mainAsync(["billing", "portal"]))).code).toBe(4);
    expect((await captureAsync(() => mainAsync(["cell", "list"]))).code).toBe(4);
    expect((await captureAsync(() => mainAsync(["verify", "--input", "report.json", "--repository", "acme/payments"]))).code).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => new Response("{}", { status: 403 });
  try {
    expect((await captureAsync(() => mainAsync(["factory", "list"]))).code).toBe(2);
    expect((await captureAsync(() => mainAsync(["org", "list"]))).code).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect((await captureAsync(() => mainAsync(["run", "show"]))).code).toBe(3);
  expect((await captureAsync(() => mainAsync(["org", "switch"]))).code).toBe(3);
  clearStoredCredentials();
  expect(fs.existsSync(credentialFile)).toBe(false);
  clearStoredCredentials();
});

test("factory CLI exposes a bounded self-hosted worker entrypoint", async () => {
  const help = await captureAsync(() => mainFactoryCli(["worker", "--help"]));
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--completion-url");
  const missing = await captureAsync(() => mainFactoryCli(["worker"]));
  expect(missing.code).toBe(3);
  expect(missing.stderr).toContain("--completion-url");
});

test("tb factory new writes a local starter and refuses to overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-factory-new-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "dev@example.test"]);
  git(root, ["config", "user.name", "Dev"]);
  process.chdir(root);
  const created = capture(() => runCli(["factory", "new", "payments"]));
  expect(created.code).toBe(0);
  expect(created.stdout).toContain(".tinkerbot/factory.yaml");
  expect(fs.readFileSync(path.join(root, ".tinkerbot/factory.yaml"), "utf8")).toContain("name: payments");
  expect(capture(() => runCli(["factory", "new"])).code).toBe(3);
});

test("tb factory init, factory check, work new, and cell check do not require AI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-factory-init-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "dev@example.test"]);
  git(root, ["config", "user.name", "Dev"]);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "seed"]);
  process.chdir(root);
  process.env.TINKERBOT_LOCAL_DB = path.join(root, "state.sqlite");
  const intent = capture(() => runCli(["intent", "Fix invoice timezone formatting"]));
  expect(intent.code).toBe(0);
  expect(intent.stdout).toContain('"mode": "micro"');
  expect(intent.stdout).toContain('"intentId"');
  expect(intent.stdout).toContain('"persisted": true');
  const strategic = capture(() => runCli(["intent", "--intent-mode", "strategic", "Improve checkout reliability"]));
  expect(strategic.code).toBe(0);
  expect(JSON.parse(strategic.stdout)).toMatchObject({ mode: "strategic", intent: { objectiveId: expect.any(String), baselineMetric: expect.any(String), targetMetric: expect.any(String), measurementWindow: "14d", killCriteria: expect.any(Array) } });
  const initialized = capture(() => runCli(["factory", "init", "demo-factory"]));
  expect(initialized.code).toBe(0);
  expect(initialized.stdout).toContain('"requiresAi": false');
  expect(fs.existsSync(path.join(root, ".tinkerbot", "lines", "maintenance.yaml"))).toBe(true);
  expect(capture(() => runCli(["factory", "init"])).code).toBe(3);
  const checked = capture(() => runCli(["factory", "check"]));
  expect(checked.code).toBe(0);
  expect(checked.stdout).toContain('"compiled": true');
  const work = capture(() => runCli(["work", "new", "fix flaky test"]));
  expect(work.code).toBe(0);
  expect(work.stdout).toContain('"requiresAi": false');
  expect(work.stdout).toContain('"verificationVerdict": "UNKNOWN"');
  const workId = JSON.parse(work.stdout).workOrderId as string;
  const graphStatus = capture(() => runCli(["factory", "status", workId]));
  expect(graphStatus.code).toBe(0);
  expect(graphStatus.stdout).toContain('"sourceOfTruth": "append_only_factory_graph"');
  const graphCommand = capture(() => runCli(["work", "graph", workId]));
  expect(graphCommand.code).toBe(0);
  expect(graphCommand.stdout).toContain('"sourceOfTruth": "append_only_factory_graph"');
  expect(JSON.parse(graphCommand.stdout)).toMatchObject({ state: { eventCount: 1 }, events: [{ type: "work_order.created" }] });
  const approved = capture(() => runCli(["work", "approve", workId]));
  expect(approved.code).toBe(0);
  expect(JSON.parse(approved.stdout)).toMatchObject({ state: { reviewDecision: "APPROVE" }, events: [{ type: "work_order.created" }, { type: "approval.recorded" }] });
  const outcomeInput = path.join(root, "outcome.json");
  fs.writeFileSync(outcomeInput, JSON.stringify({ workOrderId: workId, status: "POSITIVE", mature: true }));
  const outcomeGraph = capture(() => runCli(["outcome", "record", "--input", "outcome.json", "--work-order", workId]));
  expect(outcomeGraph.code).toBe(0);
  const outcomePayload = JSON.parse(outcomeGraph.stdout) as { state: { outcomeStatus: string; outcomeMaturity: string }; events: Array<{ type: string }> };
  expect(outcomePayload.state).toMatchObject({ outcomeStatus: "POSITIVE", outcomeMaturity: "CLOSED" });
  expect(outcomePayload.events.map((event) => event.type)).toEqual(expect.arrayContaining(["outcome.observed", "outcome.matured"]));
  const cell = capture(() => runCli(["cell", "check"]));
  expect(cell.code).toBe(0);
  expect(cell.stdout).toContain('"inspection": "cell"');
  expect(capture(() => runCli(["outcome", "check", "pending"])).stdout).toContain('"upgradesVerdict": false');
});
