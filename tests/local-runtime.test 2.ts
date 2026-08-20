import { describe, expect, test } from "vitest";
import {
  buildExecutionPlan,
  compareEvalAttempts,
  executeFactoryRun,
  hostedRuntimeDefaults,
  mayUseInlineSelfReview,
  MemoryFactoryStore,
  parseEvalSuite,
  parseFactoryDefinition,
  validateFactoryDefinition,
  runEvalSuite,
  scoreEvalOutput,
  soloRuntimeOverlay,
  validateInlineApproval,
  mergeRuntimeProfile,
  createSelfHostedDispatch,
  type FactoryEvent,
} from "../packages/factory/src";
import { publicCapabilities } from "../packages/control-plane/src/entitlements";
import { anthropicProvider, assertNoSecretInPayload, dockerSandboxPort, LOCAL_DB_SCHEMA_VERSION, processSandboxPort, replayOutbox, resolveCredentialRef, runExternalHarness, runLocalFactory, runSelfHostedDispatch, selectInferenceProvider, selectLocalSandbox, SQLITE_MAGIC, SqliteFactoryStore, stubInferenceProvider, stubSandboxPort } from "../packages/local-runtime/src";
import { evalCli, evalCliAsync, factoryPlanPayload } from "../packages/cli/src/runtime-cli";
import { localDashboardApi } from "../packages/cli/src/local-dashboard";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const yaml = "version: 1\nname: pay\nrepositories: [acme/pay]\n";

