#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  calculateVerdict,
  finalizeReport,
  FEATURE_CAPABILITIES,
  loadConfig,
  sortFindings,
  TOOL_NAME,
  TOOL_VERSION,
  validateConfig,
  type Finding,
  type PrProofConfig,
  type PrProofReport,
  type UsageSummary,
} from "../../core/src";
import { createGitContext, getRepoRoot, isSourceFile, listFilesAtRevision } from "../../git/src";
import { readCoverage } from "../../coverage/src";
import { analyzeTestIntegrity } from "../../test-integrity/src";
import { runTargetedMutation } from "../../mutation/src";
import { analyzeImpact } from "../../impact-analysis/src";
import { readBaseline, writeBaseline, createBaseline, compareBaseline, applyBaselineStates } from "../../baseline/src";
import { applyPolicy, explainPolicyPack, getPolicyPack, listPolicyPacks } from "../../policy/src";
import { loadArtifact, type ArtifactType } from "../../artifacts/src";
import { buildProvenance } from "../../provenance/src";
import { selectTests } from "../../selection/src";
import { appendHistory, compareHistory, historyRecordFromReport, readHistoryDetails } from "../../history/src";
import { analyzeContracts } from "../../contracts/src";
import { analyzeFixtures } from "../../fixtures/src";
import { renderReport, type ReportFormat } from "../../reporters/src";
import { redactSecrets, resolveRepositoryPath } from "../../core/src/safety";
import { languageEnabled, summarizeLanguageFiles } from "../../language-core/src";
import {
  assessChangeSet,
  assessReleaseSafety,
  appendRuntimeOutcome,
  assessChangeContractFromRepository,
  buildVerificationCoverage,
  buildVerificationGraph,
  createAssuranceBundle,
  createChangeSet,
  createEvidenceContract,
  createReleaseManifest,
  createRuntimeOutcome,
  createVerificationReceipt,
  evaluateChangeContract,
  exportRuntimeOutcomes,
  loadChangeContract,
  parseAssuranceBundle,
  parseReceipt,
  replayVerificationReceipt,
  serializeAssuranceBundle,
  serializeReceipt,
  verifyVerificationReceipt,
  type AssuranceBundle,
  type ChangeContract,
  type ChangeSet,
  type ReleaseManifest,
  type RuntimeOutcome,
  type VerificationReceipt,
} from "../../assurance/src";
import { runDoctor, renderDoctor } from "./doctor";
import { clearStoredCredentials, hostedSession, saveStoredCredentials } from "./credentials";
import { loadFactoryDefinition, validateAgentReceipt, buildFactoryStarter } from "../../factory/src";
import { evalCli, executeLocalRun, factoryPlanPayload, localDashboardPayload } from "./runtime-cli";
import { createLocalDashboardServer, localDashboardUrl } from "./local-dashboard";
import { formatCostTab, formatEvalTab, formatPlanTab } from "../../local-runtime/src";
import { isInteractiveTty, runTui, TUI_HELP, type TuiDeps, type TuiOptions } from "./tui/index";
import { isAgentId, listAgentsJson, runMasterTuiInteractive } from "../../tui/src";
import { planVerificationStreams } from "./tui/streams";
import type { StageEvent } from "./tui/types";

export const EXIT_CODES = {
  PASS: 0,
  FAIL: 1,
  UNKNOWN: 2,
  CONFIGURATION_ERROR: 3,
  EXECUTION_ERROR: 4,
  INTERNAL_ERROR: 5,
  /** A named command is recognized but deliberately not part of this build. */
  UNSUPPORTED_COMMAND: 12,
} as const;

class CliFailure extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "CliFailure";
  }
}

interface CliOptions {
  command: string;
  subcommand?: string;
  subcommand2?: string;
  positional?: string;
  base?: string;
  head: string;
  format: ReportFormat;
  config?: string;
  output?: string;
  input?: string;
  mutation?: boolean;
  baseTests: boolean;
  mode?: "advisory" | "blocking";
  failOn?: string[];
  mutationMax?: number;
  comment?: boolean;
  checkRun?: boolean;
  sarif?: boolean;
  policy?: string;
  timeout?: number;
  maxFiles?: number;
  maxFindings?: number;
  artifactType?: string;
  port?: number;
  host?: string;
  directory?: string;
  repository?: string;
  token?: string;
  url?: string;
  verbose: boolean;
  help: boolean;
  once?: boolean;
  agent?: string;
  local?: boolean;
  profile?: string;
  allowProcessRunner?: boolean;
}

function valueAfter(rest: string[], index: number, flag: string): string {
  const value = rest[index + 1];
  if (!value || value.startsWith("--")) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `${flag} requires a value`);
  return value;
}

function booleanValue(value: string, flag: string): boolean {
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `${flag} must be true or false`);
}

