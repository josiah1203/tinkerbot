import type { AgentId } from "./agents";

export type TabKind = "check" | "work" | "agent" | "shell";

export interface MasterTab {
  id: string;
  kind: TabKind;
  title: string;
  agentId?: AgentId;
  workOrderId?: string;
  spawn?: { bin: string; cwd: string };
}

export interface MasterState {
  tabs: MasterTab[];
  active: number;
  leader: "ctrl-g";
  lastVerdict?: string;
  repo: string;
  base: string;
  head: string;
  org?: string;
  status: string;
}

export type MasterIntent =
  | { type: "none" }
  | { type: "check" }
  | { type: "work"; id: string }
  | { type: "open-agent"; id: AgentId }
  | { type: "tab-next" }
  | { type: "tab-prev" }
  | { type: "tab-close" }
  | { type: "factory"; sub: "list" | "show"; id?: string }
  | { type: "dashboard" }
  | { type: "help" }
  | { type: "exit" }
  | { type: "reject"; command: string; reason: string };

const FORBIDDEN: Record<string, string> = {
  merge: "The master TUI cannot merge. Humans merge after tb check.",
  pass: "The master TUI cannot write PASS. tb check is the only verdict.",
  fail: "The master TUI cannot rewrite a verdict.",
  "approve-verdict": "The master TUI cannot approve a verification verdict.",
};

export const MASTER_HELP = `Tinkerbot master terminal (OpenTUI-style tabs).

Interactive TTY: pnpm tb tui
Non-TTY / CI: tb tui --once or tb check (exit 2 if you run tb tui without a TTY)

Tabs: Check | Work | Claude | Gemini | Codex | Cursor | Shell
Leader: ctrl-g then n/p/w to next/prev/close a nested agent tab.

Slash (master, not the child CLI):
  /check /work <id> /claude /gemini /codex /cursor /shell
  /tab next|prev|close /factory list|show /dashboard /help /exit
  /merge and /pass are rejected.

Nested CLIs use their own OAuth. Tinkerbot does not store vendor tokens.
Hosted factory inference stays Workers AI. YAML harness claude/codex/gemini/oz stay forbidden.
`;

export function createMasterState(input: { repo: string; base: string; head: string; org?: string; workOrderId?: string; agent?: AgentId }): MasterState {
  const tabs: MasterTab[] = [{ id: "check", kind: "check", title: "Check" }];
  if (input.workOrderId) tabs.push({ id: `work:${input.workOrderId}`, kind: "work", title: `Work ${input.workOrderId}`, workOrderId: input.workOrderId });
  if (input.agent) tabs.push({ id: `agent:${input.agent}`, kind: input.agent === "shell" ? "shell" : "agent", title: input.agent, agentId: input.agent });
  return {
    tabs,
    active: tabs.length - 1,
    leader: "ctrl-g",
    repo: input.repo,
    base: input.base,
    head: input.head,
    org: input.org,
    status: "tb check is the only verdict. Nested agents cannot write PASS.",
  };
}

