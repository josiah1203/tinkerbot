import { TOOL_VERSION } from "../../../core/src";
import type { PrProofReport } from "../../../core/src/types";
import { hostedStageTools, hostedVerificationFromView, type HostedWorkView } from "./hosted";
import { renderSession } from "./render";
import { applyStageEvent, appendAssistant, createSession, handleKey, setVerdict, submitLine } from "./session";
import type { Intent, Session, StageEvent, TuiOptions } from "./types";

export type { StageEvent, TuiOptions } from "./types";

export interface TuiHeader {
  repo: string;
  base: string;
  head: string;
  cwd: string;
}

export interface TuiDeps {
  header: () => TuiHeader;
  createReport: (run: {
    cwd?: string;
    command?: "check" | "test-integrity" | "impact";
    base?: string;
    head?: string;
    configPath?: string;
    runMutation?: boolean;
    runBaseTests?: boolean;
    mode?: "advisory" | "blocking";
    failOn?: string[];
    mutationMax?: number;
    policy?: string;
    timeout?: number;
    maxFiles?: number;
    maxFindings?: number;
    onStage?: (event: StageEvent) => void;
  }) => PrProofReport;
  reportExitCode: (report: PrProofReport) => number;
  openDashboard: () => number;
  fetchWork?: (id: string) => HostedWorkView;
  fetchWorkAsync?: (id: string) => Promise<HostedWorkView>;
  workAction?: (id: string, action: "steer" | "take" | "return" | "approve", note?: string) => { ok: boolean; message: string };
  workActionAsync?: (id: string, action: "steer" | "take" | "return" | "approve", note?: string) => Promise<{ ok: boolean; message: string }>;
  stdout: { write: (chunk: string) => boolean; isTTY?: boolean; columns?: number };
  stderr: { write: (chunk: string) => boolean };
  stdin: NodeJS.ReadStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const TUI_HELP = `Usage: tb tui [check|work <id>] [--agent claude|gemini|codex|cursor|shell] [options]

Master terminal (OpenTUI-style tabs) on a real TTY: pnpm tb tui or pnpm tui
Nested CLIs (claude, gemini, codex, cursor, shell) use their own OAuth. Tinkerbot never stores vendor tokens.
Non-interactive: tb tui --once runs one Node check transcript (CI / non-TTY).

  --once                 run /check and exit with tb check codes
  --agent ID             open a nested agent tab on TTY (claude|gemini|codex|cursor|shell)
  --base REF             base revision
  --head REF             head revision
  --no-base-tests        skip suite execution (UNKNOWN)
  --mutation-enabled BOOL
  --help                 show this help

Master slash: /check /work /claude /gemini /codex /cursor /shell /tab /factory list|show /dashboard /help /exit
Forbidden on the master: /merge /pass /fail /approve-verdict
Leader ctrl-g leaves a nested PTY. A raw nested terminal can still run gh pr merge if you could; Tinkerbot will not merge for it.
Node --once slash: /check /impact /select-tests /work /steer /take /return /approve /dashboard /help /exit
`;

export function isInteractiveTty(stdout: { isTTY?: boolean }, stdin: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return Boolean(stdout.isTTY && stdin.isTTY && env.CI !== "true");
}

function runOptions(options: TuiOptions, cwd: string, command: "check" | "impact") {
  return {
    cwd,
    command,
    base: options.base,
    head: options.head,
    configPath: options.config,
    runMutation: options.mutation,
    runBaseTests: command === "check" ? options.baseTests : false,
    mode: options.mode,
    failOn: options.failOn,
    mutationMax: options.mutationMax,
    policy: options.policy,
    timeout: options.timeout,
    maxFiles: options.maxFiles,
    maxFindings: options.maxFindings,
  };
}

function applyCheck(session: Session, deps: TuiDeps, options: TuiOptions, command: "check" | "impact"): { session: Session; report: PrProofReport } {
  let current = appendAssistant(session, command === "check"
    ? `I'll run verification on ${session.base}...${session.head}. The configured suite is the merge gate; select-tests cannot skip it.`
    : `I'll inspect impact on ${session.base}...${session.head}. This is not the merge gate.`);
  const report = deps.createReport({
    ...runOptions(options, deps.cwd, command),
    onStage: (event) => { current = applyStageEvent(current, event); },
  });
  const limitations = report.limitations.length ? report.limitations.join("\n") : "tb check is the only verdict.";
  current = setVerdict(current, report.verdict, limitations);
  return { session: current, report };
}

function applyWorkView(session: Session, id: string, view: HostedWorkView): Session {
  let current: Session = { ...session, mode: "work", workOrderId: id };
  current = appendAssistant(current, `Attached work order ${id}. Agent stage text is not a verdict.`);
  for (const tool of hostedStageTools(view)) {
    current = applyStageEvent(current, { type: "stage_start", id: tool.id, label: tool.name, feedsVerdict: false });
    current = applyStageEvent(current, { type: "stage_end", id: tool.id, status: tool.status === "running" ? "running" : "done", summary: tool.result, feedsVerdict: false });
  }
  const verification = hostedVerificationFromView(view);
  return setVerdict(current, verification.verdict, verification.detail);
}

function applyWork(session: Session, deps: TuiDeps, id: string): Session {
  if (!deps.fetchWork) return appendAssistant(session, "Hosted attach needs `tb login`. Agent text cannot write PASS.");
  return applyWorkView(session, id, deps.fetchWork(id));
}

function applyWorkAction(session: Session, deps: TuiDeps, intent: Extract<Intent, { type: "steer" | "take" | "return" | "approve" }>): Session {
  if (!session.workOrderId) return appendAssistant(session, "Attach a work order with /work <id> first.");
  if (!deps.workAction) return appendAssistant(session, "Hosted actions need `tb login`.");
  if (intent.type === "approve") {
    const result = deps.workAction(session.workOrderId, "approve");
    return appendAssistant(session, result.ok ? "Specification approval recorded. Humans still merge. This does not write a verification verdict." : result.message);
  }
  const result = deps.workAction(session.workOrderId, intent.type, intent.type === "steer" ? intent.text : undefined);
  return appendAssistant(session, result.ok ? result.message : result.message);
}

export async function dispatchIntent(session: Session, intent: Intent, deps: TuiDeps, options: TuiOptions): Promise<{ session: Session; report?: PrProofReport; exit?: boolean; dashboard?: boolean }> {
  if (intent.type === "none" || intent.type === "help" || intent.type === "clear" || intent.type === "reject") return { session };
  if (intent.type === "exit") return { session, exit: true };
  if (intent.type === "dashboard") return { session: appendAssistant(session, "Opening the browser control tower."), dashboard: true };
  if (intent.type === "check") return applyCheck(session, deps, options, "check");
  if (intent.type === "impact" || intent.type === "select-tests") return applyCheck(session, deps, options, "impact");
  if (intent.type === "work") {
    if (deps.fetchWorkAsync && !deps.fetchWork) return { session: applyWorkView(session, intent.id, await deps.fetchWorkAsync(intent.id)) };
    return { session: applyWork(session, deps, intent.id) };
  }
  if (intent.type === "steer" || intent.type === "take" || intent.type === "return" || intent.type === "approve") {
    if (!session.workOrderId) return { session: appendAssistant(session, "Attach a work order with /work <id> first.") };
    const action = intent.type === "steer" || intent.type === "take" || intent.type === "return" || intent.type === "approve" ? intent.type : "take";
    const note = intent.type === "steer" ? intent.text : undefined;
    const run = deps.workActionAsync ?? (deps.workAction ? async (id: string, next: "steer" | "take" | "return" | "approve", text?: string) => deps.workAction!(id, next, text) : undefined);
    if (!run) return { session: appendAssistant(session, "Hosted actions need `tb login`.") };
    const result = await run(session.workOrderId, action, note);
    const message = intent.type === "approve" && result.ok
      ? "Specification approval recorded. Humans still merge. This does not write a verification verdict."
      : result.message;
    return { session: appendAssistant(session, result.ok ? message : result.message) };
  }
  return { session };
}

export function dispatchIntentSync(session: Session, intent: Intent, deps: TuiDeps, options: TuiOptions): { session: Session; report?: PrProofReport; exit?: boolean; dashboard?: boolean } {
  if (intent.type === "none" || intent.type === "help" || intent.type === "clear" || intent.type === "reject") return { session };
  if (intent.type === "exit") return { session, exit: true };
  if (intent.type === "dashboard") return { session: appendAssistant(session, "Opening the browser control tower."), dashboard: true };
  if (intent.type === "check") return applyCheck(session, deps, options, "check");
  if (intent.type === "impact" || intent.type === "select-tests") return applyCheck(session, deps, options, "impact");
  if (intent.type === "work") return { session: applyWork(session, deps, intent.id) };
  if (intent.type === "steer" || intent.type === "take" || intent.type === "return" || intent.type === "approve") return { session: applyWorkAction(session, deps, intent) };
  return { session };
}

export function seedSession(deps: TuiDeps, options: TuiOptions): Session {
  const header = deps.header();
  return createSession({ repo: header.repo, base: options.base ?? header.base, head: options.head ?? header.head, version: TOOL_VERSION, mode: options.subcommand === "work" ? "work" : "local" });
}

export function runTui(options: TuiOptions, deps: TuiDeps): number {
  if (options.help) {
    deps.stdout.write(TUI_HELP);
    return 0;
  }
  if (!options.once && options.subcommand !== "check" && options.subcommand !== "work") {
    deps.stderr.write("Tinkerbot TUI requires a TTY. Run `tb tui --once` for a check transcript, or `tb check`.\n");
    return 2;
  }
  let session = seedSession(deps, options);
  const initial = options.subcommand === "work" && options.positional
    ? `/work ${options.positional}`
    : options.once || options.subcommand === "check"
      ? "/check"
      : undefined;
  let code = 0;
  if (initial) {
    const submitted = submitLine({ ...session, input: initial });
    const result = dispatchIntentSync(submitted.session, submitted.intent, deps, options);
    session = result.session;
    if (result.report) code = deps.reportExitCode(result.report);
    if (result.dashboard) deps.openDashboard();
    if (initial.startsWith("/work") && !deps.fetchWork) code = 2;
  }
  deps.stdout.write(renderSession(session, { columns: deps.stdout.columns, color: Boolean(deps.stdout.isTTY) && deps.env.NO_COLOR !== "1", showPrompt: false }));
  return code;
}

export async function runTuiInteractive(options: TuiOptions, deps: TuiDeps): Promise<number> {
  if (options.help) {
    deps.stdout.write(TUI_HELP);
    return 0;
  }
  const stdin = deps.stdin;
  if (typeof stdin.setRawMode !== "function") return runTui({ ...options, once: true }, deps);
  let session = seedSession(deps, options);
  let code = 0;
  const color = deps.env.NO_COLOR !== "1";
  const columns = () => deps.stdout.columns ?? 80;
  const draw = () => {
    deps.stdout.write(`\u001b[2J\u001b[H${renderSession(session, { columns: columns(), color, showPrompt: true })}`);
  };
  try {
    stdin.setRawMode(true);
  } catch {
    return runTui(options, deps);
  }
  stdin.resume();
  stdin.setEncoding("utf8");
  deps.stdout.write("\u001b[?1049h\u001b[?25h");
  draw();
  return await new Promise((resolve) => {
    const finish = (exitCode: number) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      deps.stdout.write("\u001b[?1049l");
      resolve(exitCode);
    };
    let queue = Promise.resolve();
    const onData = (chunk: string) => {
      queue = queue.then(async () => {
        for (const key of chunk) {
          const next = handleKey(session, key);
          session = next.session;
          if (next.exit) { finish(code); return; }
          if (next.submit) {
            const submitted = submitLine(session);
            const result = await dispatchIntent(submitted.session, submitted.intent, deps, options);
            session = result.session;
            if (result.report) code = deps.reportExitCode(result.report);
            if (result.dashboard) deps.openDashboard();
            if (result.exit) { finish(code); return; }
          }
        }
        draw();
      });
    };
    stdin.on("data", onData);
  });
}
