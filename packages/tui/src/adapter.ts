import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TuiCommandResult, TuiReport, TuiSnapshot, RepositoryContext, RepositoryOption, WorkItem } from "./model";
import { buildWorkItems } from "./model";

export interface TuiAdapterOptions {
  cwd?: string;
  cliPath?: string;
  cliRuntime?: string;
  base?: string;
  head?: string;
  config?: string;
  controlPlaneUrl?: string;
  sessionToken?: string;
  repository?: string;
}

export interface VerificationRunResult {
  status: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  snapshot?: TuiSnapshot;
}

export interface VerificationRunHandle {
  promise: Promise<VerificationRunResult>;
  cancel: () => void;
}

export interface TuiAdapter {
  loadSnapshot(): Promise<TuiSnapshot>;
  startVerification(onLog?: (line: string) => void): VerificationRunHandle;
  exportReceipt(): Promise<TuiCommandResult>;
  exportEvidence(): Promise<TuiCommandResult>;
  exportReport(format: "json" | "markdown" | "sarif"): Promise<TuiCommandResult>;
  openGitHub(): string | undefined;
  selectRepository?(root: string): void;
}

const SECRET_ENV = /token|secret|password|credential|private.?key|api.?key/i;
const MAX_DIFF_BYTES = 256 * 1024;

function redact(value: string): string {
  let output = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (SECRET_ENV.test(name) && secret && secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (SECRET_ENV.test(name)) delete environment[name];
  return environment;
}

function jsonFile(file: string): unknown {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size > 16 * 1024 * 1024) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function runGit(root: string, args: string[], allowFailure = true): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !allowFailure) throw new Error(redact(result.stderr || result.error?.message || `git exited with ${String(result.status)}`));
  return redact(typeof result.stdout === "string" ? result.stdout.trim() : "");
}

function detectRoot(cwd: string): string | undefined {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root || undefined;
}

function normalizeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const value = remote.trim().replace(/\.git$/, "");
  if (value.startsWith("git@github.com:")) return `https://github.com/${value.slice("git@github.com:".length)}`;
  if (value.startsWith("ssh://git@github.com/")) return `https://github.com/${value.slice("ssh://git@github.com/".length)}`;
  if (/^https?:\/\/github\.com\//i.test(value)) return value;
  return undefined;
}

function pullRequestNumber(root: string, report?: TuiReport): number | undefined {
  const fromReport = report?.changeIdentity?.pullRequestNumber ?? report?.evidence?.changeIdentity?.pullRequestNumber;
  if (typeof fromReport === "number" && Number.isSafeInteger(fromReport) && fromReport > 0) return fromReport;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return undefined;
  const event = jsonFile(eventPath) as { number?: unknown; pull_request?: { number?: unknown } } | undefined;
  const value = Number(event?.number ?? event?.pull_request?.number);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function repositoryContext(root: string, base?: string, head?: string): RepositoryContext {
  const branchLine = runGit(root, ["status", "--porcelain=v1", "--branch"]).split("\n").filter(Boolean)[0] ?? "";
  const branch = branchLine.startsWith("## ") ? branchLine.slice(3).split("...")[0] || "detached" : runGit(root, ["branch", "--show-current"]) || "detached";
  const statusLines = runGit(root, ["status", "--porcelain=v1"]).split("\n").filter(Boolean);
  const commit = runGit(root, ["rev-parse", "HEAD"]).slice(0, 12);
  const remote = runGit(root, ["config", "--get", "remote.origin.url"]) || undefined;
  const githubUrl = normalizeRemote(remote);
  return {
    root,
    name: path.basename(root),
    branch,
    commit,
    dirty: statusLines.length > 0,
    remote,
    githubUrl,
    local: true,
    base,
    head: head || (commit || undefined),
  };
}

function worktreePaths(root: string): string[] {
  const output = runGit(root, ["worktree", "list", "--porcelain"]);
  return output.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).filter(Boolean);
}

function repositoryOptions(root: string, worktrees: string[]): RepositoryOption[] {
  const configuredFile = path.join(root, ".tinkerbot", "repositories.json");
  const configuredValue = jsonFile(configuredFile);
  const configured = Array.isArray(configuredValue) ? configuredValue.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") return [(item as { path: string }).path];
    return [];
  }) : [];
  const paths = [...new Set([...worktrees, ...configured.map((item) => path.resolve(root, item))])];
  return paths.filter((candidate) => fs.existsSync(candidate)).map((candidate) => {
    const candidateRoot = detectRoot(candidate) ?? candidate;
    const context = repositoryContext(candidateRoot);
    return { path: candidateRoot, name: context.name, branch: context.branch, githubUrl: context.githubUrl, current: candidateRoot === root, source: worktrees.includes(candidate) ? "worktree" : "configured" };
  });
}