export function parseMasterIntent(line: string): MasterIntent {
  const trimmed = line.trim();
  if (!trimmed) return { type: "none" };
  const slash = trimmed.startsWith("/") ? trimmed.slice(1) : undefined;
  const [raw, ...rest] = (slash ?? trimmed).split(/\s+/);
  const command = raw.toLowerCase();
  const argument = rest.join(" ").trim();
  if (slash !== undefined) {
    const forbidden = FORBIDDEN[command];
    if (forbidden) return { type: "reject", command: `/${command}`, reason: forbidden };
    if (command === "check") return { type: "check" };
    if (command === "work") {
      if (!argument) return { type: "reject", command: "/work", reason: "/work requires a work-order id." };
      return { type: "work", id: argument.split(/\s+/)[0]! };
    }
    if (command === "claude" || command === "gemini" || command === "codex" || command === "cursor" || command === "shell") return { type: "open-agent", id: command };
    if (command === "tab") {
      if (argument === "next" || !argument) return { type: "tab-next" };
      if (argument === "prev") return { type: "tab-prev" };
      if (argument === "close") return { type: "tab-close" };
      return { type: "reject", command: "/tab", reason: "/tab next|prev|close" };
    }
    if (command === "factory") {
      const [sub, id] = argument.split(/\s+/);
      if (sub === "list" || !sub) return { type: "factory", sub: "list" };
      if (sub === "show") return { type: "factory", sub: "show", id };
      return { type: "reject", command: "/factory", reason: "/factory list|show only. Sync stays tb factory sync." };
    }
    if (command === "dashboard") return { type: "dashboard" };
    if (command === "help") return { type: "help" };
    if (command === "exit" || command === "quit") return { type: "exit" };
    return { type: "reject", command: `/${command}`, reason: `Unknown master command /${command}. Type /help.` };
  }
  if (/^(check|verify)$/i.test(trimmed)) return { type: "check" };
  if (/^(exit|quit)$/i.test(trimmed)) return { type: "exit" };
  return { type: "reject", command: trimmed, reason: "Master session. Try /check, /claude, or /help. Nested agents are tabs, not this prompt." };
}

export function applyMasterIntent(state: MasterState, intent: MasterIntent): MasterState {
  if (intent.type === "reject") return { ...state, status: intent.reason };
  if (intent.type === "help") return { ...state, status: "Slash commands stay on the master. Nested CLIs use their own OAuth." };
  if (intent.type === "check") return { ...state, active: 0, status: "tb check is the only verdict. Nested agent text cannot write PASS." };
  if (intent.type === "dashboard") return { ...state, status: "Opening the hosted dashboard." };
  if (intent.type === "factory") return { ...state, status: intent.sub === "show" ? `factory show ${intent.id ?? ""}`.trim() : "factory list (hosted inspect only)" };
  if (intent.type === "work") {
    const id = `work:${intent.id}`;
    if (state.tabs.some((tab) => tab.id === id)) return { ...state, active: state.tabs.findIndex((tab) => tab.id === id) };
    const tabs = [...state.tabs, { id, kind: "work" as const, title: `Work ${intent.id}`, workOrderId: intent.id }];
    return { ...state, tabs, active: tabs.length - 1 };
  }
  if (intent.type === "open-agent") {
    const id = `agent:${intent.id}`;
    if (state.tabs.some((tab) => tab.id === id)) return { ...state, active: state.tabs.findIndex((tab) => tab.id === id) };
    const tabs = [...state.tabs, { id, kind: intent.id === "shell" ? "shell" as const : "agent" as const, title: intent.id, agentId: intent.id }];
    return { ...state, tabs, active: tabs.length - 1 };
  }
  if (intent.type === "tab-next") return { ...state, active: (state.active + 1) % state.tabs.length };
  if (intent.type === "tab-prev") return { ...state, active: (state.active - 1 + state.tabs.length) % state.tabs.length };
  if (intent.type === "tab-close") {
    if (state.tabs.length <= 1 || state.tabs[state.active]?.kind === "check") return { ...state, status: "The Check tab cannot be closed." };
    const tabs = state.tabs.filter((_, index) => index !== state.active);
    return { ...state, tabs, active: Math.min(state.active, tabs.length - 1) };
  }
  return state;
}

export function renderTabStrip(state: MasterState): string {
  return state.tabs.map((tab, index) => (index === state.active ? `[${tab.title}]` : tab.title)).join("  ");
}

export function renderStatusBar(state: MasterState): string {
  const org = state.org ? ` · ${state.org}` : "";
  const verdict = state.lastVerdict ? ` · ${state.lastVerdict}` : "";
  return `${state.repo}  ${state.base}...${state.head}${org}${verdict}  ·  ${state.status}`;
}
