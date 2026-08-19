import { createInterface } from "node:readline";
import { detectAgents, type AgentId, AGENT_IDS } from "./agents";
import { applyLeaderChord, applyMasterIntent, createMasterState, MASTER_HELP, parseMasterIntent, renderTabBody, type MasterState } from "./tabs";
import { attachAgentPty } from "./pty";
import { renderMasterChrome } from "./chrome";

export { detectAgents, resolveAgentBin, spawnSpec, AGENT_IDS } from "./agents";
export { applyLeaderChord, applyMasterIntent, createMasterState, MASTER_HELP, parseMasterIntent, renderStatusBar, renderTabBody, renderTabStrip } from "./tabs";
export { attachAgentPty } from "./pty";
export { renderMasterChrome } from "./chrome";
export type { AgentId, DetectedAgent } from "./agents";

export interface MasterTuiDeps {
  stdout: { write: (chunk: string) => boolean; isTTY?: boolean };
  stderr: { write: (chunk: string) => boolean };
  cwd: string;
  env: NodeJS.ProcessEnv;
  header: () => { repo: string; base: string; head: string };
  openDashboard: () => number;
  attachPty?: typeof attachAgentPty;
  stdin?: NodeJS.ReadableStream;
  createReport?: (input: { cwd: string }) => { verdict: string; limitations?: string[] };
  fetchWork?: (id: string) => { summary?: string; verdict?: string };
  localRuntime?: () => { plan?: string; cost?: string; eval?: string };
}

export function isAgentId(value: string | undefined): value is AgentId {
  return Boolean(value && (AGENT_IDS as readonly string[]).includes(value));
}

function waitChild(child: { once?: (event: string, listener: (...args: unknown[]) => void) => unknown } | undefined): Promise<void> {
  if (!child?.once) return Promise.resolve();
  return new Promise((resolve) => {
    child.once!("exit", () => resolve());
  });
}

export function processMasterCommand(state: MasterState, line: string, deps: MasterTuiDeps): { state: MasterState; exit?: boolean; dashboard?: boolean; spawn?: AgentId } {
  const intent = parseMasterIntent(line);
  if (intent.type === "exit") return { state, exit: true };
  if (intent.type === "none") return { state };
  let next = applyMasterIntent(state, intent);
  if (intent.type === "check" && deps.createReport) {
    const report = deps.createReport({ cwd: deps.cwd });
    next = {
      ...next,
      lastVerdict: report.verdict,
      checkLog: [`tb check ${report.verdict}`, ...(report.limitations ?? ["tb check is the only verdict."])].join("\n"),
      status: `Ingested ${report.verdict}. Nested agents cannot rewrite this.`,
    };
  }
  if (intent.type === "work" && deps.fetchWork) {
    const view = deps.fetchWork(intent.id);
    next = {
      ...next,
      lastVerdict: view.verdict ?? next.lastVerdict,
      workLog: view.summary ?? `Work ${intent.id}. Agent text is not PASS.`,
    };
  }
  if (intent.type === "plan" && deps.localRuntime) {
    next = { ...next, planLog: deps.localRuntime().plan, status: "Local execution plan. tb check is the verdict." };
  }
  if (intent.type === "cost" && deps.localRuntime) {
    next = { ...next, costLog: deps.localRuntime().cost, status: "Estimate vs actual. Seat billing unchanged." };
  }
  if (intent.type === "eval" && deps.localRuntime) {
    next = { ...next, evalLog: deps.localRuntime().eval, status: "Eval scorers cannot upgrade tb check." };
  }
  if (intent.type === "dashboard") return { state: next, dashboard: true };
  if (intent.type === "open-agent") return { state: next, spawn: intent.id };
  if (intent.type === "help") deps.stdout.write(renderMasterChrome(next, MASTER_HELP));
  return { state: next };
}

export function runMasterTui(input: { workOrderId?: string; agent?: AgentId; help?: boolean }, deps: MasterTuiDeps): { state: MasterState; code: number; attached?: AgentId } {
  if (input.help) {
    deps.stdout.write(MASTER_HELP);
    return { state: createMasterState({ repo: "local", base: "origin/main", head: "HEAD" }), code: 0 };
  }
  const header = deps.header();
  let state = createMasterState({ ...header, workOrderId: input.workOrderId, agent: input.agent });
  const active = state.tabs[state.active];
  if (active?.agentId) {
    const attach = (deps.attachPty ?? attachAgentPty)(active.agentId, deps.cwd, deps.env);
    if (attach.error) {
      deps.stderr.write(`${attach.error}\n${attach.trust}\n`);
      state = { ...state, status: attach.error };
      deps.stdout.write(renderMasterChrome(state));
      return { state, code: 2 };
    }
    deps.stdout.write(renderMasterChrome(state, `${attach.trust}\nAttached ${active.agentId} (${attach.process?.pid ?? "child"}). Leader ctrl-g returns to tabs after the child exits.\n`));
    return { state, code: 0, attached: active.agentId };
  }
  deps.stdout.write(renderMasterChrome(state));
  return { state, code: 0 };
}

export async function runMasterTuiInteractive(input: { workOrderId?: string; agent?: AgentId; help?: boolean }, deps: MasterTuiDeps): Promise<number> {
  const started = runMasterTui(input, deps);
  let state = started.state;
  if (started.code !== 0) return started.code;
  const stdin = deps.stdin ?? process.stdin;
  const rl = createInterface({ input: stdin });
  try {
    for await (const line of rl) {
      const text = String(line);
      if (text === "\u0007n" || text === "\u0007p" || text === "\u0007w") {
        state = applyLeaderChord(state, text.slice(1));
        deps.stdout.write(renderMasterChrome(state));
        continue;
      }
      const result = processMasterCommand(state, text, deps);
      state = result.state;
      if (result.dashboard) deps.openDashboard();
      if (result.spawn) {
        const attach = (deps.attachPty ?? attachAgentPty)(result.spawn, deps.cwd, deps.env);
        if (attach.error) {
          deps.stderr.write(`${attach.error}\n`);
          state = { ...state, status: attach.error };
        } else {
          deps.stdout.write(`Attached nested ${result.spawn}. Tinkerbot does not store vendor tokens.\n`);
          await waitChild(attach.process);
        }
      }
      if (result.exit) return 0;
      deps.stdout.write(renderMasterChrome(state));
    }
  } finally {
    rl.close();
  }
  return 0;
}

export function listAgentsJson(env: NodeJS.ProcessEnv = process.env): string {
  return `${JSON.stringify({ agents: detectAgents(env), storesVendorTokens: false, hostedHarnessesForbidden: ["claude", "codex", "gemini", "oz"] }, null, 2)}\n`;
}