function changedFiles(root: string, base?: string, head?: string): string[] {
  const args = base && runGit(root, ["rev-parse", "--verify", "--end-of-options", base])
    ? ["diff", "--name-only", base, head || "HEAD", "--"]
    : ["diff", "--name-only", "--"];
  const committed = runGit(root, args);
  const staged = runGit(root, ["diff", "--cached", "--name-only", "--"]);
  return [...new Set(`${committed}\n${staged}`.split("\n").map((item) => item.trim()).filter(Boolean))].sort();
}

function diffText(root: string, base?: string, head?: string): string {
  const canUseRevisions = Boolean(base && runGit(root, ["rev-parse", "--verify", "--end-of-options", base]) && head && runGit(root, ["rev-parse", "--verify", "--end-of-options", head]));
  const args = canUseRevisions ? ["diff", "--no-color", "--unified=3", base!, head!, "--"] : ["diff", "--no-color", "--unified=3", "--"];
  const value = runGit(root, args);
  return value.length > MAX_DIFF_BYTES ? `${value.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated locally at ${MAX_DIFF_BYTES} bytes]` : value;
}

function findReport(root: string): { file?: string; report?: TuiReport; receipt?: Record<string, unknown> } {
  for (const relative of [".tinkerbot/report.json", ".pr-proof/report.json"]) {
    const file = path.join(root, relative);
    const value = jsonFile(file);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { verdict?: unknown }).verdict === "string") {
      const receipt = latestReceipt(root);
      return { file, report: value as TuiReport, receipt };
    }
  }
  return {};
}

function latestReceipt(root: string): Record<string, unknown> | undefined {
  for (const directory of [path.join(root, ".tinkerbot", "receipts"), path.join(root, ".pr-proof")]) {
    try {
      const candidates = fs.readdirSync(directory).filter((file) => /receipt.*\.json$/i.test(file) || /^tb-rcpt-.*\.json$/i.test(file)).sort().reverse();
      for (const candidate of candidates) {
        const value = jsonFile(path.join(directory, candidate));
        if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "verification-receipt") return value as Record<string, unknown>;
      }
    } catch {
      // A missing local receipt directory is an empty state, not an error.
    }
  }
  return undefined;
}

