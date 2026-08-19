import { planVerificationStreams, subsetPendingMessage } from "../packages/cli/src/tui/streams";
import { helpText, parseIntent, suggestSlash } from "../packages/cli/src/tui/commands";
import { hostedStageTools, hostedVerificationFromView } from "../packages/cli/src/tui/hosted";
import { renderSession, stripAnsi } from "../packages/cli/src/tui/render";
import { applyStageEvent, createSession, handleKey, submitLine } from "../packages/cli/src/tui/session";
import { dispatchIntentSync, isInteractiveTty, runTui, type TuiDeps } from "../packages/cli/src/tui";
import type { TestSelectionPlan } from "../packages/core/src/types";
import { dispatchTui, mainAsync, runCli } from "../packages/cli/src";

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write);
  try { return { code: fn(), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}

async function captureAsync(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write);
  try { return { code: await run(), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}

function selection(overrides: Partial<TestSelectionPlan>): TestSelectionPlan {
  return {
    status: "pass",
    confidence: "high",
    selected: ["tests/a.test.ts"],
    related: ["tests/b.test.ts"],
    unrelated: ["tests/c.test.ts"],
    unknown: [],
    requiresFullSuite: false,
    fallback: "Run the selected tests first, then run the full suite before merge.",
    reasons: [],
    unknowns: [],
    ...overrides,
  };
}

const flags = {
  runBaseTests: true,
  runMutation: false,
  watchSubset: true,
  coverageConfigured: true,
  fixturesEnabled: true,
  testCommand: "pnpm test --run",
};

function deps(overrides: Partial<TuiDeps> = {}): TuiDeps & { stdout: { chunks: string[]; write: (chunk: string) => boolean; isTTY: boolean; columns: number }; stderr: { chunks: string[]; write: (chunk: string) => boolean } } {
  const stdout = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); return true; }, isTTY: false, columns: 80 };
  const stderr = { chunks: [] as string[], write(chunk: string) { this.chunks.push(chunk); return true; } };
  return {
    header: () => ({ repo: "acme/api", base: "origin/main", head: "HEAD", cwd: "/tmp" }),
    createReport: (run) => {
      run.onStage?.({ type: "stage_start", id: "select", label: "SelectTests", feedsVerdict: false });
      run.onStage?.({ type: "stage_end", id: "select", status: "done", summary: "8 selected · full suite required", feedsVerdict: false });
      run.onStage?.({ type: "stage_start", id: "subset", label: "Subset", feedsVerdict: false });
      run.onStage?.({ type: "stage_end", id: "subset", status: "locked", summary: "full-suite fallback is required.", feedsVerdict: false });
      return {
      schemaVersion: 1 as const,
      toolVersion: "0.1.0",
      repository: "acme/api",
      base: "origin/main",
      head: "HEAD",
      verdict: "UNKNOWN" as const,
      summary: { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 },
      findings: [],
      limitations: ["Missing coverage artifact."],
      };
    },
    reportExitCode: (report) => report.verdict === "UNKNOWN" ? 2 : 0,
    openDashboard: () => 0,
    stdout,
    stderr,
    stdin: process.stdin,
    env: { ...process.env, CI: "true" },
    cwd: "/tmp",
    ...overrides,
  } as TuiDeps & { stdout: { chunks: string[]; write: (chunk: string) => boolean; isTTY: boolean; columns: number }; stderr: { chunks: string[]; write: (chunk: string) => boolean } };
}