describe("runtime contracts", () => {
  test("v1 defaults to hosted multi-agent and v1alpha2 parses runtime", () => {
    const v1 = parseFactoryDefinition(yaml);
    expect(v1.schemaVersion).toBe("v1");
    expect(v1.runtime).toMatchObject(hostedRuntimeDefaults("github_actions"));
    const v2 = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  collaboration: solo\n  controlPlane: local\n  pipeline: adaptive\n  approval: inline_self_review\n  runner:\n    type: docker\n  inference:\n    mode: byok\n    provider: anthropic\n    credentialRef: env:ANTHROPIC_API_KEY\n  sync: offline\n`);
    expect(v2.schemaVersion).toBe("v1alpha2");
    expect(v2.runtime.collaboration).toBe("solo");
    expect(v2.runtime.inference.credentialRef).toBe("env:ANTHROPIC_API_KEY");
    expect(() => parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  inference:\n    mode: byok\n    credentialRef: sk-live-not-a-ref-value\n`)).toThrow(/credentialRef/);
    const external = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\ncontrolPlane: local\nagentDefaults:\n  harness: claude-code\n`);
    expect(external.agentDefaults?.harness).toBe("claude-code");
    expect(external.harnesses["claude-code"]).toMatchObject({ command: "claude" });
    const selfHosted = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  controlPlane: hosted\n  runner:\n    type: self_hosted\n    workerHost: self_hosted:runner-1\n  inference:\n    mode: byok\n    provider: openai\n    credentialRef: env:OPENAI_API_KEY\nagents:\n  - id: implementation\n    harness: codex\n`);
    expect(selfHosted.runtime).toMatchObject({ controlPlane: "hosted", runner: { type: "self_hosted" }, workerHost: "self_hosted:runner-1", inference: { mode: "byok" } });
    expect(validateFactoryDefinition(selfHosted)).toEqual([]);
    const agentBoundWorker = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  controlPlane: hosted\nagents:\n  - id: implementation\n    harness: codex\n    workerHost: self_hosted:runner-2\n`);
    expect(agentBoundWorker.runtime.runner.type).toBe("self_hosted");
    expect(agentBoundWorker.runtime.workerHost).toBe("self_hosted:runner-2");
    expect(validateFactoryDefinition(agentBoundWorker)).toEqual([]);
    const hostedExternal = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nagents:\n  - id: implementation\n    harness: codex\n`);
    expect(validateFactoryDefinition(hostedExternal).some((error) => /self_hosted|local control plane/.test(error))).toBe(true);
    expect(() => parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  controlPlane: hosted\n  runner:\n    type: docker\n`)).toThrow(/Hosted control planes cannot run/);
    expect(() => parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nharnesses:\n  default:\n    command: evil\n`)).toThrow(/cannot be redefined/);
  });

  test("planner is deterministic and never skips verification", () => {
    const profile = hostedRuntimeDefaults();
    const a = buildExecutionPlan({ sourceType: "github_pull_request", untrustedText: "typo", profile, diffs: { paths: ["README.md"], changedFileCount: 1, changedLines: 2 } });
    const b = buildExecutionPlan({ sourceType: "github_pull_request", untrustedText: "typo", profile, diffs: { paths: ["README.md"], changedFileCount: 1, changedLines: 2 } });
    expect(a.plan.skip).toEqual(b.plan.skip);
    expect(a.plan.stages.find((stage) => stage.id === "verification")?.include).toBe(true);
    const restricted = buildExecutionPlan({ sourceType: "github_issue", untrustedText: "rewrite authentication", profile, paths: ["src/auth/session.ts"], diffs: { paths: ["src/auth/session.ts"], changedFileCount: 1, changedLines: 40 } });
    expect(restricted.autonomyMode).toBe("restricted");
    expect(restricted.plan.escalationEligible).toBe(true);
    expect(restricted.plan.skip).not.toContain("verification");
  });

  test("inline self-review cannot be used by agents or restricted work", () => {
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "agent" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", autonomyMode: "restricted" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", lineId: "release" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", risk: "low" }).allowed).toBe(true);
    expect(validateInlineApproval({ approvalId: "a", workOrderId: "w", requester: "human", approver: "factory-agent", actorKind: "human", decision: "approved", createdAt: "now" }).ok).toBe(false);
  });

  test("single_agent escalates in place on restricted paths and still requires verification", async () => {
    const definition = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  pipeline: single_agent\n  controlPlane: local\n`);
    const store = new MemoryFactoryStore();
    const escalated = await executeFactoryRun({ definition, sourceType: "manual", untrustedText: "fix login", paths: [".github/workflows/x.yml"], store, specApproved: true, sandboxComplete: true, verificationIngested: true, verificationVerdict: "PASS" });
    expect(escalated.escalated || escalated.plan?.escalated).toBeTruthy();
    expect(escalated.stages.some((stage) => stage.stage === "verification")).toBe(true);
    const quiet = await executeFactoryRun({ definition, sourceType: "manual", untrustedText: "docs nits", store, actorKind: "human", specApproved: true, sandboxComplete: true, verificationIngested: true, verificationVerdict: "PASS" });
    expect(quiet.stages.some((stage) => stage.stage === "verification")).toBe(true);
    expect(quiet.plan?.cost.platformInvoice).toBe("seats_only");
  });
});

describe("local runtime", () => {
  test("persists and reconstructs the append-only Factory Graph", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-graph-"));
    const db = path.join(dir, "local.db");
    const store = new SqliteFactoryStore(db);
    const base = { aggregateId: "wo_graph", aggregateType: "work_order", organizationId: "local", factoryId: "local-factory", actorId: "deterministic-verifier", actorType: "system" as const, correlationId: "corr_graph", schemaVersion: 1 as const, provenance: "DETERMINISTICALLY_VERIFIED" as const };
    await store.appendFactoryEvent({ ...base, eventId: "event-1", type: "verification.completed", occurredAt: "2026-08-20T00:00:00.000Z", payload: { verdict: "PASS" } });
    await store.appendFactoryEvent({ ...base, eventId: "event-2", type: "review.completed", occurredAt: "2026-08-20T00:00:01.000Z", payload: { decision: "APPROVE" } });
    expect((await store.reconstructFactoryGraph("wo_graph"))).toMatchObject({ verificationVerdict: "PASS", reviewDecision: "APPROVE" });
    expect((await store.listOutbox()).filter((event) => event.kind === "factory-graph-event")).toHaveLength(2);
    const reopened = new SqliteFactoryStore(db);
    expect((await reopened.listFactoryEvents("wo_graph"))).toHaveLength(2);
    await expect(reopened.appendFactoryEvent({ ...base, eventId: "event-2", type: "release.requested", occurredAt: "2026-08-20T00:00:02.000Z", payload: {} } as FactoryEvent)).rejects.toThrow();
    await expect(reopened.appendFactoryEvent({ ...base, eventId: "event-secret", type: "task.decomposed", occurredAt: "2026-08-20T00:00:03.000Z", payload: { apiKey: "an-unprefixed-secret-value" } } as FactoryEvent)).rejects.toThrow(/Secrets/);
  });

  test("sqlite work order to stub sandbox receipt without secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-"));
    const db = path.join(dir, "local.db");
    const store = new SqliteFactoryStore(db);
    const definition = parseFactoryDefinition(yaml);
    definition.runtime = mergeRuntimeProfile(definition.runtime, soloRuntimeOverlay());
    const result = await runLocalFactory({
      definition,
      root: dir,
      store,
      inference: stubInferenceProvider(),
      sandbox: stubSandboxPort(),
      specApproved: true,
      sandboxComplete: true,
      verificationVerdict: "PASS",
      verificationIngested: true,
      untrustedText: "typo in readme",
    });
    expect(result.runId).toBeTruthy();
    expect(store.receipts.length).toBeGreaterThan(0);
    const persistedReceipt = store.receipts[0] as { signed?: boolean; receipt?: { integrity?: { signed?: boolean } } };
    expect(persistedReceipt.signed).toBe(false);
    expect(persistedReceipt.receipt?.integrity?.signed).toBe(false);
    expect(() => assertNoSecretInPayload(store.receipts[0])).not.toThrow();
    expect(resolveCredentialRef("env:TB_TEST_KEY", { TB_TEST_KEY: "abc" })).toBe("abc");
    expect(() => resolveCredentialRef("sk-raw")).toThrow();
    expect(() => resolveCredentialRef("keychain://../outside")).toThrow();
    expect(store.schemaVersion()).toBe(LOCAL_DB_SCHEMA_VERSION);
    expect(fs.readFileSync(db).subarray(0, 15).toString("utf8")).toBe(SQLITE_MAGIC);
    const graphEvents = await store.listFactoryEvents(result.workOrderId);
    expect(graphEvents.map((event) => event.type)).toEqual(expect.arrayContaining(["work_order.created", "worker.session_started", "worker.claim_emitted", "change.proposed", "evidence.receipt_created", "worker.session_completed", "task.decomposed", "verification.completed"]));
    expect((await store.reconstructFactoryGraph(result.workOrderId)).verificationVerdict).toBe("PASS");
  });

  test("local runs do not claim implementation when no worker completed the sandbox", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-pending-"));
    const store = new SqliteFactoryStore(path.join(dir, "local.db"));
    const definition = parseFactoryDefinition(yaml);
    definition.runtime = mergeRuntimeProfile(definition.runtime, soloRuntimeOverlay());
    const result = await runLocalFactory({ definition, root: dir, store, inference: stubInferenceProvider(), sandbox: stubSandboxPort(), specApproved: true, verificationVerdict: "UNKNOWN", untrustedText: "implement login" });
    expect(result.terminal).toBe("implementation");
    expect(result.stages.some((stage) => /Queued Cloudflare Sandbox/.test(stage.summary))).toBe(true);
    expect(store.receipts).toHaveLength(0);
  });

  test("migrates JSON local state into SQLite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-migrate-"));
    const db = path.join(dir, "local.db");
    fs.writeFileSync(db, `${JSON.stringify({
      schemaVersion: 14,
      orders: [],
      runs: [],
      stages: [],
      plans: [{ planId: "plan-json", origin: "local", profile: hostedRuntimeDefaults(), selectedPipeline: "multi_agent", stages: [], skip: [], runner: { type: "docker" }, estimatedDurationSeconds: 1, cost: { catalogVersion: "2026-08-18.seat-v1", plannedStages: [], estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedDurationSeconds: 1, managedCogsCents: 0, byokSpendCents: 0, platformInvoice: "seats_only", confidence: "low", rangeCents: { low: 0, high: 1 } }, escalationEligible: false, createdAt: "now" }],
      estimates: [],
      actuals: [],
      approvals: [],
      suites: [],
      attempts: [],
      outbox: [],
    })}\n`);
    const store = new SqliteFactoryStore(db);
    expect(store.migratedFromJson).toBe(true);
    expect(store.plans.get("plan-json")?.planId).toBe("plan-json");
    expect(fs.existsSync(`${db}.json.bak`)).toBe(true);
    expect(fs.readFileSync(db).subarray(0, 15).toString("utf8")).toBe(SQLITE_MAGIC);
  });

  test("stub sandbox is selected in CI and BYOK uses recorded fixtures", async () => {
    expect(selectLocalSandbox({ env: { VITEST: "1" } }).warning).toMatch(/stub sandbox/);
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: "fixture-ok" }], usage: { input_tokens: 3, output_tokens: 2 } }) });
    const provider = anthropicProvider("env:ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "test-key" }, fetchImpl);
    const result = await provider.run({ model: "claude-test", messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("fixture-ok");
    expect(provider.usage(result).inputTokens).toBe(3);
  });

  test("external harnesses receive a bounded protocol request and never echo credentials", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tb-harness-"));
    let observed: { argv: string[]; options?: { env?: Record<string, string>; stdin?: string; network?: "none" | "egress" } } | undefined;
    const result = await runExternalHarness({
      harness: { id: "codex", command: "codex-wrapper", args: ["--request", "${requestFile}", "--worktree", "${worktree}"], protocol: "stdio-json", network: "egress", env: { CODEX_API_KEY: "env:TB_HARNESS_SECRET" }, timeoutSeconds: 30 },
      worktree,
      repository: "acme/payments",
      workOrderId: "wo_harness",
      prompt: "Implement the approved change.",
      model: "codex-test",
      env: { TB_HARNESS_SECRET: "customer-secret-value" },
      exec: async (argv, options) => {
        observed = { argv, options };
        const requestPath = argv[argv.indexOf("--request") + 1]!;
        expect(JSON.parse(fs.readFileSync(requestPath, "utf8"))).toMatchObject({ protocolVersion: 1, harness: "codex", authority: { mayMerge: false, mayRelease: false, mayWriteVerificationVerdict: false } });
        return { stdout: "completed customer-secret-value", stderr: "", exitCode: 0 };
      },
    });
    expect(result.status).toBe("ok");
    expect(result.summary).not.toContain("customer-secret-value");
    expect(observed?.options?.env).toEqual({ CODEX_API_KEY: "customer-secret-value" });
    expect(observed?.options?.network).toBe("egress");
    expect(observed?.options?.stdin).toContain('"protocolVersion":1');
    expect(fs.readdirSync(worktree)).toHaveLength(0);
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test("external harness protocol uses the container-visible worktree path", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tb-harness-container-"));
    let observed: { argv: string[]; stdin?: string } | undefined;
    await runExternalHarness({
      harness: { id: "codex", command: "codex", args: ["--request", "${requestFile}", "--worktree", "${worktree}"], protocol: "stdio-json", env: {}, timeoutSeconds: 30 },
      worktree,
      executionWorktree: "/work",
      repository: "acme/payments",
      workOrderId: "wo_container",
      prompt: "Implement the approved change.",
      exec: async (argv, options) => {
        observed = { argv, stdin: options?.stdin };
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    expect(observed?.argv).toEqual(["codex", "--request", expect.stringMatching(/^\/work\//), "--worktree", "/work"]);
    expect(JSON.parse(observed?.stdin ?? "{}")).toMatchObject({ worktree: "/work" });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test("text harnesses receive the redacted prompt instead of raw credentials", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tb-harness-text-"));
    let stdin = "";
    await runExternalHarness({
      harness: { id: "codex", command: "codex", args: [], protocol: "text", env: {}, timeoutSeconds: 30 },
      worktree,
      repository: "acme/payments",
      workOrderId: "wo_text",
      prompt: "use token=gho_abcdefghijklmnop",
      exec: async (_argv, options) => { stdin = options?.stdin ?? ""; return { stdout: "ok", stderr: "", exitCode: 0 }; },
    });
    expect(stdin).not.toContain("gho_abcdefghijklmnop");
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test("host-process execution cannot claim network isolation", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tb-harness-process-network-"));
    await expect(runExternalHarness({
      harness: { id: "codex", command: "codex", args: [], protocol: "stdio-json", env: {}, timeoutSeconds: 30 },
      worktree,
      repository: "acme/payments",
      workOrderId: "wo_process_network",
      prompt: "Implement the approved change.",
      networkIsolation: false,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })).rejects.toThrow(/cannot enforce network=none/);
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test("self-hosted worker verifies dispatch, runs the configured harness, and posts only a signed completion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-self-hosted-worker-"));
    const secret = "self-hosted-worker-secret";
    const dispatch = createSelfHostedDispatch({
      dispatchId: "selfhost:wo_worker:run_worker",
      executionBoundary: "self_hosted",
      organizationId: "org_1",
      factoryId: "fac_1",
      workOrderId: "wo_worker",
      runId: "run_worker",
      repository: "acme/payments",
      sourceType: "manual",
      sourceId: "src_worker",
      definitionDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      harness: "codex",
      prompt: "Implement the approved change.",
      secret,
    });
    const posted: unknown[] = [];
    const result = await runSelfHostedDispatch({
      dispatch,
      secret,
      repositoryRoot: root,
      harnesses: { codex: { id: "codex", command: "codex", args: [], protocol: "stdio-json", network: "egress", env: {}, timeoutSeconds: 30 } },
      definitionDigest: dispatch.definitionDigest,
      sandbox: {
        kind: "process",
        start: async () => ({ worktree: root, branch: "tinkerbot/wo_worker", cleanup: async () => undefined }),
        exec: async (_worktree, argv) => argv[0] === "git" ? { stdout: "abcdef1234567\n", stderr: "", exitCode: 0 } : { stdout: "harness complete", stderr: "", exitCode: 0 },
      },
      completionUrl: "https://control.example/self-hosted/complete",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ accepted: true, status: "completed", dispatchId: dispatch.dispatchId });
    expect(posted[0]).toMatchObject({ status: "completed", branch: "tinkerbot/wo_worker", headSha: "abcdef1234567", integrity: { signed: true } });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("self-hosted worker refuses stale local definitions and non-isolated sandboxes", async () => {
    const dispatch = createSelfHostedDispatch({
      dispatchId: "selfhost:wo_digest:run_digest",
      executionBoundary: "self_hosted",
      organizationId: "org_1",
      factoryId: "fac_1",
      workOrderId: "wo_digest",
      runId: "run_digest",
      repository: "acme/payments",
      sourceType: "manual",
      sourceId: "src_digest",
      definitionDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      harness: "codex",
      prompt: "Implement the approved change.",
      secret: "self-hosted-worker-secret",
    });
    const result = await runSelfHostedDispatch({
      dispatch,
      secret: "self-hosted-worker-secret",
      repositoryRoot: process.cwd(),
      harnesses: { codex: { id: "codex", command: "codex", args: [], protocol: "stdio-json", network: "egress", env: {}, timeoutSeconds: 30 } },
      definitionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sandbox: { kind: "stub", start: async () => { throw new Error("must not start"); }, exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
      completionUrl: "https://control.example/self-hosted/complete",
      fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ accepted: false, status: "failed", reason: "definition_digest_mismatch" });
  });

  test("self-hosted worker does not fail a run when the dispatch belongs to another worker", async () => {
    const dispatch = createSelfHostedDispatch({
      dispatchId: "selfhost:wo_route:run_route",
      executionBoundary: "self_hosted",
      organizationId: "org_1",
      factoryId: "fac_1",
      workOrderId: "wo_route",
      runId: "run_route",
      repository: "acme/payments",
      sourceType: "manual",
      sourceId: "src_route",
      definitionDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      harness: "codex",
      prompt: "Implement the approved change.",
      secret: "self-hosted-worker-secret",
    });
    let posted = false;
    const result = await runSelfHostedDispatch({
      dispatch,
      secret: "self-hosted-worker-secret",
      repositoryRoot: process.cwd(),
      workerHost: "self_hosted:runner-2",
      harnesses: { codex: { id: "codex", command: "codex", args: [], protocol: "stdio-json", workerHost: "self_hosted:runner-1", env: {}, timeoutSeconds: 30 } },
      definitionDigest: dispatch.definitionDigest,
      sandbox: { kind: "docker", start: async () => { throw new Error("must not start"); }, exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
      completionUrl: "https://control.example/self-hosted/complete",
      fetchImpl: (async () => { posted = true; return new Response("ok", { status: 200 }); }) as typeof fetch,
    });
    expect(result).toMatchObject({ accepted: false, status: "failed", reason: "harness_not_configured" });
    expect(posted).toBe(false);
  });

  test("process runner does not follow repository symlinks into the host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-symlink-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-symlink-secret-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "do-not-copy");
    fs.symlinkSync(outside, path.join(root, "linked-outside"));
    const lease = await processSandboxPort(true).start({ repositoryRoot: root, workOrderId: "wo_symlink", image: "" });
    expect(fs.existsSync(path.join(lease.worktree, "linked-outside"))).toBe(false);
    await lease.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("Docker sandbox passes only explicit harness env names into the container", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-docker-env-root-"));
    fs.writeFileSync(path.join(root, "README.md"), "safe");
    const calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
    const fakeExec = ((command: string, args: string[], options?: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    }) as unknown as typeof import("node:child_process").spawnSync;
    const sandbox = dockerSandboxPort(fakeExec);
    const lease = await sandbox.start({ repositoryRoot: root, workOrderId: "wo_env" });
    await sandbox.exec(lease.worktree, ["codex"], { env: { OPENAI_API_KEY: "sk-test-secret" } });
    const run = calls.find((call) => call.command === "docker" && call.args[0] === "run");
    expect(run?.args).toContain("--env");
    expect(run?.args).toContain("OPENAI_API_KEY");
    expect(run?.args).not.toContain("sk-test-secret");
    expect((run?.options?.env as Record<string, string>).OPENAI_API_KEY).toBe("sk-test-secret");
    await lease.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("outbox replay posts local payloads without secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-outbox-"));
    const store = new SqliteFactoryStore(path.join(dir, "local.db"));
    await store.enqueueOutbox({ eventId: "evt_1", kind: "factory-run", payloadJson: JSON.stringify({ runId: "r1", origin: "local" }), createdAt: "now" });
    const posted: unknown[] = [];
    const result = await replayOutbox(store, async (kind, payload) => {
      posted.push({ kind, payload });
      return { ok: true, status: 200 };
    });
    expect(result.synced).toBe(1);
    expect(posted[0]).toMatchObject({ kind: "factory-run" });
    expect(store.outbox[0]?.syncedAt).toBeTruthy();
  });

  test("local dashboard adapter serves plan/cost/eval JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dash-"));
    const store = new SqliteFactoryStore(path.join(dir, "local.db"));
    const session = localDashboardApi(store, new URL("http://127.0.0.1/auth/session"), "GET");
    expect(session?.body).toMatchObject({ organizationId: "local", local: true });
    const runtime = localDashboardApi(store, new URL("http://127.0.0.1/local/runtime"), "GET");
    expect(runtime?.body).toMatchObject({ billing: "seats_only", upgradesVerdict: false });
    const exceptions = localDashboardApi(store, new URL("http://127.0.0.1/exceptions"), "GET");
    expect(exceptions?.body).toMatchObject({ kanban: false, attentionFirst: true });
  });

  test("reopening a pre-graph SQLite store backfills a canonical creation event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-graph-backfill-"));
    const db = path.join(dir, "local.db");
    const order = {
      workOrderId: "wo_backfill",
      factoryId: "local-factory",
      organizationId: "local",
      sourceType: "manual" as const,
      sourceId: "legacy:1",
      repositoryId: "local/repo",
      policyVersion: "default",
      definitionVersion: "v1",
      definitionDigest: "sha256:legacy",
      currentStage: "foreman" as const,
      status: "intake" as const,
      actor: "local-human",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      verificationVerdict: "UNKNOWN" as const,
      reviewAssessment: "NEEDS_HUMAN_REVIEW" as const,
      releaseDecision: "BLOCKED" as const,
    };
    const first = new SqliteFactoryStore(db);
    await first.insertWorkOrder(order);
    const reopened = new SqliteFactoryStore(db);
    expect(await reopened.listFactoryEvents(order.workOrderId)).toMatchObject([{ type: "work_order.created", aggregateId: order.workOrderId }]);
  });

  test("local dashboard exposes the append-only work-order graph projection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dash-graph-"));
    const store = new SqliteFactoryStore(path.join(dir, "local.db"));
    const order = {
      workOrderId: "wo_dashboard_graph",
      factoryId: "local-factory",
      organizationId: "local",
      sourceType: "manual" as const,
      sourceId: "local:graph",
      repositoryId: "local/repo",
      policyVersion: "default",
      definitionVersion: "v1",
      definitionDigest: "sha256:test",
      currentStage: "verification" as const,
      status: "verification" as const,
      actor: "local-human",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      verificationVerdict: "UNKNOWN" as const,
      reviewAssessment: "NEEDS_HUMAN_REVIEW" as const,
      releaseDecision: "BLOCKED" as const,
    };
    await store.insertWorkOrder(order);
    await store.appendFactoryEvent({ eventId: "dash-verify", type: "verification.completed", aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: "local", factoryId: "local-factory", actorId: "deterministic-verifier", actorType: "system", occurredAt: "2026-08-20T00:01:00.000Z", correlationId: order.workOrderId, schemaVersion: 1, provenance: "DETERMINISTICALLY_VERIFIED", payload: { verdict: "PASS" } });
    const response = localDashboardApi(store, new URL(`http://127.0.0.1/work-orders/${order.workOrderId}/graph`), "GET");
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ sourceOfTruth: "append_only_factory_graph", graph: { verificationVerdict: "PASS" } });
    expect((response?.body as { events: unknown[] }).events).toHaveLength(1);
  });

  test("missing BYOK does not fall back to workers-ai", () => {
    expect(() => selectInferenceProvider({
      mode: "byok",
      env: { TINKERBOT_STUB_INFERENCE: "0", VITEST: "1" },
    })).toThrow(/no BYOK credentialRef resolved/);
    const stub = selectInferenceProvider({ mode: "byok", env: { VITEST: "1", TINKERBOT_STUB_INFERENCE: "1" } });
    expect(stub.id).not.toBe("workers-ai");
    expect(stub.id).toBe("stub");
  });

  test("OpenRouter is an OpenAI-compatible customer baseUrl", () => {
    const provider = selectInferenceProvider({
      mode: "byok",
      provider: "openrouter",
      credentialRef: "env:OPENROUTER_API_KEY",
      env: { OPENROUTER_API_KEY: "sk-or-test", TINKERBOT_STUB_INFERENCE: "0" },
    });
    expect(provider.id).toBe("openai");
  });

  test("evals stay advisory", () => {
    const suite = parseEvalSuite("name: personal\ntasks:\n  - id: t1\n    prompt: hello\n    expected: hello\n");
    const attempts = runEvalSuite(suite, () => "hello");
    expect(scoreEvalOutput(suite.tasks[0]!, "hello")[0]?.upgradesVerdict).toBe(false);
    expect(compareEvalAttempts(attempts, attempts).upgradesVerdict).toBe(false);
  });
});

