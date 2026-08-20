import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { applyLeaderChord, applyMasterIntent, createMasterState, parseMasterIntent, renderTabBody, renderTabStrip, MASTER_HELP } from "../packages/tui/src/tabs";
import { detectAgents, resolveAgentBin, spawnSpec } from "../packages/tui/src/agents";
import { attachAgentPty } from "../packages/tui/src/pty";
import { processMasterCommand, runMasterTui, runMasterTuiInteractive, listAgentsJson } from "../packages/tui/src";
import { CLAUDE_CODE_KIT_FORBIDDEN, tuiRejectsTinkerMention } from "../packages/tui/src/kit";

function deps() {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    cwd: "/tmp",
    env: { SHELL: "/bin/sh" },
    header: () => ({ repo: "acme/api", base: "origin/main", head: "HEAD" }),
    openDashboard: () => 0,
  };
}

test("master slash rejects merge and pass and opens agent tabs", () => {
  const state = createMasterState({ repo: "acme/api", base: "origin/main", head: "HEAD" });
  expect(parseMasterIntent("/merge")).toMatchObject({ type: "reject", command: "/merge" });
  expect(parseMasterIntent("/pass")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/fail")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/approve-verdict")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/claude")).toEqual({ type: "open-agent", id: "claude" });
  expect(parseMasterIntent("/factory sync")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/factory list")).toEqual({ type: "factory", sub: "list" });
  expect(parseMasterIntent("/plan")).toEqual({ type: "plan" });
  expect(parseMasterIntent("/cost")).toEqual({ type: "cost" });
  expect(parseMasterIntent("/eval")).toEqual({ type: "eval" });
  expect(parseMasterIntent("/factory show fac_1")).toEqual({ type: "factory", sub: "show", id: "fac_1" });
  expect(parseMasterIntent("/tab close")).toEqual({ type: "tab-close" });
  expect(parseMasterIntent("/tab nope")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/work")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("check")).toEqual({ type: "check" });
  expect(parseMasterIntent("hello")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("@tinker status")).toMatchObject({ type: "reject", reason: expect.stringMatching(/GitHub|Slack/) });
  const withWork = applyMasterIntent(state, { type: "work", id: "wo_1" });
  expect(withWork.tabs.some((tab) => tab.kind === "work")).toBe(true);
  expect(applyMasterIntent(withWork, { type: "work", id: "wo_1" }).active).toBe(withWork.active);
  const withAgent = applyMasterIntent(withWork, { type: "open-agent", id: "claude" });
  expect(renderTabStrip(withAgent)).toContain("claude");
  expect(applyMasterIntent(withAgent, { type: "open-agent", id: "claude" }).tabs.filter((tab) => tab.agentId === "claude")).toHaveLength(1);
  expect(applyMasterIntent(withAgent, { type: "tab-next" }).active).not.toBe(withAgent.active);
  expect(applyMasterIntent(withAgent, { type: "tab-prev" }).active).toBeDefined();
  expect(applyLeaderChord(withAgent, "n").active).not.toBe(withAgent.active);
  expect(applyLeaderChord(withAgent, "p").tabs).toHaveLength(3);
  expect(applyLeaderChord(state, "w").status).toMatch(/cannot be closed|Leader/);
  expect(applyLeaderChord(withAgent, "w").tabs.some((tab) => tab.kind === "agent")).toBe(false);
  expect(applyLeaderChord(withAgent, "x").status).toContain("Leader ctrl-g");
  expect(applyMasterIntent(withAgent, { type: "reject", command: "/merge", reason: "no" }).status).toBe("no");
  expect(renderTabBody(state)).toContain("Check tab");
  expect(renderTabBody(withWork)).toContain("Work wo_1");
  expect(renderTabBody(withAgent)).toContain("nested agentic terminal");
  expect(MASTER_HELP).toContain("pnpm tb tui");
  expect(tuiRejectsTinkerMention("@tinker hi")).toBe(true);
  expect(CLAUDE_CODE_KIT_FORBIDDEN).toEqual(["@claude-code-kit/agent"]);
});

test("PATH detection uses env overrides and never claims vendor tokens", () => {
  const env = { PATH: "/no/such/bin", SHELL: "/bin/sh", TINKERBOT_CLAUDE_BIN: "/bin/sh", TINKERBOT_CURSOR_BIN: "/bin/sh" };
  expect(resolveAgentBin("claude", env)).toBe("/bin/sh");
  expect(resolveAgentBin("cursor", env)).toBe("/bin/sh");
  expect(resolveAgentBin("shell", env)).toBe("/bin/sh");
  const agents = detectAgents({ PATH: "/no/such/bin", SHELL: "/bin/sh" });
  expect(agents.find((item) => item.id === "cursor")?.present).toBe(false);
  expect(agents.every((item) => item.oauth === "child-cli")).toBe(true);
  expect(JSON.parse(listAgentsJson(env)).storesVendorTokens).toBe(false);
  expect(spawnSpec("gemini", "/tmp", { PATH: "/no/such" })).toMatchObject({ error: expect.stringMatching(/not found/) });
  expect(spawnSpec("shell", "/tmp", env)).toMatchObject({ bin: "/bin/sh", trust: expect.stringMatching(/user-owned|gh pr merge/) });
  const nested = spawnSpec("claude", "/tmp", { ...env, GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret" });
  expect("env" in nested && nested.env.GH_TOKEN).toBeUndefined();
  expect("env" in nested && nested.env.GITHUB_TOKEN).toBeUndefined();
  expect("trust" in nested && nested.trust).toMatch(/merge tokens stripped/);
});

test("PTY spawn is mockable and runMasterTui seeds work and agent tabs", () => {
  const spawned: string[] = [];
  const child = { pid: 42, on() { return child; }, once(_event: string, listener: () => void) { listener(); return child; } };
  const attached = attachAgentPty("shell", "/tmp", { SHELL: "/bin/sh" }, { spawn: ((bin: string) => { spawned.push(bin); return child; }) as unknown as typeof import("node:child_process").spawn });
  expect(attached.process?.pid).toBe(42);
  expect(spawned[0]).toBe("/bin/sh");
  const stdout: string[] = [];
  const result = runMasterTui({ workOrderId: "wo_9", agent: "shell" }, {
    ...deps(),
    stdout: { write(chunk) { stdout.push(chunk); return true; } },
    attachPty: () => ({ trust: "user-owned", process: child as never }),
  });
  expect(result.attached).toBe("shell");
  expect(stdout.join("")).toContain("Work wo_9");
  expect(runMasterTui({ help: true }, { ...deps(), stdout: { write(chunk) { stdout.push(chunk); return true; } } }).code).toBe(0);
  const missing = runMasterTui({ agent: "claude" }, {
    ...deps(),
    env: { PATH: "/no/such" },
    attachPty: () => ({ error: "missing", trust: "install" }),
  });
  expect(missing.code).toBe(2);
  const checked = processMasterCommand(result.state, "/check", {
    ...deps(),
    createReport: () => ({ verdict: "UNKNOWN", limitations: ["Missing coverage artifact."] }),
  });
  expect(checked.state.lastVerdict).toBe("UNKNOWN");
  expect(checked.state.checkLog).toContain("UNKNOWN");
  const worked = processMasterCommand(result.state, "/work wo_2", {
    ...deps(),
    fetchWork: () => ({ summary: "attached", verdict: "UNKNOWN" }),
  });
  expect(worked.state.workLog).toBe("attached");
  expect(processMasterCommand(result.state, "/plan", {
    ...deps(),
    localRuntime: () => ({ plan: "Plan from sqlite", cost: "cost", eval: "eval" }),
  }).state.planLog).toContain("Plan from sqlite");
  expect(processMasterCommand(result.state, "/dashboard", deps()).dashboard).toBe(true);
  expect(processMasterCommand(result.state, "/claude", deps()).spawn).toBe("claude");
  expect(processMasterCommand(result.state, "/factory list", deps()).state.status).toContain("factory list");
  expect(processMasterCommand(result.state, "/help", deps()).state.status).toContain("OAuth");
  expect(processMasterCommand(result.state, "", deps()).state).toBe(result.state);
  const processed = processMasterCommand(result.state, "/exit", deps());
  expect(processed.exit).toBe(true);
});

test("interactive master reads slash commands then exits", async () => {
  const stdin = Readable.from(["/check\n", "\u0007n\n", "/exit\n"]);
  const stdout: string[] = [];
  const code = await runMasterTuiInteractive({}, {
    ...deps(),
    stdin,
    stdout: { write(chunk) { stdout.push(chunk); return true; } },
    createReport: () => ({ verdict: "UNKNOWN", limitations: ["suite skipped"] }),
    attachPty: () => ({ trust: "user-owned", process: { once(_e: string, fn: () => void) { fn(); } } as never }),
  });
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Check");
});

test("interactive nested spawn waits for the child then continues", async () => {
  const stdin = Readable.from(["/claude\n", "/exit\n"]);
  const stderr: string[] = [];
  const missing = await runMasterTuiInteractive({}, {
    ...deps(),
    stdin: Readable.from(["/gemini\n", "/exit\n"]),
    stderr: { write(chunk) { stderr.push(chunk); return true; } },
    attachPty: () => ({ error: "gemini CLI was not found on PATH", trust: "install" }),
  });
  expect(missing).toBe(0);
  expect(stderr.join("")).toContain("not found");
  const code = await runMasterTuiInteractive({}, {
    ...deps(),
    stdin,
    attachPty: () => ({ trust: "user-owned", process: { once(_e: string, fn: () => void) { fn(); } } as never }),
  });
  expect(code).toBe(0);
});
