import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findConfig, loadConfig, type PrProofConfig } from "../../core/src";
import { redactSecrets, resolveRepositoryPath } from "../../core/src/safety";
import { getRepoRoot, resolveRevision } from "../../git/src";
import { readCoverage } from "../../coverage/src";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  impact?: string;
  suggestedFix?: string;
}

export interface DoctorReport {
  root?: string;
  checks: DoctorCheck[];
  healthy: boolean;
}

function check(name: string, status: DoctorStatus, detail: string, impact?: string, suggestedFix?: string): DoctorCheck {
  return { name, status, detail, impact, suggestedFix };
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).split("\n").filter((line) => !line.trim().startsWith("fatal:")).join(" ").replace(/\s+/g, " ").trim();
}

function executable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: false, timeout: 5_000, killSignal: "SIGTERM" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function runnerAvailable(root: string, runner: string): boolean {
  const binary = path.join(root, "node_modules", ".bin", runner);
  return fs.existsSync(binary) || executable(runner);
}

export function runDoctor(cwd: string, explicitConfig?: string, base?: string, head = "HEAD"): DoctorReport {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major >= 20 ? check("Node.js", "pass", `${process.version} is supported.`) : check("Node.js", "fail", `${process.version} is below the supported Node.js 20 minimum.`, "The CLI and Action may fail to start.", "Install Node.js 20 or newer."));
  checks.push(executable("git") ? check("Git", "pass", "Git is available on PATH.") : check("Git", "fail", "Git was not found on PATH.", "Revision and diff analysis cannot run.", "Install Git and rerun doctor."));

  let root: string | undefined;
  let config: PrProofConfig | undefined;
  try {
    root = getRepoRoot(cwd);
    checks.push(check("Repository", "pass", root));
  } catch (error) {
    checks.push(check("Repository", "fail", cleanError(error), "PR Proof needs a Git working tree.", "Run the command from a Git repository."));
  }
  if (!root) return { checks, healthy: false };

  let configFile: string | undefined;
  try { configFile = findConfig(root, explicitConfig); } catch { /* loadConfig below reports the validation error */ }
  try {
    config = loadConfig(root, explicitConfig);
    checks.push(check("Configuration", "pass", configFile ? `Valid: ${path.relative(root, configFile)}` : "No config file found; safe defaults are active."));
  } catch (error) {
    checks.push(check("Configuration", "fail", cleanError(error), "Analysis cannot start with invalid configuration.", "Run `pr-proof config explain`, fix the file, and rerun doctor."));
  }

  const selectedBase = base ?? config?.base.ref ?? "origin/main";
  try {
    const baseSha = resolveRevision(selectedBase, root);
    const headSha = resolveRevision(head, root);
    checks.push(check("Base/head", "pass", `${baseSha.slice(0, 12)} → ${headSha.slice(0, 12)}`));
  } catch (error) {
    checks.push(check("Base/head", "fail", cleanError(error), "The requested comparison cannot be resolved.", "Fetch the base branch and pass explicit --base/--head refs."));
  }

  if (config) {
    const packageManager = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : fs.existsSync(path.join(root, "package-lock.json")) ? "npm" : undefined;
    checks.push(packageManager ? check("Package manager", "pass", `${packageManager} lockfile found.`) : check("Package manager", "warn", "No recognized package-manager lockfile found.", "Reproducible dependency installation may not be available.", "Commit the lockfile used by CI."));
    checks.push(runnerAvailable(root, config.framework.test_runner) ? check("Test runner", "pass", `${config.framework.test_runner} is available.`) : check("Test runner", "warn", `${config.framework.test_runner} was not found locally.`, "Base/head execution may become UNKNOWN.", "Install the repository dependencies before running PR Proof."));
    checks.push(fs.existsSync(path.join(root, "tsconfig.json")) ? check("TypeScript configuration", "pass", "tsconfig.json found.") : check("TypeScript configuration", "warn", "No root tsconfig.json found.", "TypeScript symbol and export analysis may be partial.", "Add or configure the repository TypeScript project."));
    const coverage = readCoverage(root, config.framework.coverage_file);
    checks.push(coverage.available ? check("Coverage", "pass", `${coverage.format} artifact found.`) : check("Coverage", "warn", "No recognized coverage artifact found.", "Changed-line coverage will be reported as UNKNOWN.", "Run the repository’s coverage command and configure framework.coverage_file (LCOV, Istanbul, coverage.py, Go coverprofile, gcov, or LLVM JSON)."));
    const stryker = fs.existsSync(path.join(root, "node_modules", ".bin", "stryker"));
    const customMutation = config.test_integrity.mutation_testing.command;
    checks.push(config.test_integrity.mutation_testing.enabled
      ? customMutation ? check("Mutation adapter", "pass", "A repository-configured mutation command will be used.")
        : stryker ? check("StrykerJS", "pass", "Stryker executable found.")
          : check("Mutation adapter", "warn", "Mutation testing is enabled but no default adapter was found.", "Mutation evidence will be UNKNOWN for non-TypeScript/JavaScript languages.", "Configure test_integrity.mutation_testing.command for the repository’s mutation engine or disable mutation_testing.enabled.")
      : check("Mutation adapter", "pass", "Mutation testing is disabled by configuration."));
    checks.push(config.limits.analysis_timeout_seconds > 0 && config.limits.max_files_analyzed > 0 && config.limits.max_findings > 0
      ? check("Analysis limits", "pass", `${config.limits.analysis_timeout_seconds}s timeout, ${config.limits.max_files_analyzed} files, ${config.limits.max_findings} findings.`)
      : check("Analysis limits", "fail", "One or more analysis limits are not positive.", "An unbounded or disabled bound can make CI unreliable.", "Fix limits.analysis_timeout_seconds, max_files_analyzed, and max_findings."));
    const actionFile = path.join(root, "action.yml");
    if (fs.existsSync(actionFile)) {
      const action = fs.readFileSync(actionFile, "utf8");
      const workflowDirectory = path.join(root, ".github", "workflows");
      const workflowFiles = fs.existsSync(workflowDirectory) ? fs.readdirSync(workflowDirectory).filter((file) => /\.ya?ml$/.test(file)) : [];
      const workflowText = workflowFiles.map((file) => fs.readFileSync(path.join(workflowDirectory, file), "utf8")).join("\n");
      const safeWorkflow = !workflowFiles.length || (workflowText.includes("pull_request:") && !workflowText.includes("pull_request_target"));
      checks.push(safeWorkflow ? check("Action configuration", "pass", `${path.relative(root, actionFile)} is present and workflow events are safe or not configured locally.`) : check("Action configuration", "fail", "A workflow using PR Proof is missing pull_request or contains pull_request_target.", "Contributor-controlled code could receive privileged secrets.", "Use pull_request with least-privilege permissions and never pull_request_target."));
    }
  }

  let outputDirectory: string;
  try {
    outputDirectory = resolveRepositoryPath(root, ".pr-proof");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.accessSync(outputDirectory, fs.constants.W_OK);
    checks.push(check("Output directory", "pass", `${path.relative(root, outputDirectory)}/ is writable.`));
  } catch (error) {
    checks.push(check("Output directory", "fail", cleanError(error), "Reports and cache cannot be written.", "Choose a writable repository or output directory."));
  }
  try {
    fs.accessSync(os.tmpdir(), fs.constants.W_OK);
    checks.push(check("Temporary directory", "pass", `${os.tmpdir()} is writable.`));
  } catch (error) {
    checks.push(check("Temporary directory", "fail", cleanError(error), "Base/head worktrees and bounded test runs cannot be created safely.", "Choose a writable system temporary directory."));
  }
  checks.push(process.env.GITHUB_ACTIONS === "true" ? check("CI environment", "pass", "GitHub Actions detected.") : check("CI environment", "warn", "GitHub Actions was not detected.", "Check Run/comment behavior can only be exercised in GitHub Actions.", "This is informational for local runs."));
  return { root, checks, healthy: checks.every((item) => item.status !== "fail") };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = ["PR Proof doctor", ""];
  for (const item of report.checks) {
    const icon = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${icon.padEnd(4)} ${item.name}: ${item.detail}`);
    if (item.impact) lines.push(`      Impact: ${item.impact}`);
    if (item.suggestedFix) lines.push(`      Suggested fix: ${item.suggestedFix}`);
  }
  lines.push("", report.healthy ? "Doctor status: ready with any warnings shown above." : "Doctor status: blocked until failed checks are resolved.");
  return `${lines.join("\n")}\n`;
}
