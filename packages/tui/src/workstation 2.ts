import { createInterface } from "node:readline";
import { applyMasterIntent, createMasterState, parseMasterIntent, renderTabBody, type MasterIntent, type MasterState } from "./tabs";
import { attachAgentPty } from "./pty";
import { discoverClaudeCodeKit, loadClaudeCodeKit, type ClaudeCodeKitRuntime, type LoadedClaudeCodeKit } from "./kit-runtime";
import { KIT_COMMANDS } from "./kit";

export interface KitWorkstationHeader {
  repo: string;
  base: string;
  head: string;
}

export interface KitWorkstationDeps {
  stdout: { write: (chunk: string) => boolean; isTTY?: boolean; columns?: number };
  stderr: { write: (chunk: string) => boolean };
  stdin?: NodeJS.ReadableStream;
  cwd: string;
  env: NodeJS.ProcessEnv;
  header: () => KitWorkstationHeader;
  kit?: ClaudeCodeKitRuntime;
  createReport?: () => { verdict: string; limitations?: string[] };
  fetchWork?: (id: string) => { summary?: string; verdict?: string };
  localGraph?: (id: string) => string;
  localRuntime?: () => { plan?: string; cost?: string; eval?: string };
  openDashboard?: () => number;
  attachPty?: typeof attachAgentPty;
  /** Optional edge-owned chat adapter. The verification core stays chat-free. */
  onMessage?: (text: string) => string | undefined;
}

export interface KitWorkstationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface KitWorkstationState {
  master: MasterState;
  kit: ClaudeCodeKitRuntime;
  loadedKit?: LoadedClaudeCodeKit;
  input: string;
  cursor: number;
  suggestionIndex: number;
  messages: KitWorkstationMessage[];
  /** The active tab projection to show above the prompt. */
  body?: string;
}

export interface KitWorkstationRenderOptions {
  columns?: number;
  color?: boolean;
  showCursor?: boolean;
}

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const GRAY = "\u001b[90m";
const WHITE = "\u001b[37m";
const ORANGE = "\u001b[38;5;208m";

const KIT_TITLE = "claude-code-kit";
const KIT_SUBTITLE = "Terminal UI toolkit extracted from Claude Code";
const KIT_PLACEHOLDER = "Type a message or / for commands";
const KIT_FOOTER_LEFT = "Default (recommended) 0 tokens $0.00";
const KIT_FOOTER_RIGHT = "Type / for commands";

// The reference uses a small orange pixel mark. Keeping it as terminal cells
// makes the fallback renderer deterministic and avoids an image dependency.
const KIT_MARK = [
  " ▄██▄ ",
  "███████",
  "███████",
  "███████",
  " █████ ",
  "  █ █  ",
];

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 1) return [text.slice(0, 1)];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    const candidate = remaining.slice(0, width + 1);
    const breakAt = candidate.lastIndexOf(" ");
    const take = breakAt > Math.floor(width / 2) ? breakAt : width;
    lines.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function kitSuggestions(input: string): Array<{ name: string; description: string }> {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  return KIT_COMMANDS
    .map((command) => ({ name: `/${command.name}`, description: command.description }))
    .filter((command) => command.name.startsWith(trimmed));
}

export function suggestKitCommands(input: string): Array<{ name: string; description: string }> {
  return kitSuggestions(input);
}

function appendMessage(state: KitWorkstationState, role: KitWorkstationMessage["role"], text: string): KitWorkstationState {
  return text
    ? { ...state, messages: [...state.messages, { role, text }] }
    : state;
}

function activeBody(state: KitWorkstationState): string | undefined {
  return state.body;
}

function renderContent(state: KitWorkstationState, body: string | undefined, width: number, color: boolean): string[] {
  const content: string[] = [];
  for (const message of state.messages) {
    const marker = message.role === "user" ? "❯" : " ";
    for (const [index, line] of wrapLine(message.text, Math.max(12, width - 6)).entries()) {
      content.push(`  ${paint(color, message.role === "user" && index === 0 ? WHITE : DIM, `${marker} ${line}`)}`);
    }
  }
  const projection = body ?? activeBody(state);
  if (projection) {
    if (content.length) content.push("");
    for (const line of projection.split("\n")) {
      content.push(...wrapLine(line, Math.max(12, width - 4)).map((item) => `  ${paint(color, GRAY, item)}`));
    }
  }
  return content;
}

function renderFooter(width: number, color: boolean): string {
  const left = ` ${KIT_FOOTER_LEFT}`;
  const right = KIT_FOOTER_RIGHT;
  const spaces = Math.max(2, width - visibleLength(left) - visibleLength(right));
  return `${paint(color, DIM, left)}${" ".repeat(spaces)}${paint(color, DIM, right)}`;
}