function parseArgs(argv: string[]): CliOptions {
  const first = argv[0];
  // `tb` is the interactive product surface. A non-interactive invocation
  // remains safe for automation and package probes by printing help instead.
  const command = first === "--version" || first === "-V" ? "version" : first === "--help" || first === "-h" ? "help" : first ?? "help";
  const rest = first === "--version" || first === "-V" || first === "--help" || first === "-h" ? argv.slice(1) : argv.slice(1);
  const options: CliOptions = { command, head: "HEAD", format: "terminal", baseTests: true, verbose: false, help: false };
  let index = 0;
  if (["config", "baseline", "policy", "history", "proof", "repo", "change", "change-set", "release", "outcome", "evidence", "org", "github", "factory", "work", "run", "receipt", "cell", "product", "skill", "evolution", "billing", "tui", "eval"].includes(command) && rest[0] && !rest[0].startsWith("--")) {
    options.subcommand = rest[0];
    index = 1;
  }
  if (command === "change" && options.subcommand === "contract" && rest[index] && !rest[index].startsWith("--")) {
    options.subcommand2 = rest[index];
    index += 1;
  }
  for (; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--version" || token === "-V") options.command = "version";
    else if (token === "--no-mutation") options.mutation = false;
    else if (token === "--no-base-tests") options.baseTests = false;
    else if (token === "--base") options.base = valueAfter(rest, index++, token);
    else if (token === "--head") options.head = valueAfter(rest, index++, token);
    else if (token === "--format") options.format = valueAfter(rest, index++, token) as ReportFormat;
    else if (token === "--json") options.format = "json";
    else if (token === "--config") options.config = valueAfter(rest, index++, token);
    else if (token === "--output") options.output = valueAfter(rest, index++, token);
    else if (token === "--input") options.input = valueAfter(rest, index++, token);
    else if (token === "--mode") {
      const mode = valueAfter(rest, index++, token);
      if (mode !== "advisory" && mode !== "blocking") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--mode must be advisory or blocking");
      options.mode = mode;
    } else if (token === "--fail-on") options.failOn = valueAfter(rest, index++, token).split(",").map((item) => item.trim()).filter(Boolean);
    else if (token === "--mutation-enabled") options.mutation = booleanValue(valueAfter(rest, index++, token), token);
    else if (token === "--mutation-max") {
      options.mutationMax = Number(valueAfter(rest, index++, token));
      if (!Number.isInteger(options.mutationMax) || options.mutationMax < 0) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--mutation-max must be a non-negative integer");
    } else if (token === "--comment") options.comment = booleanValue(valueAfter(rest, index++, token), token);
    else if (token === "--check-run") options.checkRun = booleanValue(valueAfter(rest, index++, token), token);
    else if (token === "--sarif") options.sarif = booleanValue(valueAfter(rest, index++, token), token);
    else if (token === "--policy") options.policy = valueAfter(rest, index++, token);
    else if (token === "--timeout") { options.timeout = Number(valueAfter(rest, index++, token)); if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--timeout must be positive"); }
    else if (token === "--max-files") { options.maxFiles = Number(valueAfter(rest, index++, token)); if (!Number.isInteger(options.maxFiles) || options.maxFiles <= 0) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--max-files must be a positive integer"); }
    else if (token === "--max-findings") { options.maxFindings = Number(valueAfter(rest, index++, token)); if (!Number.isInteger(options.maxFindings) || options.maxFindings <= 0) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--max-findings must be a positive integer"); }
    else if (token === "--type") options.artifactType = valueAfter(rest, index++, token);
    else if (token === "--port") {
      options.port = Number(valueAfter(rest, index++, token));
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--port must be an integer between 1 and 65535");
    }
    else if (token === "--host") options.host = valueAfter(rest, index++, token);
    else if (token === "--directory") options.directory = valueAfter(rest, index++, token);
    else if (token === "--repository") options.repository = valueAfter(rest, index++, token);
    else if (token === "--token") options.token = valueAfter(rest, index++, token);
    else if (token === "--url") options.url = valueAfter(rest, index++, token);
    else if (token === "--verbose") options.verbose = true;
    else if (token === "--once") options.once = true;
    else if (token === "--agent") options.agent = valueAfter(rest, index++, token);
    else if (token === "--local") options.local = true;
    else if (token === "--profile") options.profile = valueAfter(rest, index++, token);
    else if (token === "--allow-process-runner") options.allowProcessRunner = true;
    else if (token.startsWith("--")) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown option: ${token}`);
    else if (["policy", "history", "proof", "repo", "change", "change-set", "release", "outcome", "evidence", "org", "github", "factory", "work", "run", "receipt", "cell", "product", "skill", "evolution", "billing", "tui", "eval"].includes(command) && !options.positional) options.positional = token;
    else throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unexpected argument: ${token}`);
  }
  if (!["terminal", "json", "markdown", "sarif", "review-context", "receipt", "change-assurance", "release-manifest"].includes(options.format)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown report format: ${options.format}`);
  if (command === "config" && options.subcommand && !["validate", "explain"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown config command: ${options.subcommand}`);
  if (command === "baseline" && options.subcommand && !["init", "check", "update"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown baseline command: ${options.subcommand}`);
  if (command === "policy" && options.subcommand && !["list", "explain", "simulate"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown policy command: ${options.subcommand}`);
  if (command === "history" && options.subcommand && options.subcommand !== "compare") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown history command: ${options.subcommand}`);
  if (command === "proof" && options.subcommand && !["create", "verify", "replay"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown proof command: ${options.subcommand}`);
  if (command === "repo" && options.subcommand && !["inspect", "map"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown repo command: ${options.subcommand}`);
  if (command === "change" && options.subcommand && !["assess", "contract"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown change command: ${options.subcommand}`);
  if (command === "change" && options.subcommand === "contract" && options.subcommand2 && !["validate", "assess"].includes(options.subcommand2)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown change contract command: ${options.subcommand2}`);
  if (command === "change-set" && options.subcommand && !["assess", "export"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown change-set command: ${options.subcommand}`);
  if (command === "release" && options.subcommand && !["assess", "manifest"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown release command: ${options.subcommand}`);
  if (command === "outcome" && options.subcommand && !["record", "export"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown outcome command: ${options.subcommand}`);
  if (command === "evidence" && options.subcommand && !["export"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown evidence command: ${options.subcommand}`);
  if (command === "org" && options.subcommand && !["list", "switch", "seats"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown org command: ${options.subcommand}`);
  if (command === "org" && options.subcommand === "switch" && !options.positional) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "org switch requires an organization identifier");
  if (command === "billing" && options.subcommand && !["summary", "catalog", "portal"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown billing command: ${options.subcommand}`);
  if (command === "github" && options.subcommand && options.subcommand !== "run") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown github command: ${options.subcommand}`);
  if (command === "factory" && options.subcommand && !["list", "show", "validate", "sync", "mcp", "new", "plan"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown factory command: ${options.subcommand}`);
  if (command === "work" && options.subcommand && !["list", "show", "retry", "approve", "cancel", "take", "return"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown work command: ${options.subcommand}`);
  if (command === "run" && options.subcommand && !["show", "logs"].includes(options.subcommand) && !options.local) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown run command: ${options.subcommand}`);
  if (command === "eval" && options.subcommand && !["init", "add", "run", "compare", "baseline", "export"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown eval command: ${options.subcommand}`);
  if (command === "cell" && options.subcommand && !["list", "show"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown cell command: ${options.subcommand}`);
  if (command === "product" && options.subcommand && !["list", "show"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown product command: ${options.subcommand}`);
  if (command === "skill" && options.subcommand && !["list", "show"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown skill command: ${options.subcommand}`);
  if (command === "evolution" && options.subcommand && !["list", "show", "approve"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown evolution command: ${options.subcommand}`);
  if (command === "receipt" && options.subcommand && options.subcommand !== "validate") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown receipt command: ${options.subcommand}`);
  if (command === "tui" && options.subcommand && !["check", "work"].includes(options.subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown tui command: ${options.subcommand}`);
  if (command === "tui" && options.subcommand === "work" && !options.positional) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb tui work requires a work-order id");
  if (command === "tui" && options.agent && !["claude", "gemini", "codex", "cursor", "shell"].includes(options.agent)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "--agent must be claude, gemini, codex, cursor, or shell");
  if (command === "serve" && options.format !== "terminal") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "serve does not support report formats");
  return options;
}

function mutationFindings(summary: ReturnType<typeof runTargetedMutation>): Finding[] {
  return summary.results.filter((result) => result.status === "survived" || result.status === "timeout" || result.status === "no_coverage").map((result) => ({
    id: `mutation:${result.id}`,
    ruleId: result.status === "survived" ? "mutation.survived" : `mutation.${result.status}`,
    category: "mutation",
    severity: result.status === "survived" ? "high" : "warning",
    file: result.file,
    line: result.line,
    message: result.status === "survived" ? "Targeted mutant survived" : `Targeted mutation ${result.status.replace("_", " ")}`,
    explanation: result.description ?? result.reason ?? "Mutation evidence was inconclusive.",
    suggestedAction: result.status === "survived" ? "Add or strengthen a test that would kill this meaningful regression candidate." : "Review the mutation result; an unavailable mutation run is not a production failure.",
    confidence: result.status === "survived" ? "medium" : "low",
    resolution: result.status === "survived" ? "open" : "unknown",
    blocking: result.status === "survived" && Boolean(result.file && /auth|permission|token|security/i.test(result.file)),
  } satisfies Finding));
}

function repositoryLabel(root: string): string {
  try {
    const remote = redactSecrets(execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
    if (remote && !/^(?:file:|\/|[A-Za-z]:[\\/])/.test(remote)) return remote.replace(/^(https?:\/\/)[^/@]+@/, "$1").replace(/^https?:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "");
  } catch {
    // A local repository is valid without a remote.
  }
  return "local";
}

function applyOverrides(config: PrProofConfig, options: { mode?: CliOptions["mode"]; failOn?: string[]; mutation?: boolean; mutationMax?: number; comment?: boolean; checkRun?: boolean; sarif?: boolean; policy?: string; timeout?: number; maxFiles?: number; maxFindings?: number }): PrProofConfig {
  const effective = structuredClone(config);
  if (options.mode) effective.test_integrity.mode = options.mode;
  if (options.failOn) effective.impact.fail_on = options.failOn;
  if (options.mutationMax !== undefined) effective.test_integrity.mutation_testing.max_mutants = options.mutationMax;
  if (options.mutation !== undefined) effective.test_integrity.mutation_testing.enabled = options.mutation;
  if (options.comment !== undefined) effective.output.sticky_comment = options.comment;
  if (options.checkRun !== undefined) effective.output.check_run = options.checkRun;
  if (options.sarif !== undefined) effective.output.sarif = options.sarif;
  if (options.policy) effective.policy.pack = options.policy;
  let policy;
  try { policy = getPolicyPack(effective.policy.pack); }
  catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error)); }
  effective.limits = { ...effective.limits, ...policy.limits };
  if (options.timeout !== undefined) effective.limits.analysis_timeout_seconds = options.timeout;
  if (options.maxFiles !== undefined) {
    effective.limits.max_changed_files = Math.min(effective.limits.max_changed_files, options.maxFiles);
    effective.limits.max_files_analyzed = Math.min(effective.limits.max_files_analyzed, options.maxFiles);
  }
  if (options.maxFindings !== undefined) effective.limits.max_findings = Math.min(effective.limits.max_findings, options.maxFindings);
  validateConfig(effective);
  return effective;
}

function shouldIgnore(finding: Finding, ignores: PrProofConfig["test_integrity"]["ignores"]): boolean {
  const normalize = (rule: string) => rule.toLowerCase().replace(/^test_/, "").replace(/_/g, ".");
  return ignores.some((ignore) => {
    if (normalize(ignore.rule) !== normalize(finding.ruleId)) return false;
    if (!ignore.path || !finding.file) return true;
    const expression = `^${ignore.path.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`;
    return new RegExp(expression).test(finding.file);
  });
}

export interface RunOptions {
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
  comment?: boolean;
  checkRun?: boolean;
  sarif?: boolean;
  policy?: string;
  timeout?: number;
  maxFiles?: number;
  maxFindings?: number;
  onStage?: (event: StageEvent) => void;
}

export function createReport(run: RunOptions = {}): PrProofReport {
  let root: string;
  try { root = getRepoRoot(run.cwd ?? process.cwd()); } catch (error) { throw new CliFailure(EXIT_CODES.EXECUTION_ERROR, error instanceof Error ? error.message : String(error)); }
  let config: PrProofConfig;
  try { config = applyOverrides(loadConfig(root, run.configPath), { mode: run.mode, failOn: run.failOn, mutation: run.runMutation, mutationMax: run.mutationMax, comment: run.comment, checkRun: run.checkRun, sarif: run.sarif, policy: run.policy, timeout: run.timeout, maxFiles: run.maxFiles, maxFindings: run.maxFindings }); } catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error)); }
  if (run.runBaseTests === false) config.test_integrity.run_base_tests = false;
  const base = run.base ?? config.base.ref;
  const head = run.head ?? "HEAD";
  let gitContext;
  try { gitContext = createGitContext(root, base, head); } catch (error) { throw new CliFailure(EXIT_CODES.EXECUTION_ERROR, error instanceof Error ? error.message : String(error)); }
  const runTest = !run.command || run.command === "check" || run.command === "test-integrity";
  const runImpact = !run.command || run.command === "check" || run.command === "impact";
  const runFixtures = (!run.command || run.command === "check") && config.fixtures.enabled;
  const emit = (event: StageEvent) => { run.onStage?.(event); };
  emit({ type: "stage_start", id: "coverage", label: "Coverage", feedsVerdict: true });
  const coverage = readCoverage(root, config.framework.coverage_file);
  emit({ type: "stage_end", id: "coverage", status: "done", summary: coverage.available ? "coverage artifact present" : (coverage.unknowns ?? ["coverage unavailable"]).join(" "), feedsVerdict: true });
  const artifacts = config.framework.coverage_file ? [loadArtifact(root, config.framework.coverage_file)] : [];
  emit({ type: "stage_start", id: "suite", label: `Bash(${config.framework.command})`, feedsVerdict: true });
  const testIntegrity = runTest ? analyzeTestIntegrity(root, gitContext.diffs, config, { base: gitContext.base, head: gitContext.head, coverage }) : undefined;
  emit({ type: "stage_end", id: "suite", status: config.test_integrity.run_base_tests ? "done" : "locked", summary: config.test_integrity.run_base_tests ? `${testIntegrity?.unknowns.length ?? 0} suite unknowns` : "Base/head execution is disabled; missing suite evidence is UNKNOWN.", feedsVerdict: true });
  emit({ type: "stage_start", id: "integrity", label: "TestIntegrity", feedsVerdict: true });
  if (testIntegrity && coverage.unknowns?.length) testIntegrity.unknowns.push(...coverage.unknowns);
  emit({ type: "stage_end", id: "integrity", status: "done", summary: testIntegrity ? `${testIntegrity.findings.length} findings · ${testIntegrity.newTests} new tests` : "not run", feedsVerdict: true });
  let mutation;
  if (runTest && (run.runMutation ?? config.test_integrity.mutation_testing.enabled)) {
    emit({ type: "stage_start", id: "mutation", label: "Mutation", feedsVerdict: true });
    mutation = runTargetedMutation({ root, diffs: gitContext.diffs, config: config.test_integrity.mutation_testing, base: gitContext.base, head: gitContext.head, toolVersion: TOOL_VERSION, allowShellCommands: config.validation.allow_shell_commands, testConfiguration: { runner: config.framework.test_runner, command: config.framework.command, coverageFile: config.framework.coverage_file, timeoutSeconds: config.framework.test_timeout_seconds } });
    emit({ type: "stage_end", id: "mutation", status: "done", summary: `${mutation.killed} killed / ${mutation.results.length} mutants`, feedsVerdict: true });
  }
  if (testIntegrity && mutation) {
    testIntegrity.mutation = mutation;
    testIntegrity.findings = [...testIntegrity.findings, ...mutationFindings(mutation)];
    if (mutation.limitation && mutation.enabled) testIntegrity.unknowns.push(mutation.limitation);
  }
  emit({ type: "stage_start", id: "impact", label: "Impact", feedsVerdict: true });
  const impact = runImpact ? analyzeImpact({ root, base: gitContext.base, head: gitContext.head, diffs: gitContext.diffs, config, coverage }) : undefined;
  emit({ type: "stage_end", id: "impact", status: "done", summary: impact ? `${impact.paths.length} paths · ${impact.unknowns.length} unknowns` : "not run", feedsVerdict: true });
  if (run.onStage && impact) {
    const selection = selectTests({ root, head: gitContext.head, diffs: gitContext.diffs, impact, config });
    const planned = planVerificationStreams(selection, {
      runBaseTests: config.test_integrity.run_base_tests,
      runMutation: Boolean(mutation),
      watchSubset: true,
      coverageConfigured: Boolean(config.framework.coverage_file),
      fixturesEnabled: Boolean(runFixtures),
      testCommand: config.framework.command,
    });
    const subset = planned.find((stream) => stream.id === "subset");
    emit({ type: "stage_start", id: "select", label: "SelectTests", feedsVerdict: false });
    emit({ type: "stage_end", id: "select", status: "done", summary: `${selection.selected.length} selected · ${selection.requiresFullSuite ? "full suite required" : "recommendation only"}`, feedsVerdict: false });
    emit({ type: "stage_start", id: "subset", label: "Subset", feedsVerdict: false });
    emit({ type: "stage_end", id: "subset", status: subset?.locked ? "locked" : "done", summary: subset?.locked ? subset.lockReason : `${selection.selected.join("\n")}\nearly signal; does not feed the verdict`, feedsVerdict: false });
  }
  const languageFiles = listFilesAtRevision(gitContext.head, root).filter((file) => isSourceFile(file) && languageEnabled(file, config.languages));
  const languages = summarizeLanguageFiles(languageFiles, [...(impact?.unknowns ?? []), ...(testIntegrity?.unknowns ?? [])]);
  const fixtures = runFixtures ? analyzeFixtures(gitContext.diffs, config.fixtures) : undefined;
  if (runFixtures) {
    emit({ type: "stage_start", id: "fixtures", label: "Fixtures", feedsVerdict: true });
    emit({ type: "stage_end", id: "fixtures", status: "done", summary: `${fixtures?.findings.length ?? 0} findings · ${fixtures?.unknowns.length ?? 0} unknowns`, feedsVerdict: true });
  }
  const provenance = impact ? buildProvenance(root, gitContext.diffs, impact) : [];
  const policy = getPolicyPack(config.policy.pack);
  const policyUnknowns = [...new Set([...(testIntegrity?.unknowns ?? []), ...(impact?.unknowns ?? []), ...(fixtures?.unknowns ?? []), ...artifacts.flatMap((artifact) => artifact.unknowns)])];
  const policyContext = { unknowns: policyUnknowns, sensitivePath: gitContext.diffs.some((diff) => /auth|permission|token|security|credential/i.test(diff.path)) };
  const policyApply = applyPolicy([...(testIntegrity?.findings ?? []), ...(impact?.findings ?? []), ...(fixtures?.findings ?? [])].filter((finding) => !shouldIgnore(finding, config.test_integrity.ignores)), policy, policyContext);
  const policyFindings: Finding[] = policyApply.unknownHandling === "fail" && policyUnknowns.length ? [{
    id: "policy:unknown",
    ruleId: "policy.unknown",
    category: "system",
    severity: "high",
    file: "repository",
    line: 1,
    message: `Policy pack ${policy.id} requires complete evidence`,
    explanation: policyUnknowns.join(" "),
    evidence: { detail: policyUnknowns.join("\n") },
    suggestedAction: "Resolve the evidence limitations or explicitly choose an advisory policy pack.",
    confidence: "low",
    resolution: "unknown",
    blocking: true,
    module: "policy",
  }] : [];
  const sortedFindings = sortFindings([...policyApply.findings, ...policyFindings]);
  const findings = sortedFindings.slice(0, config.limits.max_findings);
  const limitations = [...new Set([...policyUnknowns, ...(sortedFindings.length > findings.length ? [`Finding output was capped at ${config.limits.max_findings}; review the full analysis in smaller bounded runs.`] : [])])];
  const summary = {
    assertionsWeakened: testIntegrity?.findings.filter((finding) => /assertion|matcher|tolerance|disabled|deleted/.test(finding.ruleId)).length ?? 0,
    newTests: testIntegrity?.newTests ?? 0,
    testsPassingOnBase: testIntegrity?.testsPassingOnBase ?? 0,
    changedLinesCoveredPercentage: testIntegrity?.coverage.percentage ?? null,
    mutantsKilled: mutation?.killed ?? 0,
    mutantsTotal: mutation?.results.length ?? 0,
    changedSymbols: impact?.changedSymbols.length ?? 0,
    downstreamConsumers: impact?.downstreamConsumers ?? 0,
    impactedTests: impact?.impactedTests ?? 0,
    impactedPathsExecuted: impact?.impactedPathsExecuted ?? 0,
    impactedPathsTotal: impact?.paths.length ?? 0,
    unverifiedPaths: impact?.unverifiedPaths.length ?? 0,
  };
  const repository = repositoryLabel(root);
  const testWithPolicy = testIntegrity ? { ...testIntegrity, findings: applyPolicy(testIntegrity.findings, policy, policyContext).findings, provenance } : undefined;
  const impactWithPolicy = impact ? { ...impact, findings: applyPolicy(impact.findings, policy, policyContext).findings } : undefined;
  const fixturesWithPolicy = fixtures ? { ...fixtures, findings: applyPolicy(fixtures.findings, policy, policyContext).findings } : undefined;
  let preliminary = finalizeReport({ schemaVersion: 1, toolVersion: TOOL_VERSION, repository, base: gitContext.base, head: gitContext.head, verdict: calculateVerdict(findings, config, limitations), summary, findings, testIntegrity: testWithPolicy, impact: impactWithPolicy, provenance, artifacts, policy: { pack: policy.id, rationale: policy.rationale, unknownHandling: policyApply.unknownHandling }, fixtures: fixturesWithPolicy, languages, limitations });
  let baseline;
  let baselineFindings = preliminary.findings;
  let baselineTestIntegrity = preliminary.testIntegrity;
  let baselineImpact = preliminary.impact;
  let baselineFixtures = preliminary.fixtures;
  let baselineDocument: ReturnType<typeof readBaseline>;
  try { baselineDocument = config.baseline.enabled ? readBaseline(root, config) : undefined; }
  catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error)); }
  if (baselineDocument) {
    baseline = compareBaseline(root, baselineDocument, preliminary.findings, gitContext.head, repository, config.baseline.waivers);
    baselineFindings = applyBaselineStates(preliminary.findings, baseline);
    if (config.baseline.fail_on_new) baselineFindings = baselineFindings.map((finding) => finding.baselineState === "new" || finding.baselineState === "expired" ? { ...finding, blocking: true } : finding);
    baselineTestIntegrity = baselineTestIntegrity ? { ...baselineTestIntegrity, findings: applyBaselineStates(baselineTestIntegrity.findings, baseline) } : undefined;
    baselineImpact = baselineImpact ? { ...baselineImpact, findings: applyBaselineStates(baselineImpact.findings, baseline) } : undefined;
    baselineFixtures = baselineFixtures ? { ...baselineFixtures, findings: applyBaselineStates(baselineFixtures.findings, baseline) } : undefined;
    if (baseline.stale) preliminary = { ...preliminary, limitations: [...new Set([...preliminary.limitations, ...baseline.unknowns])] };
  }
  const finalLimitations = preliminary.limitations;
  const policyRequestsBlocking = policy.id !== "default" && policy.id !== "agent-authored-change";
  const verdictConfig = (baseline?.newCount && config.baseline.fail_on_new) || policyRequestsBlocking || (policyApply.unknownHandling === "fail" && finalLimitations.length)
    ? { ...config, test_integrity: { ...config.test_integrity, mode: "blocking" as const } }
    : config;
  const verdict = calculateVerdict(baselineFindings, verdictConfig, finalLimitations);
  return finalizeReport({ ...preliminary, verdict, findings: baselineFindings, testIntegrity: baselineTestIntegrity, impact: baselineImpact, fixtures: baselineFixtures, baseline, limitations: finalLimitations });
}