describe("entitlements", () => {
  test("local/BYOK/evals are included without a solo billing tier", () => {
    expect(publicCapabilities("free").local_execution).toBe("included");
    expect(publicCapabilities("free").byok_inference).toBe("included");
    expect(publicCapabilities("developer").portable_eval_suites).toBe("included");
    expect(publicCapabilities("free").private_execution).toBe("unavailable");
    expect(publicCapabilities("enterprise").private_execution).toBe("custom");
  });
});

describe("cli helpers", () => {
  test("factory plan payload is a dry run", () => {
    const root = path.join(process.cwd(), "fixtures/factory/v1alpha1");
    const payload = factoryPlanPayload(root, "solo", "typo");
    expect(payload.dryRun).toBe(true);
    expect(payload.sideEffects).toBe(false);
    expect(JSON.stringify(payload.cost)).not.toContain("managedCogsCents");
    expect(JSON.stringify(payload.cost)).not.toContain("catalogVersion");
  });

  test("eval init writes yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-eval-"));
    fs.mkdirSync(path.join(dir, ".git"));
    const result = evalCli(dir, "init");
    expect(result.initialized).toBe(true);
    expect(fs.existsSync(path.join(dir, ".tinkerbot/evals/personal-suite.yaml"))).toBe(true);
  });

  test("eval run stays advisory even with a customer provider path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-eval-run-"));
    fs.mkdirSync(path.join(dir, ".git"));
    evalCli(dir, "init");
    evalCli(dir, "add", "hello");
    const payload = await evalCliAsync(dir, "run");
    expect(payload.upgradesVerdict).toBe(false);
    expect(payload.customerProvider).toBe(true);
  });
});