function renderPrompt(state: KitWorkstationState, width: number, color: boolean, showCursor: boolean): string {
  const cursor = showCursor ? "▌" : "";
  const input = state.input
    ? `${state.input.slice(0, state.cursor)}${cursor}${state.input.slice(state.cursor)}`
    : `${cursor}${paint(color, DIM, KIT_PLACEHOLDER)}`;
  const prompt = ` ${paint(color, WHITE, "❯")} ${input}`;
  return wrapLine(prompt, Math.max(12, width - 2)).join("\n");
}

/** Render the compact Claude Code-style shell used by the kit-aware TUI. */
export function renderKitWorkstationFrame(
  state: KitWorkstationState,
  body?: string,
  options: KitWorkstationRenderOptions = {},
): string {
  const width = Math.max(56, Math.min(120, options.columns ?? 100));
  const color = Boolean(options.color);
  const showCursor = options.showCursor ?? true;
  const rule = paint(color, GRAY, ` ${"─".repeat(Math.max(1, width - 2))}`);
  const lines: string[] = [""];

  KIT_MARK.forEach((mark, index) => {
    const title = index === 0 ? `  ${paint(color, BOLD + WHITE, KIT_TITLE)}` : "";
    const subtitle = index === 1 ? `  ${paint(color, GRAY, KIT_SUBTITLE)}` : "";
    lines.push(`  ${paint(color, ORANGE, mark)}${title || subtitle}`);
  });
  lines.push("");
  lines.push(`     ${paint(color, DIM, "Type / to browse components and commands")}`);
  lines.push(`     ${paint(color, DIM, "Type a message to chat")}`);

  const suggestions = kitSuggestions(state.input);
  if (suggestions.length) {
    lines.push("");
    const selected = Math.min(state.suggestionIndex, suggestions.length - 1);
    for (const [index, suggestion] of suggestions.slice(0, 8).entries()) {
      const marker = index === selected ? "›" : " ";
      const label = `${marker} ${suggestion.name.padEnd(14, " ")} ${suggestion.description}`;
      lines.push(`     ${paint(color, index === selected ? WHITE : DIM, label)}`);
    }
  }

  const content = renderContent(state, body, width, color);
  if (content.length) {
    lines.push("");
    lines.push(...content);
  }
  lines.push(rule);
  lines.push(renderPrompt(state, width, color, showCursor));
  lines.push(rule);
  lines.push(renderFooter(width, color));
  return `${lines.join("\n")}\n`;
}

export function createKitWorkstationState(input: KitWorkstationHeader & { workOrderId?: string; agent?: "claude" | "gemini" | "codex" | "cursor" | "shell"; kit?: ClaudeCodeKitRuntime }): KitWorkstationState {
  const kit = input.kit ?? discoverClaudeCodeKit();
  return {
    master: createMasterState(input),
    kit,
    loadedKit: loadClaudeCodeKit(kit),
    input: "",
    cursor: 0,
    suggestionIndex: 0,
    messages: [],
  };
}

function applyWorkstationIntent(state: KitWorkstationState, intent: MasterIntent, deps: KitWorkstationDeps): KitWorkstationState & { exit?: boolean } {
  if (intent.type === "exit") return { ...state, exit: true, input: "", cursor: 0 };
  let master = applyMasterIntent(state.master, intent);
  let next: KitWorkstationState = { ...state, master, input: "", cursor: 0, suggestionIndex: 0 };
  if (intent.type === "reject") {
    return appendMessage(next, "assistant", intent.reason);
  }
  if (intent.type === "check" && deps.createReport) {
    const report = deps.createReport();
    master = { ...master, lastVerdict: report.verdict, checkLog: [`tb check ${report.verdict}`, ...(report.limitations ?? ["tb check is the only verdict."])].join("\n"), status: `Verification ${report.verdict}. Deterministic evidence remains authoritative.` };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "work" && deps.fetchWork) {
    const view = deps.fetchWork(intent.id);
    master = { ...master, lastVerdict: view.verdict ?? master.lastVerdict, workLog: view.summary ?? `Work ${intent.id}. Agent text is not a verdict.`, status: "Work-order projection loaded. Humans approve and merge." };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "graph" && deps.localGraph) {
    master = { ...master, graphLog: deps.localGraph(intent.id), status: "Read-only append-only Factory Graph projection." };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "plan" && deps.localRuntime) {
    master = { ...master, planLog: deps.localRuntime().plan, status: "Local execution plan. tb check remains the verdict." };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "cost" && deps.localRuntime) {
    master = { ...master, costLog: deps.localRuntime().cost, status: "Estimate vs actual. Seat billing unchanged." };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "eval" && deps.localRuntime) {
    master = { ...master, evalLog: deps.localRuntime().eval, status: "Eval scorers cannot upgrade tb check." };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "dashboard") {
    deps.openDashboard?.();
    next = appendMessage(next, "assistant", "Opening the browser control tower.");
  }
  if (intent.type === "open-agent") {
    const attach = (deps.attachPty ?? attachAgentPty)(intent.id, deps.cwd, deps.env);
    master = { ...master, status: attach.error ?? `Nested ${intent.id} session is owned by its CLI. Tinkerbot does not store vendor tokens.` };
    next = { ...next, master, body: renderTabBody(master) };
  }
  if (intent.type === "help") {
    master = { ...master, status: "Kit UI components stay at the edge; the Factory Graph and tb check remain the source of truth." };
    next = { ...next, master, body: undefined };
    next = appendMessage(next, "assistant", KIT_WORKSTATION_HELP);
  }
  if (intent.type === "tab-next" || intent.type === "tab-prev" || intent.type === "tab-close" || intent.type === "factory") {
    next = { ...next, body: renderTabBody(master) };
  }
  return next;
}