function versionText(root = process.cwd()): string {
  let commit = "unavailable";
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { /* package may be outside a Git checkout */ }
  return `${TOOL_NAME} ${TOOL_VERSION}\ncommit: ${commit}\nruntime: ${process.version}\nplatform: ${process.platform}-${process.arch}\ncapabilities: ${FEATURE_CAPABILITIES.join(", ")}\n`;
}

function help(command?: string): string {
  if (command === "tui") return TUI_HELP;
  if (command === "agents") return "Usage: tb agents\n\nList local agent CLIs on PATH. OAuth stays in the child CLI. Tinkerbot does not store vendor tokens.\n";
  if (command === "dashboard") return "Usage: tb dashboard [--local] [--port 4174]\n\nOpen the authenticated Tinkerbot dashboard, or serve a local SQLite adapter on 127.0.0.1 with --local (not `tb serve`).\n";
  if (command === "login") return "Usage: tb login --token SESSION [--url https://control.example]\n\nStore a short-lived control-plane session. Browser login opens the public website.\n";
  if (command === "factory") return "Usage: tb factory list|show|validate|sync|mcp|new|plan\n\n`tb factory new` writes a local .tinkerbot starter tree. `tb factory plan` prints a dry-run ExecutionPlan. Then `tb factory sync` for hosted upload.\n";
  if (command === "work") return "Usage: tb work list|show|retry|approve|cancel|take|return [id]\n";
  if (command === "cell") return "Usage: tb cell list\n";
  if (command === "product") return "Usage: tb product list|show [id]\n";
  if (command === "skill") return "Usage: tb skill list|show [id]\n";
  if (command === "evolution") return "Usage: tb evolution list|show|approve [id]\n";
  if (command === "run") return "Usage: tb run show|logs <id>\n       tb run --local [--profile solo] [--allow-process-runner]\n";
  if (command === "eval") return "Usage: tb eval init|add|run|compare|baseline|export\n\nPortable personal evals. Scorers are advisory and never upgrade tb check.\n";
  if (command === "org") return "Usage: tb org list|switch|seats [organization-id]\n";
  if (command === "billing") return "Usage: tb billing summary|catalog|portal\n\nHosted billing reads the server catalog and seat quantity. Portal opens your Tinkerbot billing portal.\n";
  if (command === "receipt") return "Usage: tb receipt validate --input FILE\n\nValidate an agent execution receipt. A valid receipt never upgrades a failed or unknown verdict.\n";
  if (command === "serve") return "Usage: tb serve is retired. Use the hosted dashboard or `tb dashboard --local`.\n";
  if (command === undefined) return "Tinkerbot — factory operating system and deterministic verification\n\nHosted: login, logout, whoami, org list|switch|seats, billing summary|catalog|portal, dashboard, factory, work, cell, product, skill, evolution, run, verify\nLocal runtime: tb run --local, tb factory plan, tb eval, tb dashboard --local\nCore: tui, agents, check, test-integrity, impact, contracts, fixtures, select-tests, artifacts, history, report, doctor\nAssurance: proof create|verify|replay; repo inspect|map; change contract validate|assess; release assess; outcome record; evidence\n\nUse tb <command> --help for command details.\n";
  if (["proof", "repo", "change", "change-set", "release", "outcome", "evidence"].includes(command ?? "")) return `Usage: tb ${command} ...\n\nAssurance commands emit machine-readable JSON with --format json.\n`;
  if (["check", "test-integrity", "impact", "contracts", "fixtures", "select-tests"].includes(command ?? "")) return `Usage: tb ${command} [options]\n\nOptions:\n  --base REF              base revision\n  --head REF              head revision (default: HEAD)\n  --format FORMAT         terminal, json, markdown, or sarif\n  --output FILE           write rendered output\n  --config FILE           configuration path\n  --policy PACK           policy pack\n  --mode MODE             advisory or blocking\n  --fail-on RULES         comma-separated impact rules\n  --timeout SECONDS       analysis timeout\n  --max-files N           bound files analyzed\n  --max-findings N        bound findings emitted\n  --mutation-enabled BOOL enable/disable mutation testing\n  --mutation-max N        maximum mutants\n  --no-base-tests         skip base/head execution\n  --verbose               include additional diagnostics\n`;
  if (command === "artifacts") return "Usage: tb artifacts --input FILE [--type TYPE] [--format json|terminal]\n";
  return `Tinkerbot — factory operating system and deterministic verification\n\nCommands:\n  tb --version\n  tb login --token SESSION\n  tb tui\n  tb dashboard [--local]\n  tb factory validate|list|show|sync|mcp|new|plan
  tb run --local [--profile solo]\n  tb eval init|add|run|compare|baseline|export\n  tb agents\n  tb work list|show|take|return|approve\n  tb cell list\n  tb product list\n  tb skill list\n  tb evolution list|approve\n  tb run show <id>\n  tb check --base origin/main --head HEAD\n  tb doctor\n`;
}

