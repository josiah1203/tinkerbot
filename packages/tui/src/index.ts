import { createInterface } from "node:readline";
import { detectAgents, type AgentId, AGENT_IDS } from "./agents";
import { applyMasterIntent, createMasterState, MASTER_HELP, parseMasterIntent, type MasterState } from "./tabs";
import { attachAgentPty } from "./pty";
import { renderMasterChrome } from "./chrome";

export { detectAgents, resolveAgentBin, spawnSpec, AGENT_IDS } from "./agents";
export { applyMasterIntent, createMasterState, MASTER_HELP, parseMasterIntent, renderStatusBar, renderTabStrip } from "./tabs";
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
}

export function isAgentId(value: string | undefined): value is AgentId {
  return Boolean(value && (AGENT_IDS as readonly string[]).includes(value));
}

export function processMasterCommand(state: MasterState, line: string, deps: MasterTuiDeps): { state: MasterState; exit?: boolean; dashboard?: boolean; spawn?: AgentId } {
  const intent = parseMasterIntent(line);
  if (intent.type === "exit") return { state, exit: true };
  if (intent.type === "none") return { state };
  let next = applyMasterIntent(state, intent);
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
      deps.stdout.write(renderMasterChrome(state, MASTER_HELP));
      return { state, code: 2 };
    }
    deps.stdout.write(renderMasterChrome(state, `${attach.trust}\nAttached ${active.agentId} (${attach.process?.pid ?? "child"}). Leader ctrl-g returns to tabs after the child exits.\n`));
    return { state, code: 0, attached: active.agentId };
  }
  deps.stdout.write(renderMasterChrome(state, MASTER_HELP));
  return { state, code: 0 };
}

export async function runMasterTuiInteractive(input: { workOrderId?: string; agent?: AgentId; help?: boolean }, deps: MasterTuiDeps): Promise<number> {
  const started = runMasterTui(input, deps);
  let state = started.state;
  if (started.code !== 0) return started.code;
  const stdin = deps.stdin ?? process.stdin;
  const rl = createInterface({ input: stdin, output: process.stdout, terminal: Boolean(deps.stdout.isTTY) });
  try {
    for await (const line of rl) {
      const result = processMasterCommand(state, String(line), deps);
      state = result.state;
      if (result.dashboard) deps.openDashboard();
      if (result.spawn) {
        const attach = (deps.attachPty ?? attachAgentPty)(result.spawn, deps.cwd, deps.env);
        if (attach.error) deps.stderr.write(`${attach.error}\n`);
        else deps.stdout.write(`Attached nested ${result.spawn}. Tinkerbot does not store vendor tokens.\n`);
      }
      if (result.exit) return 0;
      deps.stdout.write(renderMasterChrome(state, state.status));
    }
  } finally {
    rl.close();
  }
  return 0;
}

export function listAgentsJson(env: NodeJS.ProcessEnv = process.env): string {
  return `${JSON.stringify({ agents: detectAgents(env), storesVendorTokens: false, hostedHarnessesForbidden: ["claude", "codex", "gemini", "oz"] }, null, 2)}\n`;
}