test("stream planner locks subset when impact is uncertain", () => {
  const planned = planVerificationStreams(selection({ requiresFullSuite: true, selected: ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"], related: [], unrelated: [], fallback: "full-suite fallback is required." }), flags);
  const subset = planned.find((stream) => stream.id === "subset")!;
  const select = planned.find((stream) => stream.id === "select")!;
  const suite = planned.find((stream) => stream.id === "suite")!;
  expect(subset.feedsVerdict).toBe(false);
  expect(select.feedsVerdict).toBe(false);
  expect(subset.locked).toBe(true);
  expect(subset.lockReason).toContain("full-suite fallback");
  expect(suite.feedsVerdict).toBe(true);
  expect(suite.enabled).toBe(true);
});

test("stream planner allows an early subset that still cannot feed the verdict", () => {
  const planned = planVerificationStreams(selection({}), flags);
  const subset = planned.find((stream) => stream.id === "subset")!;
  expect(subset.enabled).toBe(true);
  expect(subset.locked).toBe(false);
  expect(subset.feedsVerdict).toBe(false);
  expect(subsetPendingMessage(true, false)).toBe("early signal passed · verdict pending");
  expect(subsetPendingMessage(true, true, "UNKNOWN")).toContain("not the gate");
  expect(subsetPendingMessage(false, false)).toBeUndefined();
  const whole = planVerificationStreams(selection({ selected: ["tests/a.test.ts"], related: [], unrelated: [], unknown: [] }), flags);
  expect(whole.find((stream) => stream.id === "subset")!.locked).toBe(true);
});

test("disabled base tests lock the suite stream as UNKNOWN evidence", () => {
  const planned = planVerificationStreams(selection({}), { ...flags, runBaseTests: false });
  const suite = planned.find((stream) => stream.id === "suite")!;
  expect(suite.locked).toBe(true);
  expect(suite.lockReason).toMatch(/UNKNOWN/);
});

test("slash parser rejects merge and pass and treats check as the session verb", () => {
  expect(parseIntent("/merge")).toEqual({ type: "reject", command: "/merge", reason: expect.stringContaining("cannot merge") });
  expect(parseIntent("/pass")).toEqual({ type: "reject", command: "/pass", reason: expect.stringContaining("cannot write PASS") });
  expect(parseIntent("/fail")).toMatchObject({ type: "reject" });
  expect(parseIntent("")).toEqual({ type: "none" });
  expect(parseIntent("/check")).toEqual({ type: "check" });
  expect(parseIntent("/impact")).toEqual({ type: "impact" });
  expect(parseIntent("/select-tests")).toEqual({ type: "select-tests" });
  expect(parseIntent("/select")).toEqual({ type: "select-tests" });
  expect(parseIntent("/steer retry the spec")).toEqual({ type: "steer", text: "retry the spec" });
  expect(parseIntent("/take")).toEqual({ type: "take" });
  expect(parseIntent("/return")).toEqual({ type: "return" });
  expect(parseIntent("/approve")).toEqual({ type: "approve" });
  expect(parseIntent("/dashboard")).toEqual({ type: "dashboard" });
  expect(parseIntent("/clear")).toEqual({ type: "clear" });
  expect(parseIntent("/help")).toEqual({ type: "help" });
  expect(parseIntent("/exit")).toEqual({ type: "exit" });
  expect(parseIntent("/quit")).toEqual({ type: "exit" });
  expect(parseIntent("/unknown")).toMatchObject({ type: "reject", command: "/unknown" });
  expect(parseIntent("run verification")).toEqual({ type: "check" });
  expect(parseIntent("impact")).toEqual({ type: "impact" });
  expect(parseIntent("select tests")).toEqual({ type: "select-tests" });
  expect(parseIntent("help")).toEqual({ type: "help" });
  expect(parseIntent("quit")).toEqual({ type: "exit" });
  expect(parseIntent("fix the tests")).toMatchObject({ type: "reject" });
  expect(parseIntent("/work")).toMatchObject({ type: "reject" });
  expect(parseIntent("/work wo_1")).toEqual({ type: "work", id: "wo_1" });
  expect(suggestSlash("/c").map((item) => item.name)).toContain("/check");
  expect(suggestSlash("check")).toEqual([]);
  expect(helpText()).toContain("/check");
});

test("hosted agent stage text cannot become PASS without ingest", () => {
  const claimed = hostedVerificationFromView({
    workOrder: { status: "verification", currentStage: "verification", verificationIngested: false },
    stages: [{ stage: "verification", status: "ok", summary: "tests passed PASS" }],
  });
  expect(claimed.ingested).toBe(false);
  expect(claimed.verdict).toBe("UNKNOWN");
  expect(claimed.detail).toMatch(/not a verdict/);
  expect(hostedVerificationFromView({ workOrder: {}, stages: [] }).detail).toMatch(/Waiting for Action OIDC ingest/);
  const ingested = hostedVerificationFromView({
    workOrder: { verificationIngested: true, verificationVerdict: "NEEDS_REVIEW" },
    stages: [{ summary: "PASS" }],
  });
  expect(ingested.verdict).toBe("NEEDS_REVIEW");
  expect(hostedVerificationFromView({ workOrder: { verificationIngested: true, verificationVerdict: "SHIP_IT" } }).verdict).toBe("UNKNOWN");
  expect(hostedStageTools({ stages: [{ stage: "triage", status: "running" }] })[0]).toMatchObject({ status: "running", name: "triage" });
});

test("renderer looks like a Claude Code transcript", () => {
  let session = createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" });
  session = { ...session, input: "/ch" };
  session = applyStageEvent(submitLine({ ...session, input: "/check" }).session, { type: "stage_start", id: "suite", label: "Bash(pnpm test --run)" });
  session = applyStageEvent(session, { type: "stage_end", id: "suite", status: "done", summary: "configured suite", feedsVerdict: true });
  const text = stripAnsi(renderSession(session, { columns: 72, color: true, showPrompt: true }));
  expect(text).toContain("Tinkerbot");
  expect(text).toContain("❯ /check");
  expect(text).toContain("Bash(pnpm test --run)");
  expect(text).toContain("╭");
  expect(text).toContain("/ for commands");
  expect(stripAnsi(renderSession({ ...createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" }), input: "/ch" }, { columns: 72, color: true, showPrompt: true }))).toContain("/check");
});

test("key handler submits and exits like a terminal session", () => {
  let session = createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" });
  session = handleKey(session, "/").session;
  session = handleKey(session, "c").session;
  expect(session.input).toBe("/c");
  expect(handleKey(session, "\r").submit).toBe(true);
  expect(handleKey({ ...session, input: "" }, "\u0003").exit).toBe(true);
  expect(handleKey({ ...session, input: "/c" }, "\u0003").session.input).toBe("");
  expect(handleKey({ ...session, input: "" }, "\u0004").exit).toBe(true);
  expect(handleKey({ ...session, input: "/c" }, "\u007f").session.input).toBe("/");
  expect(handleKey({ ...session, busy: true, input: "/c" }, "x").session.input).toBe("/c");
  expect(handleKey(session, "\u001b[A").session.input).toBe(session.input);
  expect(handleKey({ ...session, busy: false }, "\u001b").session.input).toBe("");
  expect(submitLine({ ...session, input: "" }).intent).toEqual({ type: "none" });
  expect(submitLine({ ...session, input: "/clear" }).session.blocks).toHaveLength(1);
  expect(submitLine({ ...session, input: "/help" }).session.blocks.at(-1)).toMatchObject({ kind: "assistant" });
});

test("non-TTY tb tui does not run a check", () => {
  const io = deps();
  expect(isInteractiveTty(io.stdout, io.stdin, io.env)).toBe(false);
  expect(runTui({ baseTests: true }, io)).toBe(2);
  expect(io.stderr.chunks.join("")).toMatch(/requires a TTY/);
});

test("once mode prints a check transcript and uses tb check exit codes", () => {
  const io = deps();
  const events: string[] = [];
  io.createReport = (run) => {
    run.onStage?.({ type: "stage_start", id: "select", label: "SelectTests", feedsVerdict: false });
    run.onStage?.({ type: "stage_end", id: "select", status: "done", summary: "8 selected · full suite required", feedsVerdict: false });
    events.push("ran");
    return deps().createReport(run);
  };
  expect(runTui({ baseTests: true, once: true }, io)).toBe(2);
  expect(events).toEqual(["ran"]);
  expect(io.stdout.chunks.join("")).toContain("SelectTests");
  expect(io.stdout.chunks.join("")).toContain("UNKNOWN");
});

test("subset status is ignored when setting the session verdict", () => {
  const io = deps();
  let session = createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" });
  session = submitLine({ ...session, input: "/check" }).session;
  const result = dispatchIntentSync(session, { type: "check" }, io, { baseTests: true });
  expect(result.report?.verdict).toBe("UNKNOWN");
  expect(result.session.lastVerdict).toBe("UNKNOWN");
  const subset = result.session.blocks.find((block) => block.kind === "tool" && block.id === "select");
  if (subset && subset.kind === "tool") expect(subset.feedsVerdict).toBe(false);
});

test("work attach keeps agent PASS as UNKNOWN without ingest", () => {
  const io = deps({
    fetchWork: () => ({
      workOrder: { workOrderId: "wo_1", verificationIngested: false },
      stages: [{ stage: "verification", status: "ok", summary: "tests passed PASS" }],
    }),
  });
  const session = submitLine({ ...createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" }), input: "/work wo_1" }).session;
  const result = dispatchIntentSync(session, { type: "work", id: "wo_1" }, io, { baseTests: true });
  expect(result.session.lastVerdict).toBe("UNKNOWN");
  expect(stripAnsi(renderSession(result.session))).toMatch(/not a verdict|UNKNOWN/);
});

test("CLI splits tui from dashboard and documents the session", () => {
  const help = capture(() => runCli(["tui", "--help"]));
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: tb tui");
  expect(capture(() => runCli(["dashboard", "--help"])).stdout).toContain("dashboard");
  expect(capture(() => runCli(["tui"])).code).toBe(2);
  expect(capture(() => runCli(["tui", "merge"])).code).toBe(3);
  expect(capture(() => runCli(["tui", "--agent", "nope"])).code).toBe(3);
  expect(capture(() => runCli(["agents"])).stdout).toContain("storesVendorTokens");
  expect(capture(() => runCli(["agents", "--help"])).stdout).toContain("tb agents");
  expect(capture(() => runCli(["factory", "--help"])).stdout).toContain("tb factory new");
  expect(capture(() => runCli(["logout"])).code).toBe(12);
  expect(capture(() => runCli(["doctor"])).stdout).toContain("PR Proof doctor");
});

test("session slash actions stay local until a work order is attached", () => {
  const io = deps({ workAction: () => ({ ok: true, message: "take recorded." }) });
  let session = createSession({ repo: "acme/api", base: "origin/main", head: "HEAD", version: "0.1.0" });
  expect(dispatchIntentSync(session, { type: "exit" }, io, { baseTests: true }).exit).toBe(true);
  expect(dispatchIntentSync(session, { type: "dashboard" }, io, { baseTests: true }).dashboard).toBe(true);
  expect(dispatchIntentSync(session, { type: "steer", text: "retry" }, io, { baseTests: true }).session.blocks.at(-1)).toMatchObject({ kind: "assistant" });
  session = { ...session, workOrderId: "wo_1" };
  expect(dispatchIntentSync(session, { type: "take" }, io, { baseTests: true }).session.blocks.at(-1)).toMatchObject({ kind: "assistant" });
  expect(dispatchIntentSync(session, { type: "approve" }, io, { baseTests: true }).session.blocks.at(-1)).toMatchObject({ kind: "assistant" });
  expect(dispatchIntentSync(session, { type: "select-tests" }, io, { baseTests: true }).report?.verdict).toBe("UNKNOWN");
});

test("mainAsync tui work attaches hosted ingest state without rewriting PASS", async () => {
  const previousUrl = process.env.TINKERBOT_CONTROL_PLANE_URL;
  const previousToken = process.env.TINKERBOT_SESSION_TOKEN;
  process.env.TINKERBOT_CONTROL_PLANE_URL = "https://control.example";
  process.env.TINKERBOT_SESSION_TOKEN = "sessiontokenvalue012345";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/work-orders/wo_1/take")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.includes("/work-orders/wo_1")) return new Response(JSON.stringify({ workOrder: { workOrderId: "wo_1", verificationIngested: false }, stages: [{ stage: "verification", status: "ok", summary: "tests passed PASS" }] }), { status: 200 });
    return new Response(JSON.stringify({ error: String(init?.method ?? "GET") }), { status: 404 });
  };
  try {
    const attached = await captureAsync(() => mainAsync(["tui", "work", "wo_1"]));
    expect(attached.stdout).toMatch(/not a verdict|UNKNOWN/);
    expect([0, 2]).toContain(attached.code);
    const failed = await captureAsync(() => mainAsync(["tui", "work", "missing"]));
    expect([0, 2]).toContain(failed.code);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.TINKERBOT_CONTROL_PLANE_URL; else process.env.TINKERBOT_CONTROL_PLANE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TINKERBOT_SESSION_TOKEN; else process.env.TINKERBOT_SESSION_TOKEN = previousToken;
  }
});

test("dispatchTui launches the tabbed master when interactive", async () => {
  const { Readable } = await import("node:stream");
  const io = deps();
  io.stdin = Readable.from(["/check\n", "/work wo_1\n", "/exit\n"]) as typeof io.stdin;
  io.fetchWork = () => ({ workOrder: { workOrderId: "wo_1", verificationVerdict: "UNKNOWN" } });
  const code = await dispatchTui({ baseTests: true, agent: "shell", subcommand: "work", positional: "wo_1" }, io, true);
  expect(code).toBe(0);
  expect(await dispatchTui({ baseTests: true, once: true }, io, false)).toBe(2);
  expect(await dispatchTui({ baseTests: true, help: true }, io, true)).toBe(0);
});