function legacyInvocationWarning(): void {
  const executable = path.basename(process.argv[1] ?? "").toLowerCase();
  if (executable === "pr-proof" || executable === "pr-proof.cmd" || executable === "pr-proof.exe") {
    process.stderr.write("Tinkerbot: `pr-proof` is a deprecated compatibility alias. Use `tb` or `tinkerbot`.\n");
  }
}

function unsupportedCommand(command: string): number {
  process.stderr.write(`Tinkerbot: \`${command}\` is recognized but unavailable in this client build (exit ${EXIT_CODES.UNSUPPORTED_COMMAND}).\n`);
  return EXIT_CODES.UNSUPPORTED_COMMAND;
}

function usageFromReport(report: PrProofReport, durationMs = 0): UsageSummary {
  const findingsByRule: Record<string, number> = {};
  for (const finding of report.findings) findingsByRule[finding.ruleId] = (findingsByRule[finding.ruleId] ?? 0) + 1;
  const mutation = report.testIntegrity?.mutation;
  return {
    durationMs,
    filesAnalyzed: report.impact?.filesAnalyzed ?? 0,
    symbolsAnalyzed: report.impact?.symbolsAnalyzed ?? 0,
    mutantsAttempted: mutation?.results.length ?? 0,
    mutationCache: mutation ? mutation.cacheHit ? "hit" : mutation.enabled ? "miss" : "disabled" : "not_run",
    coverage: report.testIntegrity?.coverage.available ? "available" : "unavailable",
    findingsByRule,
    verdict: report.verdict,
    unknownReasons: report.limitations,
  };
}

function writeUsage(root: string, report: PrProofReport, durationMs: number): void {
  try {
    const directory = resolveRepositoryPath(root, ".pr-proof");
    fs.mkdirSync(directory, { recursive: true });
    const target = resolveRepositoryPath(root, ".pr-proof/usage.json");
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(usageFromReport(report, durationMs), null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* local usage is best effort */ }
    }
  } catch {
    // Usage is local convenience state; a read-only repository must not invalidate a report.
  }
}

function configCommand(options: CliOptions): number {
  let root: string;
  try { root = getRepoRoot(process.cwd()); } catch (error) { throw new CliFailure(EXIT_CODES.EXECUTION_ERROR, error instanceof Error ? error.message : String(error)); }
  try {
    const config = loadConfig(root, options.config);
    if (options.subcommand === "validate") { process.stdout.write("Configuration valid.\n"); return EXIT_CODES.PASS; }
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return EXIT_CODES.PASS;
  } catch (error) {
    throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error));
  }
}

function usageCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const file = resolveRepositoryPath(root, ".pr-proof/usage.json");
  if (!fs.existsSync(file)) { process.stdout.write("No usage report found. Run pr-proof check first.\n"); return EXIT_CODES.UNKNOWN; }
  let usage: UsageSummary;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UsageSummary>;
    if (!parsed || typeof parsed !== "object" || !Number.isFinite(parsed.durationMs) || !Number.isFinite(parsed.filesAnalyzed) || !Number.isFinite(parsed.symbolsAnalyzed) || !Number.isFinite(parsed.mutantsAttempted) || !["hit", "miss", "disabled", "not_run"].includes(String(parsed.mutationCache)) || !["available", "unavailable"].includes(String(parsed.coverage)) || !["PASS", "NEEDS_REVIEW", "UNKNOWN", "FAIL"].includes(String(parsed.verdict)) || !Array.isArray(parsed.unknownReasons) || !parsed.findingsByRule || typeof parsed.findingsByRule !== "object") throw new Error("usage report shape is invalid");
    usage = parsed as UsageSummary;
  } catch {
    throw new CliFailure(EXIT_CODES.UNKNOWN, "Usage report is malformed and cannot be trusted; run pr-proof check again.");
  }
  if (options.format === "json") process.stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
  else process.stdout.write(`PR Proof usage\nDuration: ${usage.durationMs} ms\nFiles analyzed: ${usage.filesAnalyzed}\nSymbols analyzed: ${usage.symbolsAnalyzed}\nMutants attempted: ${usage.mutantsAttempted}\nMutation cache: ${usage.mutationCache}\nCoverage: ${usage.coverage}\nVerdict: ${usage.verdict}\n`);
  return EXIT_CODES.PASS;
}

function writeOutput(root: string, options: CliOptions, content: string): void {
  if (!options.output) { process.stdout.write(content); return; }
  const target = resolveRepositoryPath(root, options.output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve the original write error */ }
  }
}

function reportExitCode(report: PrProofReport, config: PrProofConfig, options: CliOptions): number {
  if (report.verdict === "FAIL" || ((options.mode === "blocking" || config.test_integrity.mode === "blocking") && report.verdict === "NEEDS_REVIEW")) return EXIT_CODES.FAIL;
  if (report.verdict === "UNKNOWN" && config.output.fail_on_unknown) return EXIT_CODES.UNKNOWN;
  return EXIT_CODES.PASS;
}

function zeroSummary(): PrProofReport["summary"] {
  return { assertionsWeakened: 0, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 };
}