export function processKitWorkstationLine(state: KitWorkstationState, line: string, deps: KitWorkstationDeps): KitWorkstationState & { exit?: boolean } {
  const text = line.trim();
  if (!text) return { ...state, input: "", cursor: 0, suggestionIndex: 0 };
  const intent = parseMasterIntent(text);
  const withUser = appendMessage({ ...state, input: "", cursor: 0, suggestionIndex: 0 }, "user", text);
  // The kit is a chat shell. Plain text is accepted at the edge, while the
  // master parser continues to reject unsafe or unknown slash commands.
  if (intent.type === "reject" && !text.startsWith("/") && !/^@tinker\b/i.test(text)) {
    const response = deps.onMessage?.(text);
    return response ? appendMessage(withUser, "assistant", response) : withUser;
  }
  return applyWorkstationIntent(withUser, intent, deps);
}

export interface KitWorkstationKeyResult {
  state: KitWorkstationState;
  submit?: string;
  exit?: boolean;
}

function replaceAtCursor(state: KitWorkstationState, value: string, cursor: number): KitWorkstationState {
  return { ...state, input: value, cursor, suggestionIndex: 0 };
}

/** Apply one decoded terminal key to the workstation prompt. */
export function handleKitWorkstationKey(state: KitWorkstationState, key: string): KitWorkstationKeyResult {
  const suggestions = kitSuggestions(state.input);
  if (key === "\u0003") {
    return state.input ? { state: replaceAtCursor(state, "", 0) } : { state, exit: true };
  }
  if (key === "\u0004") return state.input ? { state: replaceAtCursor(state, "", 0) } : { state, exit: true };
  if (key === "\r" || key === "\n") {
    const submit = state.input.trim();
    return submit ? { state: replaceAtCursor(state, "", 0), submit } : { state };
  }
  if (key === "\u001b") return { state: replaceAtCursor(state, "", 0) };
  if (key === "\u001b[D" || key === "\u001bOD") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key === "\u001b[C" || key === "\u001bOC") return { state: { ...state, cursor: Math.min(state.input.length, state.cursor + 1) } };
  if (key === "\u001b[H" || key === "\u001b[1~") return { state: { ...state, cursor: 0 } };
  if (key === "\u001b[F" || key === "\u001b[4~") return { state: { ...state, cursor: state.input.length } };
  if (key === "\u001b[A") {
    return suggestions.length ? { state: { ...state, suggestionIndex: Math.max(0, state.suggestionIndex - 1) } } : { state };
  }
  if (key === "\u001b[B") {
    return suggestions.length ? { state: { ...state, suggestionIndex: Math.min(suggestions.length - 1, state.suggestionIndex + 1) } } : { state };
  }
  if (key === "\t") {
    const suggestion = suggestions[state.suggestionIndex];
    if (!suggestion) return { state };
    return { state: replaceAtCursor(state, suggestion.name, suggestion.name.length) };
  }
  if (key === "\u007f" || key === "\b") {
    if (state.cursor === 0) return { state };
    return { state: replaceAtCursor(state, `${state.input.slice(0, state.cursor - 1)}${state.input.slice(state.cursor)}`, state.cursor - 1) };
  }
  if (key.length === 1 && key >= " ") {
    return { state: replaceAtCursor(state, `${state.input.slice(0, state.cursor)}${key}${state.input.slice(state.cursor)}`, state.cursor + 1) };
  }
  return { state };
}

