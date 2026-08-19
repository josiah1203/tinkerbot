import { expect, test } from "vitest";
import { applyMasterIntent, createMasterState, parseMasterIntent, renderTabStrip, MASTER_HELP } from "../packages/tui/src/tabs";
import { detectAgents, resolveAgentBin, spawnSpec } from "../packages/tui/src/agents";
import { attachAgentPty } from "../packages/tui/src/pty";
import { processMasterCommand, runMasterTui, listAgentsJson } from "../packages/tui/src";

test("master slash rejects merge and pass and opens agent tabs", () => {
  const state = createMasterState({ repo: "acme/api", base: "origin/main", head: "HEAD" });
  expect(parseMasterIntent("/merge")).toMatchObject({ type: "reject", command: "/merge" });
  expect(parseMasterIntent("/pass")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/fail")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/approve-verdict")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/claude")).toEqual({ type: "open-agent", id: "claude" });
  expect(parseMasterIntent("/factory sync")).toMatchObject({ type: "reject" });
  expect(parseMasterIntent("/factory list")).toEqual({ type: "factory", sub: "list" });
  const withWork = applyMasterIntent(state, { type: "work", id: "wo_1" });
  expect(withWork.tabs.some((tab) => tab.kind === "work")).toBe(true);
  const withAgent = applyMasterIntent(withWork, { type: "open-agent", id: "claude" });
  expect(renderTabStrip(withAgent)).toContain("claude");
  expect(applyMasterIntent(withAgent, { type: "reject", command: "/merge", reason: "no" }).status).toBe("no");
  expect(MASTER_HELP).toContain("pnpm tb tui");
});

test("PATH detection uses env overrides and never claims vendor tokens", () => {
  const env = { PATH: "/no/such/bin", SHELL: "/bin/sh", TINKERBOT_CLAUDE_BIN: "/bin/sh" };
  expect(resolveAgentBin("claude", env)).toBe("/bin/sh");
  expect(resolveAgentBin("shell", env)).toBe("/bin/sh");
  const agents = detectAgents({ PATH: "/no/such/bin", SHELL: "/bin/sh" });
  expect(agents.find((item) => item.id === "cursor")?.present).toBe(false);
  expect(agents.every((item) => item.oauth === "child-cli")).toBe(true);
  expect(JSON.parse(listAgentsJson(env)).storesVendorTokens).toBe(false);
  expect(spawnSpec("gemini", "/tmp", { PATH: "/no/such" })).toMatchObject({ error: expect.stringMatching(/not found/) });
});

test("PTY spawn is mockable and runMasterTui seeds work and agent tabs", () => {
  const spawned: string[] = [];
  const child = { pid: 42, on() { return child; } };
  const attached = attachAgentPty("shell", "/tmp", { SHELL: "/bin/sh" }, { spawn: ((bin: string) => { spawned.push(bin); return child; }) as unknown as typeof import("node:child_process").spawn });
  expect(attached.process?.pid).toBe(42);
  expect(spawned[0]).toBe("/bin/sh");
  const stdout: string[] = [];
  const result = runMasterTui({ workOrderId: "wo_9", agent: "shell" }, {
    stdout: { write(chunk) { stdout.push(chunk); return true; } },
    stderr: { write: () => true },
    cwd: "/tmp",
    env: { SHELL: "/bin/sh" },
    header: () => ({ repo: "acme/api", base: "origin/main", head: "HEAD" }),
    openDashboard: () => 0,
    attachPty: () => ({ trust: "user-owned", process: child as never }),
  });
  expect(result.attached).toBe("shell");
  expect(stdout.join("")).toContain("Work wo_9");
  const processed = processMasterCommand(result.state, "/exit", {
    stdout: { write: () => true },
    stderr: { write: () => true },
    cwd: "/tmp",
    env: {},
    header: () => ({ repo: "acme/api", base: "origin/main", head: "HEAD" }),
    openDashboard: () => 0,
  });
  expect(processed.exit).toBe(true);
});