function standaloneReport(root: string, options: CliOptions, base: string, head: string, findings: Finding[], limitations: string[], extra: Partial<PrProofReport> = {}): PrProofReport {
  const config = applyOverrides(loadConfig(root, options.config), { mode: options.mode, failOn: options.failOn, mutation: options.mutation, mutationMax: options.mutationMax, comment: options.comment, checkRun: options.checkRun, sarif: options.sarif, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const pack = getPolicyPack(config.policy.pack);
  const policyResult = applyPolicy(findings, pack, { unknowns: limitations, sensitivePath: findings.some((finding) => /auth|permission|token|security|credential/i.test(finding.file ?? "")) });
  const uncappedFindings = [...policyResult.findings];
  if (policyResult.unknownHandling === "fail" && limitations.length) uncappedFindings.push({ id: "policy:unknown", ruleId: "policy.unknown", category: "system", severity: "high", file: "repository", line: 1, message: `Policy pack ${pack.id} requires complete evidence`, explanation: limitations.join(" "), evidence: { detail: limitations.join("\n") }, suggestedAction: "Resolve the evidence limitations or choose an advisory policy pack.", confidence: "low", resolution: "unknown", blocking: true, module: "policy" });
  const reportFindings = uncappedFindings.slice(0, config.limits.max_findings);
  const reportLimitations = [...new Set([...limitations, ...(uncappedFindings.length > reportFindings.length ? [`Finding output was capped at ${config.limits.max_findings}; review the analysis in smaller bounded runs.`] : [])])];
  const verdictConfig = (policyResult.unknownHandling === "fail" && reportLimitations.length) || (pack.id !== "default" && pack.id !== "agent-authored-change") ? { ...config, test_integrity: { ...config.test_integrity, mode: "blocking" as const } } : config;
  const report = { schemaVersion: 1 as const, toolVersion: TOOL_VERSION, repository: repositoryLabel(root), base, head, verdict: calculateVerdict(reportFindings, verdictConfig, reportLimitations), summary: zeroSummary(), findings: reportFindings, limitations: reportLimitations, policy: { pack: pack.id, rationale: pack.rationale, unknownHandling: policyResult.unknownHandling }, ...extra };
  return finalizeReport(report);
}

function baselineCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const config = loadConfig(root, options.config);
  const baselineFile = resolveRepositoryPath(root, config.baseline.path);
  const action = options.subcommand ?? "check";
  if (action === "init" && fs.existsSync(baselineFile)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Baseline already exists at ${path.relative(root, baselineFile)}; use baseline update explicitly.`);
  if (action === "check" && !fs.existsSync(baselineFile)) { process.stdout.write(`No baseline found at ${path.relative(root, baselineFile)}. Run pr-proof baseline init first.\n`); return EXIT_CODES.UNKNOWN; }
  const report = createReport({ cwd: root, command: "check", base: options.base, head: options.head, configPath: options.config, runMutation: options.mutation, runBaseTests: options.baseTests, mode: options.mode, failOn: options.failOn, mutationMax: options.mutationMax, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  if (action === "init" || action === "update") {
    const document = createBaseline(report.repository, report.head, TOOL_VERSION, report.findings.filter((finding) => finding.baselineState !== "waived"), config.baseline.waivers);
    writeBaseline(root, config, document);
    process.stdout.write(`Baseline ${action === "init" ? "initialized" : "updated"}: ${path.relative(root, baselineFile)} (${document.entries.length} entries).\n`);
    return EXIT_CODES.PASS;
  }
  writeOutput(root, options, renderReport(report, options.format));
  return reportExitCode(report, config, options);
}

function policyCommand(options: CliOptions): number {
  if (options.subcommand === "simulate") return policySimulationCommand(options);
  if (options.subcommand === "explain") {
    if (!options.positional) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "policy explain requires a pack name");
    try { process.stdout.write(`${explainPolicyPack(options.positional)}\n`); }
    catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error)); }
    return EXIT_CODES.PASS;
  }
  const packs = listPolicyPacks();
  if (options.format === "json") process.stdout.write(`${JSON.stringify(packs, null, 2)}\n`);
  else process.stdout.write(`${packs.map((pack) => `${pack.id}: ${pack.displayName} — ${pack.description}`).join("\n")}\n`);
  return EXIT_CODES.PASS;
}

function artifactCommand(options: CliOptions): number {
  if (!options.input) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "artifacts requires --input FILE");
  if (options.artifactType && !["lcov", "istanbul", "junit", "jest", "vitest", "stryker", "sarif", "generic"].includes(options.artifactType)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown artifact type: ${options.artifactType}`);
  const root = getRepoRoot(process.cwd());
  const artifact = loadArtifact(root, options.input, options.artifactType as ArtifactType | undefined);
  const content = options.format === "terminal" ? `Artifact: ${artifact.source}\nType: ${artifact.type}\nStatus: ${artifact.status}\nCompleteness: ${artifact.completeness}\nRecords: ${artifact.records.length}\n${artifact.unknowns.length ? `Unknowns:\n${artifact.unknowns.map((item) => `- ${item}`).join("\n")}\n` : ""}` : `${JSON.stringify(artifact, null, 2)}\n`;
  writeOutput(root, options, content);
  return artifact.status === "missing" || artifact.status === "malformed" || artifact.status === "partial" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function readInputValue(root: string, input: string | undefined): unknown {
  if (!input) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "This command requires --input FILE");
  const file = resolveRepositoryPath(root, input);
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as unknown; }
  catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Input ${input} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function reportFromInput(root: string, input: string | undefined): PrProofReport {
  const value = readInputValue(root, input);
  try { return finalizeReport(value as PrProofReport); }
  catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Input report is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}

function reportAndContextForAssurance(root: string, options: CliOptions): { report: PrProofReport; context?: ReturnType<typeof createGitContext> } {
  if (options.input) {
    const report = reportFromInput(root, options.input);
    try { return { report, context: createGitContext(root, report.base, report.head) }; }
    catch { return { report }; }
  }
  const report = createReport({ cwd: root, command: "check", base: options.base, head: options.head, configPath: options.config, runMutation: options.mutation, runBaseTests: options.baseTests, mode: options.mode, failOn: options.failOn, mutationMax: options.mutationMax, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  try { return { report, context: createGitContext(root, report.base, report.head) }; }
  catch { return { report }; }
}

function treeRevision(root: string, revision: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{tree}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    // A report imported from another environment may not have a locally
    // resolvable commit. Preserve the declared identity and surface the
    // limitation through the report rather than fabricating a tree hash.
    return revision;
  }
}

function githubChangeIdentity(): { changeId?: string; pullRequestNumber?: number; branch?: string } {
  const branch = (process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "").trim();
  let pullRequestNumber: number | undefined;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as { number?: unknown; pull_request?: { number?: unknown; head?: { ref?: unknown } } };
      const value = Number(event.pull_request?.number ?? event.number);
      if (Number.isSafeInteger(value) && value > 0) pullRequestNumber = value;
      if (!branch && typeof event.pull_request?.head?.ref === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(event.pull_request.head.ref)) return { changeId: pullRequestNumber ? `pr-${pullRequestNumber}` : undefined, pullRequestNumber, branch: event.pull_request.head.ref };
    } catch {
      // A missing or malformed CI event is local UNKNOWN context, not a reason to fail evidence generation.
    }
  }
  return { changeId: pullRequestNumber ? `pr-${pullRequestNumber}` : undefined, pullRequestNumber, branch: branch && /^[A-Za-z0-9._/-]{1,200}$/.test(branch) ? branch : undefined };
}

function persistLocalArtifact(root: string, relativePath: string, content: string): void {
  const target = resolveRepositoryPath(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, target); }
  finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve the primary result */ } }
}

function proofCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  if (!options.subcommand) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "proof requires create, verify, or replay");
  if (options.subcommand === "create") {
    const { report, context } = reportAndContextForAssurance(root, options);
    const bundle = createAssuranceBundle({ repository: report.repository, base: report.base, head: report.head, report, impact: report.impact, root, diffs: context?.diffs, now: report.generatedAt });
    const receipt = bundle.receipts[0]!;
    const content = options.format === "terminal" ? `Verification receipt\nID: ${receipt.id}\nRepository: ${receipt.repository}\nBase: ${receipt.baseSha}\nHead: ${receipt.headSha}\nVerdict: ${receipt.verdict}\nIntegrity: ${receipt.integrity.digest}\nStatus: ${receipt.states.partial ? "partial" : "complete"}\n` : serializeReceipt(receipt);
    if (!options.output) persistLocalArtifact(root, `.tinkerbot/receipts/${receipt.id}.json`, serializeReceipt(receipt));
    writeOutput(root, options, content);
    return reportExitCode(report, loadConfig(root, options.config), options);
  }
  if (!options.input) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `proof ${options.subcommand} requires --input FILE`);
  const receipt = parseReceipt(fs.readFileSync(resolveRepositoryPath(root, options.input), "utf8"));
  if (options.subcommand === "verify") {
    const result = verifyVerificationReceipt(receipt, { root, repository: options.repository, baseSha: options.base === "origin/main" ? undefined : options.base, headSha: options.head === "HEAD" ? undefined : options.head, expectedToolVersion: undefined });
    const content = options.format === "terminal" ? `Receipt verification\nStatus: ${result.status}\nValid: ${result.valid ? "yes" : "no"}\nApplicable: ${result.applicable ? "yes" : "no"}\nVerdict: ${result.verdict}\n${result.failures.length ? `Failures:\n${result.failures.map((item) => `- ${item}`).join("\n")}\n` : ""}${result.unknowns.length ? `Unknowns:\n${result.unknowns.map((item) => `- ${item}`).join("\n")}\n` : ""}` : `${JSON.stringify(result, null, 2)}\n`;
    writeOutput(root, options, content);
    return result.valid ? result.status === "partial" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS : EXIT_CODES.FAIL;
  }
  const replay = replayVerificationReceipt(receipt, { availableDependencies: [], availableToolVersions: { [receipt.tool.name]: receipt.tool.version } });
  const content = options.format === "terminal" ? `Receipt replay preflight\nStatus: ${replay.status}\nMissing dependencies: ${replay.missingDependencies.length}\nStale tools: ${replay.staleTools.length}\n${replay.unknowns.length ? replay.unknowns.map((item) => `- ${item}`).join("\n") + "\n" : ""}` : `${JSON.stringify(replay, null, 2)}\n`;
  writeOutput(root, options, content);
  return replay.status === "ready" ? EXIT_CODES.PASS : replay.status === "unknown" || replay.status === "timeout" || replay.status === "cancelled" ? EXIT_CODES.UNKNOWN : EXIT_CODES.FAIL;
}

function repoAssuranceCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const config = applyOverrides(loadConfig(root, options.config), { policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const context = createGitContext(root, options.base ?? config.base.ref, options.head);
  const impact = analyzeImpact({ root, base: context.base, head: context.head, diffs: context.diffs, config, coverage: readCoverage(root, config.framework.coverage_file) });
  const report = standaloneReport(root, options, context.base, context.head, impact.findings, impact.unknowns, { impact });
  const graph = buildVerificationGraph({ repository: report.repository, revision: context.head, baseRevision: context.base, report, impact });
  if (options.subcommand === "map") {
    const content = options.format === "terminal" ? `Verification graph\nNodes: ${graph.nodes.length}\nEdges: ${graph.edges.length}\nCompleteness: ${graph.completeness}\nUnknowns: ${graph.unknowns.length}\n` : `${JSON.stringify(graph, null, 2)}\n`;
    writeOutput(root, options, content);
    return graph.completeness === "unknown" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
  }
  const content = options.format === "terminal" ? `Repository assurance\nRepository: ${report.repository}\nRevision: ${context.head}\nChanged symbols: ${impact.changedSymbols.length}\nImpact paths: ${impact.paths.length}\nUnknowns: ${impact.unknowns.length}\n` : `${JSON.stringify({ repository: report.repository, base: context.base, head: context.head, impact, graphId: graph.id }, null, 2)}\n`;
  writeOutput(root, options, content);
  return impact.unknowns.length ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function changeCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  if (options.subcommand === "contract" && options.subcommand2 === "validate") {
    const loaded = loadChangeContract(root);
    const result = { sourcePath: loaded.sourcePath, configured: Boolean(loaded.contract), missing: loaded.missing, errors: loaded.errors, contract: loaded.contract };
    writeOutput(root, options, options.format === "terminal" ? `Change contract\nPath: ${result.sourcePath}\nConfigured: ${result.configured ? "yes" : "no"}\nStatus: ${result.errors.length ? "invalid" : result.missing ? "missing" : "valid"}\n` : `${JSON.stringify(result, null, 2)}\n`);
    return loaded.errors.length || loaded.missing ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
  }
  const config = applyOverrides(loadConfig(root, options.config), { policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const context = createGitContext(root, options.base ?? config.base.ref, options.head);
  const report = createReport({ cwd: root, command: "check", base: context.base, head: context.head, configPath: options.config, runMutation: false, runBaseTests: false, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const assessment = assessChangeContractFromRepository({ root, diffs: context.diffs, report, providedReviewers: undefined, now: report.generatedAt });
  const content = options.format === "terminal" ? `Change contract assessment\nStatus: ${assessment.status}\nViolations: ${assessment.violations.length}\nUnknowns: ${assessment.unknowns.length}\n${assessment.violations.map((violation) => `- ${violation.detail}`).join("\n")}${assessment.violations.length ? "\n" : ""}` : `${JSON.stringify(assessment, null, 2)}\n`;
  writeOutput(root, options, content);
  return assessment.status === "violations" ? EXIT_CODES.FAIL : assessment.status === "unknown" || assessment.status === "missing_configuration" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function policySimulationCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const details = readHistoryDetails(root);
  const policy = options.policy ?? options.positional ?? "default";
  const pack = getPolicyPack(policy);
  const affected = details.records.filter((record) => record.verdict !== "PASS" || (record.unknownRate ?? 0) > 0).map((record) => ({ head: record.head, recordedAt: record.recordedAt, verdict: record.verdict, unknownRate: record.unknownRate, wouldRequireReview: pack.unknownHandling === "fail" ? Boolean(record.unknownRate) : record.verdict !== "PASS" }));
  const result = { policy: pack.id, mode: "simulation", enforcementChanged: false, historicalRuns: details.records.length, affected, limitations: ["Simulation uses stored summaries only; it does not enable or persist a blocking policy."] };
  writeOutput(root, options, options.format === "terminal" ? `Policy simulation\nPolicy: ${pack.id}\nHistorical runs: ${result.historicalRuns}\nAffected: ${affected.length}\nEnforcement changed: no\n` : `${JSON.stringify(result, null, 2)}\n`);
  return EXIT_CODES.PASS;
}

function changeSetCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const value = readInputValue(root, options.input) as Partial<ChangeSet>;
  if (!value || value.kind !== "change-set") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "change-set commands require a ChangeSet JSON input with kind=change-set");
  const changeSet = value as ChangeSet;
  if (options.subcommand === "export") { writeOutput(root, options, `${JSON.stringify(changeSet, null, 2)}\n`); return EXIT_CODES.PASS; }
  const assessment = assessChangeSet(changeSet);
  writeOutput(root, options, options.format === "terminal" ? `Change Set assessment\nStatus: ${assessment.status}\nRepositories missing: ${assessment.missingRepositories.length}\nUnresolved dependencies: ${assessment.unresolvedDependencies.length}\n` : `${JSON.stringify(assessment, null, 2)}\n`);
  return assessment.status === "violations" ? EXIT_CODES.FAIL : assessment.status === "unknown" || assessment.status === "partial" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function releaseCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const value = readInputValue(root, options.input) as Partial<ReleaseManifest> & { manifest?: ReleaseManifest; receipts?: VerificationReceipt[]; contractAssessments?: unknown[]; changeSetAssessments?: unknown[] };
  const manifest = value.kind === "release-manifest" ? value as ReleaseManifest : value.manifest;
  if (!manifest || manifest.kind !== "release-manifest") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "release commands require a ReleaseManifest JSON input with kind=release-manifest");
  if (options.subcommand === "manifest") { writeOutput(root, options, `${JSON.stringify(manifest, null, 2)}\n`); return EXIT_CODES.PASS; }
  const assessment = assessReleaseSafety({ manifest, receipts: value.receipts, contractAssessments: value.contractAssessments as never[] | undefined, changeSetAssessments: value.changeSetAssessments as never[] | undefined });
  writeOutput(root, options, options.format === "terminal" ? `Release safety assessment\nRelease: ${manifest.releaseId}\nStatus: ${assessment.status}\nBlocking: ${assessment.blocking.length}\nUnknowns: ${assessment.unknowns.length}\n` : `${JSON.stringify(assessment, null, 2)}\n`);
  return assessment.status === "blocked" ? EXIT_CODES.FAIL : assessment.status === "unknown" || assessment.status === "partial" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function outcomeCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  if (options.subcommand === "export") {
    const outcomes = exportRuntimeOutcomes(root);
    writeOutput(root, options, `${JSON.stringify(outcomes, null, 2)}\n`);
    return outcomes.length ? EXIT_CODES.PASS : EXIT_CODES.UNKNOWN;
  }
  const value = readInputValue(root, options.input) as Partial<RuntimeOutcome>;
  const outcome = value.kind === "runtime-outcome" ? value as RuntimeOutcome : createRuntimeOutcome({ outcomeType: value.outcomeType!, observedAt: value.observedAt ?? new Date().toISOString(), repository: value.repository, changeRecordRefs: value.changeRecordRefs, association: value.association, facts: value.facts, externalSignal: value.externalSignal, retention: value.retention });
  appendRuntimeOutcome(root, outcome);
  writeOutput(root, options, options.format === "terminal" ? `Outcome recorded\nID: ${outcome.id}\nType: ${outcome.outcomeType}\nAssociation: ${outcome.association.type}\n` : `${JSON.stringify(outcome, null, 2)}\n`);
  return EXIT_CODES.PASS;
}

function evidenceCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  if (options.input) {
    const raw = fs.readFileSync(resolveRepositoryPath(root, options.input), "utf8");
    if (options.format === "change-assurance" && raw.includes('"schemaId":"https://tinkerbot.dev/schemas/assurance/v1"')) { writeOutput(root, options, raw.endsWith("\n") ? raw : `${raw}\n`); return EXIT_CODES.PASS; }
  }
  const { report, context } = reportAndContextForAssurance(root, options);
  const bundle = createAssuranceBundle({ repository: report.repository, base: report.base, head: report.head, report, impact: report.impact, root, diffs: context?.diffs, now: report.generatedAt });
  const evidence = createEvidenceContract({
    report,
    repository: report.repository,
    baseSha: report.base,
    headSha: report.head,
    treeSha: treeRevision(root, report.head),
    policyVersion: report.policy?.pack,
    configuration: loadConfig(root, options.config),
    changedFiles: context?.diffs.map((diff) => diff.path),
    changedSymbols: report.impact?.changedSymbols.map((symbol) => `${symbol.file}#${symbol.name}`),
    ...githubChangeIdentity(),
    generatedAt: report.generatedAt,
    observedAt: report.generatedAt,
  });
  const enriched = { ...report, assurance: bundle, evidence };
  const content = renderReport(enriched, options.format === "terminal" ? "json" : options.format);
  writeOutput(root, options, content);
  return bundle.unknowns.length ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function selectionCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const config = applyOverrides(loadConfig(root, options.config), { policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const context = createGitContext(root, options.base ?? config.base.ref, options.head);
  const impact = analyzeImpact({ root, base: context.base, head: context.head, diffs: context.diffs, config, coverage: readCoverage(root, config.framework.coverage_file) });
  const plan = selectTests({ root, head: context.head, diffs: context.diffs, impact, config });
  const content = options.format === "json" ? `${JSON.stringify(plan, null, 2)}\n` : `Test selection\nStatus: ${plan.status}\nConfidence: ${plan.confidence}\nSelected: ${plan.selected.length}\nRelated: ${plan.related.length}\nUnrelated: ${plan.unrelated.length}\nUnknown: ${plan.unknown.length}\nRequires full suite: ${plan.requiresFullSuite ? "yes" : "no"}\nFallback: ${plan.fallback}\n${plan.unknowns.length ? `Unknowns:\n${plan.unknowns.map((item) => `- ${item}`).join("\n")}\n` : ""}`;
  writeOutput(root, options, content);
  return plan.status === "unknown" && config.output.fail_on_unknown ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
}

function contractsCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const config = applyOverrides(loadConfig(root, options.config), { policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const context = createGitContext(root, options.base ?? config.base.ref, options.head);
  const contracts = analyzeContracts({ root, base: context.base, head: context.head, config });
  const report = standaloneReport(root, options, context.base, context.head, contracts.findings, contracts.unknowns, { contracts });
  writeOutput(root, options, renderReport(report, options.format));
  return reportExitCode(report, config, options);
}

function fixturesCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const config = applyOverrides(loadConfig(root, options.config), { policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
  const context = createGitContext(root, options.base ?? config.base.ref, options.head);
  const fixtures = analyzeFixtures(context.diffs, config.fixtures);
  const report = standaloneReport(root, options, context.base, context.head, fixtures.findings, fixtures.unknowns, { fixtures });
  writeOutput(root, options, renderReport(report, options.format));
  return reportExitCode(report, config, options);
}

function historyCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  if (options.subcommand === "compare") {
    if (!options.positional) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "history compare requires a revision");
    const comparison = compareHistory(root, options.positional);
    process.stdout.write(options.format === "json" ? `${JSON.stringify(comparison, null, 2)}\n` : `History comparison for ${options.positional}\nMatches: ${comparison.matches.length}\n${comparison.current ? `Latest: ${comparison.current.verdict} at ${comparison.current.recordedAt}\n` : ""}${comparison.unknowns.length ? comparison.unknowns.map((item) => `- ${item}`).join("\n") + "\n" : ""}`);
    return comparison.unknowns.length ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
  }
  const details = readHistoryDetails(root);
  const diagnostics = [
    ...(details.malformedLines ? [`${details.malformedLines} malformed history record(s) were ignored.`] : []),
    ...(details.ignoredSchemaLines ? [`${details.ignoredSchemaLines} history record(s) used an unsupported schema.`] : []),
  ];
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(details.records, null, 2)}\n`);
    if (diagnostics.length) process.stderr.write(`${diagnostics.map((item) => `PR Proof history warning: ${item}`).join("\n")}\n`);
  } else if (details.records.length) {
    process.stdout.write(`${details.records.map((record) => `${record.recordedAt} ${record.head} ${record.verdict} findings=${Object.values(record.findingsByRule).reduce((sum, count) => sum + count, 0)}`).join("\n")}\n`);
    if (diagnostics.length) process.stdout.write(`${diagnostics.map((item) => `Warning: ${item}`).join("\n")}\n`);
  } else process.stdout.write("No local verification history exists yet.\n");
  return details.records.length && !diagnostics.length ? EXIT_CODES.PASS : EXIT_CODES.UNKNOWN;
}

function classifyError(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  const message = redactSecrets(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
  if (/configuration|unknown policy|unknown artifact|requires --|must be|unsupported pr-proof|baseline/i.test(message)) return new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, message);
  if (/\bgit\b|revision|repository|worktree|base\/head/i.test(message)) return new CliFailure(EXIT_CODES.EXECUTION_ERROR, message);
  return new CliFailure(EXIT_CODES.INTERNAL_ERROR, message);
}

export function runCli(argv = process.argv.slice(2)): number {
  const started = Date.now();
  legacyInvocationWarning();
  let options: CliOptions;
  try { options = parseArgs(argv); } catch (error) { const message = redactSecrets(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "); process.stderr.write(`PR Proof configuration error: ${message}\n`); return error instanceof CliFailure ? error.code : EXIT_CODES.CONFIGURATION_ERROR; }
  try {
    if (options.help || options.command === "help" || options.command === "-h") { process.stdout.write(help(options.command === "help" ? undefined : options.command)); return EXIT_CODES.PASS; }
    if (options.command === "version") { process.stdout.write(versionText()); return EXIT_CODES.PASS; }
    if (options.command === "dashboard") {
      if (options.local) return localDashboardCommand(options);
      return dashboardCommand();
    }
    if (options.command === "tui") return tuiCommand(options);
    if (options.command === "login") return loginCommand(options);
    if (options.command === "factory" && options.subcommand === "validate") return factoryValidateCommand();
    if (options.command === "factory" && options.subcommand === "plan") {
      process.stdout.write(`${JSON.stringify(factoryPlanPayload(getRepoRoot(process.cwd()), options.profile, options.positional), null, 2)}\n`);
      return EXIT_CODES.PASS;
    }
    if (options.command === "factory" && options.subcommand === "mcp") return factoryMcpCommand();
    if (options.command === "factory" && options.subcommand === "new") return factoryNewCommand(options);
    if (options.command === "eval") {
      process.stdout.write(`${JSON.stringify(evalCli(getRepoRoot(process.cwd()), options.subcommand ?? "run", options.positional), null, 2)}\n`);
      return EXIT_CODES.PASS;
    }
    if (options.command === "agents") {
      process.stdout.write(listAgentsJson(process.env));
      return EXIT_CODES.PASS;
    }
    if (options.command === "receipt") return receiptValidateCommand(options);
    if (["logout", "whoami", "org", "verify", "explain", "github", "cell", "product", "skill", "evolution", "billing"].includes(options.command)) return unsupportedCommand(options.subcommand ? `${options.command} ${options.subcommand}` : options.command);
    if (options.command === "doctor") {
      const doctor = runDoctor(process.cwd(), options.config, options.base, options.head);
      process.stdout.write(renderDoctor(doctor));
      return doctor.healthy ? EXIT_CODES.PASS : EXIT_CODES.UNKNOWN;
    }
    if (options.command === "config") return configCommand(options);
    if (options.command === "usage") return usageCommand(options);
    if (options.command === "policy") return policyCommand(options);
    if (options.command === "baseline") return baselineCommand(options);
    if (options.command === "artifacts") return artifactCommand(options);
    if (options.command === "select-tests") return selectionCommand(options);
    if (options.command === "contracts") return contractsCommand(options);
    if (options.command === "fixtures") return fixturesCommand(options);
    if (options.command === "history") return historyCommand(options);
    if (options.command === "proof") return proofCommand(options);
    if (options.command === "repo") return repoAssuranceCommand(options);
    if (options.command === "change") return changeCommand(options);
    if (options.command === "change-set") return changeSetCommand(options);
    if (options.command === "release") return releaseCommand(options);
    if (options.command === "outcome") return outcomeCommand(options);
    if (options.command === "evidence") return evidenceCommand(options);
    if (options.command === "serve") return unsupportedCommand("serve");
    if (!["check", "test-integrity", "impact", "report"].includes(options.command)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Unknown command: ${options.command}`);
    const root = getRepoRoot(process.cwd());
    let report: PrProofReport;
    if (options.command === "report" && options.input) {
      try { report = finalizeReport(JSON.parse(fs.readFileSync(resolveRepositoryPath(root, options.input), "utf8")) as PrProofReport); }
      catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Invalid report input: ${error instanceof Error ? error.message : String(error)}`); }
    }
    else report = createReport({ cwd: root, command: options.command === "report" ? "check" : options.command as "check" | "test-integrity" | "impact", base: options.base, head: options.head, configPath: options.config, runMutation: options.mutation, runBaseTests: options.baseTests, mode: options.mode, failOn: options.failOn, mutationMax: options.mutationMax, comment: options.comment, checkRun: options.checkRun, sarif: options.sarif, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
    const rendered = renderReport(report, options.format);
    writeOutput(root, options, rendered);
    writeUsage(root, report, Date.now() - started);
    try {
      const changedFiles = createGitContext(root, report.base, report.head).diffs.length;
      appendHistory(root, historyRecordFromReport(report, Date.now() - started, report.selection, changedFiles));
    } catch {
      // History is local convenience state; a report must remain usable when it cannot be written.
    }
    let config: PrProofConfig;
    try { config = loadConfig(root, options.config); } catch { config = loadConfig(root); }
    if (report.verdict === "FAIL" || ((options.mode === "blocking" || config.test_integrity.mode === "blocking") && report.verdict === "NEEDS_REVIEW")) return EXIT_CODES.FAIL;
    if (report.verdict === "UNKNOWN" && config.output.fail_on_unknown) return EXIT_CODES.UNKNOWN;
    return EXIT_CODES.PASS;
  } catch (error) {
    const failure = classifyError(error);
    const label = failure.code === EXIT_CODES.CONFIGURATION_ERROR ? "configuration" : failure.code === EXIT_CODES.INTERNAL_ERROR ? "internal" : "execution";
    process.stderr.write(`PR Proof ${label} error: ${failure.message}\n`);
    return failure.code;
  }
}

export function main(argv = process.argv.slice(2)): number {
  return runCli(argv);
}

interface HostedResponse {
  status: number;
  body: Record<string, unknown>;
}

function factoryMcpCommand(): number {
  const url = hostedSession().url;
  if (!url || !/^https:\/\//.test(url)) {
    process.stderr.write("Tinkerbot Factory MCP requires `tb login` with an HTTPS control-plane URL.\n");
    return EXIT_CODES.UNKNOWN;
  }
  process.stdout.write(`${url.replace(/\/$/, "")}/mcp\n`);
  return EXIT_CODES.PASS;
}

function factoryValidateCommand(): number {
  try {
    const loaded = loadFactoryDefinition(getRepoRoot(process.cwd()));
    process.stdout.write(`${JSON.stringify({ valid: true, path: loaded.path, digest: loaded.digest, name: loaded.definition.name, repositories: loaded.definition.repositories }, null, 2)}\n`);
    return EXIT_CODES.PASS;
  } catch (error) {
    throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, error instanceof Error ? error.message : String(error));
  }
}

function factoryNewCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const existing = path.join(root, ".tinkerbot", "factory.yaml");
  if (fs.existsSync(existing)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "A factory definition already exists. Edit it in git, then run tb factory sync.");
  const starter = buildFactoryStarter({
    name: options.positional?.trim() || path.basename(root),
    owner: "owner",
    repository: "repository",
  });
  for (const file of starter.files) {
    const dest = path.join(root, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.contents);
  }
  process.stdout.write(`${JSON.stringify({ created: true, path: ".tinkerbot", files: starter.files.map((file) => file.path), next: "tb factory validate && tb factory sync" }, null, 2)}\n`);
  return EXIT_CODES.PASS;
}

function receiptValidateCommand(options: CliOptions): number {
  if (options.subcommand !== "validate") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "Usage: tb receipt validate --input FILE");
  if (!options.input) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb receipt validate requires --input.");
  const root = getRepoRoot(process.cwd());
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(resolveRepositoryPath(root, options.input), "utf8")); }
  catch (error) { throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, `Invalid receipt input: ${error instanceof Error ? error.message : String(error)}`); }
  const result = validateAgentReceipt(parsed);
  process.stdout.write(`${JSON.stringify({ ...result, upgradesVerdict: false }, null, 2)}\n`);
  return result.valid ? EXIT_CODES.PASS : EXIT_CODES.UNKNOWN;
}

function loginCommand(options: CliOptions): number {
  const url = options.url ?? hostedSession().url;
  const token = options.token ?? hostedSession().token;
  if (!url || !/^https:\/\//.test(url) || !token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    process.stderr.write("Tinkerbot: open the website to authenticate, then run `tb login --url https://… --token SESSION`.\n");
    return EXIT_CODES.CONFIGURATION_ERROR;
  }
  saveStoredCredentials({ controlPlaneUrl: url.replace(/\/$/, ""), sessionToken: token });
  process.stdout.write("Stored Tinkerbot control-plane credentials.\n");
  return EXIT_CODES.PASS;
}

function shouldOpenDashboardBrowser(): boolean {
  if (process.env.CI === "true" || process.env.VITEST || process.env.TINKERBOT_OPEN_BROWSER === "0") return false;
  return process.env.TINKERBOT_OPEN_BROWSER === "1" || Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function localRuntimeTuiView(root: string): { plan: string; cost: string; eval: string } {
  const view = localDashboardPayload(root);
  return { plan: formatPlanTab(view), cost: formatCostTab(view), eval: formatEvalTab(view) };
}

function localDashboardCommand(options: CliOptions): number {
  const root = getRepoRoot(process.cwd());
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4174;
  const url = localDashboardUrl(host, port);
  process.stdout.write(`${url}\n`);
  process.stdout.write(`${JSON.stringify(localDashboardPayload(root), null, 2)}\n`);
  const skipListen = process.env.VITEST || process.env.CI === "true" || process.env.TINKERBOT_DASHBOARD_LISTEN === "0";
  if (skipListen && process.env.TINKERBOT_DASHBOARD_LISTEN !== "1") return EXIT_CODES.PASS;
  const server = createLocalDashboardServer({ root, host, port, directory: options.directory });
  server.listen(port, host, () => {
    process.stdout.write(`Local dashboard adapter (SQLite, organizationId=local): ${url}\n`);
  });
  if (shouldOpenDashboardBrowser()) {
    try { execFileSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? ["/c", "start", "", url] : [url], { stdio: "ignore" }); } catch { /* URL is printed */ }
  }
  return EXIT_CODES.PASS;
}

function dashboardCommand(): number {
  const url = hostedSession().url;
  if (!url || !/^https:\/\//.test(url)) {
    process.stderr.write("Tinkerbot dashboard is unavailable until `tb login` stores an HTTPS control-plane URL.\n");
    return EXIT_CODES.UNKNOWN;
  }
  const target = `${url.replace(/\/$/, "")}/app`;
  process.stdout.write(`${target}\n`);
  if (!shouldOpenDashboardBrowser()) return EXIT_CODES.PASS;
  try { execFileSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", process.platform === "win32" ? ["/c", "start", "", target] : [target], { stdio: "ignore" }); } catch { /* print the URL even if a browser cannot be launched */ }
  return EXIT_CODES.PASS;
}

function tuiOptionsFrom(options: CliOptions): TuiOptions {
  return { help: options.help, subcommand: options.subcommand, positional: options.positional, once: options.once, base: options.base, head: options.head, config: options.config, mutation: options.mutation, baseTests: options.baseTests, mode: options.mode, failOn: options.failOn, mutationMax: options.mutationMax, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings, agent: options.agent };
}

function makeTuiDeps(): TuiDeps {
  return {
    header: () => {
      try {
        const root = getRepoRoot(process.cwd());
        const config = loadConfig(root);
        return { repo: repositoryLabel(root), base: config.base.ref, head: "HEAD", cwd: root };
      } catch {
        return { repo: "local", base: "origin/main", head: "HEAD", cwd: process.cwd() };
      }
    },
    createReport,
    reportExitCode: (report) => {
      try {
        const config = loadConfig(getRepoRoot(process.cwd()));
        if (report.verdict === "FAIL" || (config.test_integrity.mode === "blocking" && report.verdict === "NEEDS_REVIEW")) return EXIT_CODES.FAIL;
        if (report.verdict === "UNKNOWN" && config.output.fail_on_unknown) return EXIT_CODES.UNKNOWN;
        return EXIT_CODES.PASS;
      } catch {
        return report.verdict === "FAIL" ? EXIT_CODES.FAIL : report.verdict === "UNKNOWN" ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
      }
    },
    openDashboard: dashboardCommand,
    localRuntime: () => localRuntimeTuiView(process.cwd()),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
  };
}

function tuiCommand(options: CliOptions): number {
  return runTui(tuiOptionsFrom(options), makeTuiDeps());
}

export async function dispatchTui(options: TuiOptions, deps: TuiDeps, interactive: boolean): Promise<number> {
  if (interactive && !options.once && !options.help) {
    const agent = isAgentId(options.agent) ? options.agent : undefined;
    return runMasterTuiInteractive({
      workOrderId: options.subcommand === "work" ? options.positional : undefined,
      agent,
      help: options.help,
    }, {
      stdout: deps.stdout,
      stderr: deps.stderr,
      cwd: deps.cwd,
      env: deps.env,
      stdin: deps.stdin,
      header: () => {
        const header = deps.header();
        return { repo: header.repo, base: header.base, head: header.head };
      },
      openDashboard: deps.openDashboard,
      localRuntime: deps.localRuntime ?? (() => localRuntimeTuiView(deps.cwd)),
      createReport: (input) => deps.createReport({ cwd: input.cwd, command: "check", base: options.base, head: options.head, runBaseTests: options.baseTests }),
      fetchWork: deps.fetchWork ? (id) => {
        const view = deps.fetchWork!(id);
        return { summary: `Work ${id}. Agent stage text is not a verdict.`, verdict: view.workOrder?.verificationVerdict };
      } : undefined,
    });
  }
  return runTui(options, deps);
}

function hostedConfigurationError(): string | undefined {
  const session = hostedSession();
  const base = session.url?.replace(/\/$/, "");
  const token = session.token;
  if (!base || !/^https:\/\//.test(base)) return "Hosted commands require an HTTPS TINKERBOT_CONTROL_PLANE_URL or `tb login`.";
  if (!token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) return "Hosted commands require TINKERBOT_SESSION_TOKEN from an authenticated Tinkerbot session.";
  return undefined;
}

async function hostedRequest(pathname: string, method = "GET", payload?: Record<string, unknown>): Promise<HostedResponse> {
  const session = hostedSession();
  const base = session.url?.replace(/\/$/, "");
  const token = session.token;
  const configurationError = hostedConfigurationError();
  if (configurationError) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, configurationError);
  let response: Response;
  try {
    response = await fetch(`${base}${pathname}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  } catch {
    throw new CliFailure(EXIT_CODES.EXECUTION_ERROR, "The Tinkerbot control plane could not be reached.");
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* A malformed provider response remains a non-success result. */ }
  return { status: response.status, body };
}

async function runHostedCli(argv: string[]): Promise<number | undefined> {
  const command = argv[0];
  if (!command) return undefined;
    if (command === "factory" && argv[1] && argv[1] !== "validate" && argv[1] !== "mcp" && argv[1] !== "new" && argv[1] !== "plan") {
    const subcommand = argv[1];
    const id = argv[2];
    const pathname = subcommand === "list" || !id ? "/factories" : `/factories/${id}`;
    let payload: Record<string, unknown> | undefined;
    if (subcommand === "sync") {
      const loaded = loadFactoryDefinition(getRepoRoot(process.cwd()));
      payload = { name: loaded.definition.name, yaml: fs.readFileSync(loaded.path, "utf8"), files: loaded.files };
    }
    const response = await hostedRequest(pathname, subcommand === "sync" ? "POST" : "GET", payload);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "work") {
    const subcommand = argv[1] ?? "list";
    const id = argv[2];
    const method = ["retry", "approve", "cancel", "take", "return"].includes(subcommand) ? "POST" : "GET";
    const pathname = !id && subcommand === "list" ? "/work-orders" : id ? `/work-orders/${id}${method === "POST" ? `/${subcommand}` : ""}` : `/work-orders/${subcommand}`;
    const response = await hostedRequest(pathname, method);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "cell" || command === "product" || command === "skill" || command === "evolution") {
    const subcommand = argv[1] ?? "list";
    const id = argv[2];
    const collection = command === "cell" ? "cells" : command === "product" ? "products" : command === "skill" ? "skills" : "evolution";
    const method = command === "evolution" && subcommand === "approve" ? "POST" : "GET";
    const pathname = subcommand === "approve" && id ? `/evolution/${id}/approve` : subcommand === "show" && id ? `/${collection}/${id}` : `/${collection}`;
    const response = await hostedRequest(pathname, method);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "run") {
    if (argv.includes("--local")) return undefined;
    const id = argv[2] ?? argv[1];
    if (!id || id === "show" || id === "logs") throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb run show requires a run id.");
    const response = await hostedRequest(`/runs/${id}${argv[1] === "logs" ? "/events" : ""}`);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "org") {
    const subcommand = argv[1] ?? "list";
    if (subcommand !== "list" && subcommand !== "switch" && subcommand !== "seats") return undefined;
    const organizationId = argv[2];
    if (subcommand === "switch" && !organizationId) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb org switch requires an organization identifier.");
    const pathname = subcommand === "list" ? "/tenant/organizations" : subcommand === "seats" ? "/org/seats" : "/tenant/organizations/switch";
    const response = await hostedRequest(pathname, subcommand === "switch" ? "POST" : "GET", subcommand === "switch" ? { organizationId } : undefined);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "billing") {
    const subcommand = argv[1] ?? "summary";
    if (!["summary", "catalog", "portal"].includes(subcommand)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb billing supports summary, catalog, or portal.");
    const pathname = subcommand === "summary" ? "/billing/summary" : subcommand === "catalog" ? "/billing/catalog" : "/billing/portal";
    const response = await hostedRequest(pathname, subcommand === "portal" ? "POST" : "GET", subcommand === "portal" ? {} : undefined);
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return EXIT_CODES.PASS;
  }
  if (command === "verify") {
    const configurationError = hostedConfigurationError();
    if (configurationError) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, configurationError);
    const options = parseArgs(argv);
    const root = getRepoRoot(process.cwd());
    const report = options.input
      ? reportFromInput(root, options.input)
      : createReport({ cwd: root, command: "check", base: options.base, head: options.head, configPath: options.config, runMutation: options.mutation, runBaseTests: options.baseTests, mode: options.mode, failOn: options.failOn, mutationMax: options.mutationMax, policy: options.policy, timeout: options.timeout, maxFiles: options.maxFiles, maxFindings: options.maxFindings });
    let context: ReturnType<typeof createGitContext> | undefined;
    try { context = createGitContext(root, report.base, report.head); } catch { /* The bundle carries explicit UNKNOWN provenance when Git context is unavailable. */ }
    const assurance = createAssuranceBundle({ repository: report.repository, base: report.base, head: report.head, report, impact: report.impact, root, diffs: context?.diffs, now: report.generatedAt });
    const repository = options.repository ?? report.repository;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new CliFailure(EXIT_CODES.CONFIGURATION_ERROR, "tb verify requires --repository owner/repository or a GitHub origin remote.");
    const response = await hostedRequest("/assurance/ingest", "POST", { repository, assurance });
    if (response.status < 200 || response.status >= 300) {
      process.stderr.write(`Tinkerbot hosted verification was rejected: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
      return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
    }
    process.stdout.write(`${JSON.stringify({ ...response.body, localVerdict: report.verdict, unknowns: assurance.unknowns }, null, 2)}\n`);
    return assurance.unknowns.length ? EXIT_CODES.UNKNOWN : EXIT_CODES.PASS;
  }
  if (command !== "whoami" && command !== "logout") return undefined;
  const response = await hostedRequest(command === "whoami" ? "/auth/session" : "/auth/signout", command === "whoami" ? "GET" : "POST");
  if (response.status < 200 || response.status >= 300) {
    process.stderr.write(`Tinkerbot hosted request failed: ${String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`)}\n`);
    return response.status === 401 || response.status === 403 ? EXIT_CODES.UNKNOWN : EXIT_CODES.EXECUTION_ERROR;
  }
  if (command === "whoami") process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
  else {
    clearStoredCredentials();
    process.stdout.write("Signed out of the Tinkerbot control plane.\n");
  }
  return EXIT_CODES.PASS;
}

export async function mainAsync(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === "run" && argv.includes("--local")) {
      const options = parseArgs(argv);
      const session = hostedSession();
      const postSync = session.url && session.token
        ? async (kind: string, body: Record<string, unknown>) => {
          try {
            const response = await hostedRequest("/runtime/sync", "POST", body.kind ? body : { kind, ...body });
            return { ok: response.status >= 200 && response.status < 300 };
          } catch {
            return { ok: false };
          }
        }
        : undefined;
      const payload = await executeLocalRun(getRepoRoot(process.cwd()), {
        profile: options.profile,
        allowProcessRunner: options.allowProcessRunner,
        text: options.positional,
        warn: (message) => process.stderr.write(`${message}\n`),
        postSync,
      });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return EXIT_CODES.PASS;
    }
    if (argv[0] === "tui") {
      const options = parseArgs(argv);
      const deps: TuiDeps = {
        ...makeTuiDeps(),
        fetchWorkAsync: async (id) => {
          const response = await hostedRequest(`/work-orders/${id}`);
          if (response.status < 200 || response.status >= 300) return {};
          return response.body as { workOrder?: { workOrderId?: string; status?: string; currentStage?: string; verificationVerdict?: string; verificationIngested?: boolean }; run?: { run_id?: string; status?: string }; stages?: Array<{ stage?: string; status?: string; summary?: string }> };
        },
        workActionAsync: async (id, action, note) => {
          const response = await hostedRequest(`/work-orders/${id}/${action}`, "POST", action === "steer" ? { note } : undefined);
          if (response.status < 200 || response.status >= 300) return { ok: false, message: String(response.body.error ?? response.body.code ?? `HTTP ${response.status}`) };
          return { ok: true, message: action === "approve" ? "Specification approval recorded. Humans still merge." : `${action} recorded.` };
        },
      };
      if (options.subcommand === "work" && options.positional && deps.fetchWorkAsync) {
        const view = await deps.fetchWorkAsync(options.positional);
        deps.fetchWork = () => view;
      }
      return dispatchTui(tuiOptionsFrom(options), deps, isInteractiveTty(process.stdout, process.stdin, process.env) && !options.once && !options.help);
    }
    const hosted = await runHostedCli(argv);
    return hosted ?? runCli(argv);
  } catch (error) {
    const failure = classifyError(error);
    process.stderr.write(`Tinkerbot hosted error: ${failure.message}\n`);
    return failure.code;
  }
}

if (require.main === module) void mainAsync().then((code) => { process.exitCode = code; });