function cliCandidates(root: string): string[] {
  return [
    process.env.TINKERBOT_CLI,
    path.resolve(root, "dist/packages/cli/src/index.js"),
    path.resolve(root, "packages/cli/src/index.js"),
  ].filter((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
}

function commandInvocation(root: string, options: TuiAdapterOptions): { runtime: string; prefix: string[] } {
  const configured = options.cliPath || process.env.TINKERBOT_CLI;
  if (configured && !fs.existsSync(configured)) return { runtime: configured, prefix: [] };
  const cli = configured || cliCandidates(root)[0];
  if (!cli) throw new Error("The built Tinkerbot CLI could not be located. Run `pnpm build` or set TINKERBOT_CLI.");
  return { runtime: options.cliRuntime || process.env.TINKERBOT_CLI_RUNTIME || process.execPath, prefix: [cli] };
}

function commandArgs(options: TuiAdapterOptions, command: string[]): string[] {
  const args = [...command];
  if (options.base) args.push("--base", options.base);
  if (options.head && options.head !== "HEAD") args.push("--head", options.head);
  if (options.config) args.push("--config", options.config);
  return args;
}

function invoke(root: string, options: TuiAdapterOptions, command: string[], allowNonZero = true): TuiCommandResult {
  try {
    const invocation = commandInvocation(root, options);
    const result = spawnSync(invocation.runtime, [...invocation.prefix, ...commandArgs(options, command)], { cwd: root, encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const status = result.status ?? 5;
    const stdout = redact(typeof result.stdout === "string" ? result.stdout : "");
    const stderr = redact(typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "");
    let value: unknown;
    try { value = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { value = undefined; }
    return { ok: status === 0 || (allowNonZero && status <= 2), status, stdout, stderr, value };
  } catch (error) {
    return { ok: false, status: 5, stdout: "", stderr: redact(error instanceof Error ? error.message : String(error)) };
  }
}

function snapshotState(report: TuiReport | undefined, stale: boolean, changed: string[], repository: RepositoryContext | undefined): TuiSnapshot["state"] {
  if (!repository) return "error";
  if (stale) return "stale";
  if (report?.verdict === "UNKNOWN") return "unknown";
  if (!report && !changed.length) return "empty";
  if (!report) return "empty";
  return "ready";
}

export class LocalCliAdapter implements TuiAdapter {
  private readonly options: TuiAdapterOptions;
  private cwd: string;

  constructor(options: TuiAdapterOptions = {}) {
    this.options = options;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
  }

  selectRepository(root: string): void {
    this.cwd = path.resolve(root);
  }

  async loadSnapshot(): Promise<TuiSnapshot> {
    const loadedAt = new Date().toISOString();
    const root = detectRoot(this.cwd);
    if (!root) return { state: "error", history: [], diff: "", changedFiles: [], workItems: [], warnings: ["Tinkerbot must run inside a Git repository."], loadedAt };
    const repository = repositoryContext(root, this.options.base, this.options.head);
    const worktrees = worktreePaths(root);
    const currentHead = runGit(root, ["rev-parse", "HEAD"]);
    const reportResult = findReport(root);
    const report = reportResult.report ? { ...reportResult.report } : undefined;
    const evidenceExport = jsonFile(path.join(root, ".tinkerbot", "evidence.json"));
    if (report && evidenceExport && typeof evidenceExport === "object" && !Array.isArray(evidenceExport)) {
      const evidence = (evidenceExport as { evidence?: unknown }).evidence;
      if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) report.evidence = evidence as TuiReport["evidence"];
    }
    if (reportResult.receipt && report) {
      report.assurance = { ...report.assurance, receipts: [reportResult.receipt as never] };
    }
    const stale = Boolean(report?.head && currentHead && report.head !== currentHead && report.head !== currentHead.slice(0, 12));
    const files = changedFiles(root, report?.base ?? this.options.base, report?.head ?? this.options.head);
    const historyResult = invoke(root, this.options, ["history", "--format", "json"]);
    const configResult = invoke(root, this.options, ["config", "explain", "--format", "json"]);
    const warnings = [
      ...(reportResult.file ? [] : ["No local report found; the work list shows the current worktree."]),
      ...(stale ? ["The stored report does not match the current checkout."] : []),
      ...(historyResult.stderr ? [historyResult.stderr.split("\n")[0]!] : []),
    ];
    const workItems = buildWorkItems(report, repository, files, stale);
    return {
      state: snapshotState(report, stale, files, repository),
      repository: { ...repository, base: report?.base ?? this.options.base, head: report?.head ?? (currentHead || undefined) },
      repositories: repositoryOptions(root, worktrees),
      worktrees,
      report,
      history: Array.isArray(historyResult.value) ? historyResult.value as Array<Record<string, unknown>> : [],
      config: configResult.value && typeof configResult.value === "object" && !Array.isArray(configResult.value) ? configResult.value as Record<string, unknown> : undefined,
      diff: diffText(root, report?.base ?? this.options.base, report?.head ?? this.options.head),
      changedFiles: files,
      workItems,
      warnings,
      loadedAt,
    };
  }

  startVerification(onLog?: (line: string) => void): VerificationRunHandle {
    const root = detectRoot(this.cwd) ?? this.cwd;
    const invocation = commandInvocation(root, this.options);
    const output = ".pr-proof/report.json";
    const args = [...invocation.prefix, ...commandArgs(this.options, ["check", "--format", "json", "--output", output])];
    const child: ChildProcess = spawn(invocation.runtime, args, { cwd: root, shell: false, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    onLog?.("Starting deterministic verification…");
    onLog?.("Analyzing test integrity, impact, contracts, fixtures, and policy…");
    child.stdout?.on("data", (chunk: Buffer | string) => { const line = redact(String(chunk)).trim(); stdout += String(chunk); if (line) onLog?.(line); });
    child.stderr?.on("data", (chunk: Buffer | string) => { const line = redact(String(chunk)).trim(); stderr += String(chunk); if (line) onLog?.(line); });
    const promise = new Promise<VerificationRunResult>((resolve) => {
      child.once("error", (error) => resolve({ status: 5, cancelled, stdout: redact(stdout), stderr: redact(`${stderr}\n${error.message}`) }));
      child.once("close", async (status) => {
        const result: VerificationRunResult = { status: status ?? 5, cancelled, stdout: redact(stdout), stderr: redact(stderr) };
        if (!cancelled && (status === 0 || status === 1 || status === 2)) {
          result.snapshot = await this.loadSnapshot();
          onLog?.(`Verification finished: ${result.snapshot.report?.verdict ?? "UNKNOWN"}.`);
        } else if (cancelled) onLog?.("Verification cancelled; the deterministic report was not changed by the TUI.");
        resolve(result);
      });
    });
    return { promise, cancel: () => { if (child.exitCode === null && !child.killed) { cancelled = true; child.kill("SIGTERM"); onLog?.("Cancelling verification…"); } } };
  }

  async exportReceipt(): Promise<TuiCommandResult> {
    const root = detectRoot(this.cwd) ?? this.cwd;
    const target = ".tinkerbot/receipts/tinkerbot-receipt.json";
    return invoke(root, this.options, ["proof", "create", "--input", ".pr-proof/report.json", "--format", "receipt", "--output", target]);
  }

  async exportEvidence(): Promise<TuiCommandResult> {
    const root = detectRoot(this.cwd) ?? this.cwd;
    return invoke(root, this.options, ["evidence", "--input", ".pr-proof/report.json", "--format", "change-assurance", "--output", ".tinkerbot/evidence.json"]);
  }

  async exportReport(format: "json" | "markdown" | "sarif"): Promise<TuiCommandResult> {
    const root = detectRoot(this.cwd) ?? this.cwd;
    if (format === "json") {
      const source = path.join(root, ".pr-proof", "report.json");
      const target = path.join(root, ".tinkerbot", "exports", "report.json");
      try {
        if (!fs.existsSync(source)) return { ok: false, status: 2, stdout: "", stderr: "No local report exists yet." };
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, target);
        return { ok: true, status: 0, stdout: target, stderr: "" };
      } catch (error) {
        return { ok: false, status: 5, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    }
    const target = `.tinkerbot/exports/report.${format}`;
    return invoke(root, this.options, ["report", "--input", ".pr-proof/report.json", "--format", format, "--output", target]);
  }

  openGitHub(): string | undefined {
    const root = detectRoot(this.cwd);
    if (!root) return undefined;
    const context = repositoryContext(root, this.options.base, this.options.head);
    const report = findReport(root).report;
    const pr = pullRequestNumber(root, report);
    return context.githubUrl && pr ? `${context.githubUrl}/pull/${pr}` : context.githubUrl;
  }
}

export function createLocalAdapter(options: TuiAdapterOptions = {}): LocalCliAdapter {
  return new LocalCliAdapter(options);
}

/**
 * Hosted mode deliberately treats the control plane as the source of truth.
 * It never falls back to local reports or local storage when credentials are
 * absent: an unavailable session is an explicit error state.
 */
export class HostedControlPlaneAdapter implements TuiAdapter {
  private readonly options: TuiAdapterOptions;
  private readonly base: string;
  private readonly token: string;
  private readonly repository: string;
  private readonly cwd: string;

  constructor(options: TuiAdapterOptions = {}) {
    this.options = options;
    this.base = (options.controlPlaneUrl ?? process.env.TINKERBOT_CONTROL_PLANE_URL ?? "").replace(/\/$/, "");
    this.token = options.sessionToken ?? process.env.TINKERBOT_SESSION_TOKEN ?? "";
    this.repository = options.repository ?? process.env.TINKERBOT_REPOSITORY ?? "";
    this.cwd = path.resolve(options.cwd ?? process.cwd());
  }

  private valid(): string | undefined {
    if (!/^https:\/\//.test(this.base)) return "Hosted TUI requires an HTTPS TINKERBOT_CONTROL_PLANE_URL.";
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(this.token)) return "Hosted TUI requires an authenticated TINKERBOT_SESSION_TOKEN.";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository)) return "Hosted TUI requires TINKERBOT_REPOSITORY in owner/repository form.";
    return undefined;
  }

  async loadSnapshot(): Promise<TuiSnapshot> {
    const invalid = this.valid();
    if (invalid) return { state: "permission-denied", history: [], diff: "", changedFiles: [], workItems: [], warnings: [invalid], loadedAt: new Date().toISOString() };
    try {
      const response = await fetch(`${this.base}/assurance/summary?repository=${encodeURIComponent(this.repository)}`, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" } });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) return { state: response.status === 401 || response.status === 403 ? "permission-denied" : "error", history: [], diff: "", changedFiles: [], workItems: [], warnings: [String(body.error ?? body.code ?? `Control plane returned HTTP ${response.status}.`)], loadedAt: new Date().toISOString() };
      const assurance = body.assurance;
      const report = assurance && typeof assurance === "object" && !Array.isArray(assurance) && typeof (assurance as { verdict?: unknown }).verdict === "string" ? assurance as TuiReport : undefined;
      const repository: RepositoryContext = { root: this.repository, name: this.repository, branch: "hosted", commit: "server", dirty: false, local: true };
      const workItems = buildWorkItems(report, repository, [], false);
      return { state: report ? "ready" : "empty", repository, report, history: [], config: { organizationId: body.organizationId, source: "control-plane" }, diff: "", changedFiles: [], workItems, warnings: report ? [] : ["No hosted assurance record is available for this repository."], loadedAt: new Date().toISOString() };
    } catch {
      return { state: "error", history: [], diff: "", changedFiles: [], workItems: [], warnings: ["The Tinkerbot control plane could not be reached."], loadedAt: new Date().toISOString() };
    }
  }

  startVerification(onLog?: (line: string) => void): VerificationRunHandle {
    const invalid = this.valid();
    const root = detectRoot(this.cwd);
    if (invalid || !root) return { cancel: () => undefined, promise: Promise.resolve({ status: 3, cancelled: false, stdout: "", stderr: invalid ?? "Tinkerbot must run inside a Git repository." }) };
    let invocation: { runtime: string; prefix: string[] };
    try { invocation = commandInvocation(root, this.options); }
    catch (error) { return { cancel: () => undefined, promise: Promise.resolve({ status: 5, cancelled: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }) }; }
    const args = [...invocation.prefix, ...commandArgs(this.options, ["verify", "--repository", this.repository])];
    const child = spawn(invocation.runtime, args, { cwd: root, shell: false, env: { ...safeEnvironment(), TINKERBOT_CONTROL_PLANE_URL: this.base, TINKERBOT_SESSION_TOKEN: this.token }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    onLog?.("Preparing deterministic verification and submitting source-minimized assurance evidence…");
    child.stdout?.on("data", (chunk: Buffer | string) => { const line = redact(String(chunk)).trim(); stdout += String(chunk); if (line) onLog?.(line); });
    child.stderr?.on("data", (chunk: Buffer | string) => { const line = redact(String(chunk)).trim(); stderr += String(chunk); if (line) onLog?.(line); });
    return {
      cancel: () => { if (child.exitCode === null && !child.killed) { cancelled = true; child.kill("SIGTERM"); onLog?.("Cancelling hosted verification…"); } },
      promise: new Promise<VerificationRunResult>((resolve) => {
        child.once("error", (error) => resolve({ status: 5, cancelled, stdout: redact(stdout), stderr: redact(`${stderr}\n${error.message}`) }));
        child.once("close", async (status) => {
          const result: VerificationRunResult = { status: status ?? 5, cancelled, stdout: redact(stdout), stderr: redact(stderr) };
          if (!cancelled && (status === 0 || status === 2)) result.snapshot = await this.loadSnapshot();
          resolve(result);
        });
      }),
    };
  }

  async exportReceipt(): Promise<TuiCommandResult> { return { ok: false, status: 12, stdout: "", stderr: "Receipts are retrieved from the hosted assurance record." }; }
  async exportEvidence(): Promise<TuiCommandResult> { return { ok: false, status: 12, stdout: "", stderr: "Evidence is controlled by the hosted assurance record." }; }
  async exportReport(): Promise<TuiCommandResult> { return { ok: false, status: 12, stdout: "", stderr: "Reports are retrieved from the hosted assurance record." }; }
  openGitHub(): string | undefined { return `https://github.com/${this.repository}`; }
}

export function createHostedAdapter(options: TuiAdapterOptions = {}): HostedControlPlaneAdapter {
  return new HostedControlPlaneAdapter(options);
}

export function workItemByIndex(snapshot: TuiSnapshot | undefined, index: number): WorkItem | undefined {
  return snapshot?.workItems[index];
}