function decodeInputChunk(chunk: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== "\u001b") {
      keys.push(chunk[index]!);
      continue;
    }
    if (chunk[index + 1] !== "[") {
      keys.push("\u001b");
      continue;
    }
    let end = index + 2;
    while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]!)) end += 1;
    if (end < chunk.length) {
      keys.push(chunk.slice(index, end + 1));
      index = end;
    } else {
      keys.push("\u001b");
    }
  }
  return keys;
}

function initialWorkstationState(input: { workOrderId?: string; agent?: "claude" | "gemini" | "codex" | "cursor" | "shell"; help?: boolean }, deps: KitWorkstationDeps): KitWorkstationState & { exit?: boolean } {
  let state = createKitWorkstationState({ ...deps.header(), workOrderId: input.workOrderId, agent: input.agent, kit: deps.kit });
  if (input.workOrderId) state = processKitWorkstationLine(state, `/work ${input.workOrderId}`, deps);
  else if (input.agent) state = processKitWorkstationLine(state, `/${input.agent}`, deps);
  return state;
}

export function runKitWorkstationOnce(input: { workOrderId?: string; agent?: "claude" | "gemini" | "codex" | "cursor" | "shell"; help?: boolean }, deps: KitWorkstationDeps): number {
  let state = initialWorkstationState(input, deps);
  if (input.help) {
    deps.stdout.write(renderKitWorkstationFrame(state, KIT_WORKSTATION_HELP, { columns: deps.stdout.columns, color: false }));
    return 0;
  }
  deps.stdout.write(renderKitWorkstationFrame(state, undefined, { columns: deps.stdout.columns, color: false }));
  return 0;
}

export async function runKitWorkstationInteractive(input: { workOrderId?: string; agent?: "claude" | "gemini" | "codex" | "cursor" | "shell"; help?: boolean }, deps: KitWorkstationDeps): Promise<number> {
  let state = initialWorkstationState(input, deps);
  if (input.help) {
    deps.stdout.write(renderKitWorkstationFrame(state, KIT_WORKSTATION_HELP, { columns: deps.stdout.columns, color: false }));
    return 0;
  }
  const stdin = deps.stdin ?? process.stdin;
  const rawStdin = stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  const color = deps.env.NO_COLOR !== "1";
  const draw = () => deps.stdout.write(`\u001b[2J\u001b[H${renderKitWorkstationFrame(state, undefined, { columns: deps.stdout.columns, color })}`);

  // Keep a line-mode fallback for tests and redirected input. Real terminals
  // use the raw loop below so the prompt behaves like the reference REPL.
  if (typeof rawStdin.setRawMode !== "function") {
    const rl = createInterface({ input: stdin });
    deps.stdout.write(renderKitWorkstationFrame(state, undefined, { columns: deps.stdout.columns, color: false }));
    try {
      for await (const line of rl) {
        const next = processKitWorkstationLine(state, String(line), deps);
        state = next;
        if (next.exit) return 0;
        deps.stdout.write(renderKitWorkstationFrame(state, undefined, { columns: deps.stdout.columns, color: false }));
      }
    } finally {
      rl.close();
    }
    return 0;
  }

  try {
    rawStdin.setRawMode(true);
  } catch {
    return runKitWorkstationOnce(input, deps);
  }
  stdin.resume();
  stdin.setEncoding("utf8");
  deps.stdout.write("\u001b[?1049h\u001b[?25h");
  draw();
  return await new Promise((resolve) => {
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      rawStdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      deps.stdout.write("\u001b[?25h\u001b[?1049l");
      resolve(code);
    };
    const onData = (chunk: string) => {
      for (const key of decodeInputChunk(String(chunk))) {
        const result = handleKitWorkstationKey(state, key);
        state = result.state;
        if (result.exit) {
          finish(0);
          return;
        }
        if (result.submit) {
          const next = processKitWorkstationLine(state, result.submit, deps);
          state = next;
          if (next.exit) {
            finish(0);
            return;
          }
        }
      }
      draw();
    };
    stdin.on("data", onData);
  });
}

export const KIT_WORKSTATION_HELP = `Tinkerbot Factory Workstation (claude-code-kit UI boundary)

The workstation projects the same Factory Graph used by tb and the Control Plane.
The optional claude-code-kit renderer/UI is loaded from TINKERBOT_CLAUDE_CODE_KIT_ROOT.

Commands:
  /check             run deterministic tb check
  /work <id>         attach a work-order projection
  /graph <id>        inspect append-only graph state
  /plan /cost /eval  inspect local factory intelligence
  /claude /gemini /codex /cursor /shell  open a nested user-owned CLI
  /dashboard /help /exit

Workers cannot write PASS, approve themselves, release, or merge.
`;
