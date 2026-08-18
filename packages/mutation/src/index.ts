import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { FileDiff, MutationConfig, MutationResult, MutationState, MutationSummary } from "../../core/src/types";
import { redactSecrets, resolveRepositoryPath, safeChildEnvironment, tokenizeCommand } from "../../core/src/safety";
import { isSourceFile, isTestFile } from "../../git/src";
import { languageForFile } from "../../language-core/src";

export interface MutationOptions {
  root: string;
  diffs: FileDiff[];
  config: MutationConfig;
  base: string;
  head: string;
  toolVersion?: string;
  testConfiguration?: { runner?: string; command?: string; coverageFile?: string; timeoutSeconds?: number };
  allowShellCommands?: boolean;
}

function repositoryIdentity(root: string): string {
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return remote.replace(/^(https?:\/\/)([^/@]+@)/i, "$1") || execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return root;
  }
}

function lockHash(root: string): string {
  for (const file of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const absolute = path.join(root, file);
    try {
      if (fs.statSync(absolute).size <= 16 * 1024 * 1024) return crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    } catch {
      return "unavailable";
    }
  }
  return "none";
}

function mutationEngineVersion(root: string): string {
  const binary = path.join(root, "node_modules", ".bin", "stryker");
  try { return execFileSync(fs.existsSync(binary) ? binary : "stryker", ["--version"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; } catch { return "unknown"; }
}

function cacheKey(options: MutationOptions, scope: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify({ repository: repositoryIdentity(options.root), base: options.base, head: options.head, lockHash: lockHash(options.root), testConfiguration: options.testConfiguration, config: options.config, allowShellCommands: options.allowShellCommands === true, scope, mutationEngineVersion: mutationEngineVersion(options.root), toolVersion: options.toolVersion ?? "0.1.0" })).digest("hex");
}

export function mutationScope(diffs: FileDiff[], maxFiles = Number.POSITIVE_INFINITY): string[] {
  return diffs.filter((diff) => isSourceFile(diff.path) && !isTestFile(diff.path)).slice(0, maxFiles).map((diff) => diff.path);
}

function stateFor(status: unknown): MutationState {
  const normalized = String(status ?? "").toLowerCase().replace(/[ -]/g, "_");
  if (normalized.includes("killed")) return "killed";
  if (normalized.includes("surviv")) return "survived";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("no_coverage") || normalized.includes("nocoverage")) return "no_coverage";
  if (normalized.includes("not_run") || normalized.includes("notrun")) return "not_run";
  return "unknown";
}

export function normalizeMutationReport(raw: unknown, maxMutants: number): MutationResult[] {
  const value = raw as { mutantResults?: unknown[]; mutants?: unknown[] };
  const list = Array.isArray(value?.mutantResults) ? value.mutantResults : Array.isArray(value?.mutants) ? value.mutants : Array.isArray(raw) ? raw : [];
  const normalized = list.slice(0, Math.max(0, maxMutants)).map((entry, index) => {
    const mutant = (entry ?? {}) as Record<string, unknown>;
    const location = (mutant.location ?? mutant.range ?? {}) as Record<string, unknown>;
    return {
      id: String(mutant.id ?? `mutant-${index + 1}`),
      file: typeof mutant.fileName === "string" ? mutant.fileName : typeof mutant.file === "string" ? mutant.file : undefined,
      line: Number((location.start as Record<string, unknown> | undefined)?.line ?? location.line ?? mutant.line) || undefined,
      mutator: typeof mutant.mutatorName === "string" ? mutant.mutatorName : typeof mutant.mutator === "string" ? mutant.mutator : undefined,
      description: typeof mutant.description === "string" ? mutant.description : undefined,
      status: stateFor(mutant.status),
      reason: typeof mutant.statusReason === "string" ? mutant.statusReason : typeof mutant.reason === "string" ? mutant.reason : undefined,
    } satisfies MutationResult;
  });
  return normalized.sort((a, b) => `${a.file ?? ""}:${a.line ?? 0}:${a.id}`.localeCompare(`${b.file ?? ""}:${b.line ?? 0}:${b.id}`));
}

function summarize(results: MutationResult[], enabled: boolean, attempted: boolean, cacheHit: boolean, scope: string[], limitation?: string): MutationSummary {
  return {
    enabled,
    attempted,
    results,
    killed: results.filter((result) => result.status === "killed").length,
    survived: results.filter((result) => result.status === "survived").length,
    timedOut: results.filter((result) => result.status === "timeout").length,
    noCoverage: results.filter((result) => result.status === "no_coverage").length,
    notRun: results.filter((result) => result.status === "not_run").length,
    unknown: results.filter((result) => result.status === "unknown").length,
    cacheHit,
    scope,
    limitation,
  };
}

function validCachedSummary(value: unknown): value is MutationSummary {
  const summary = value as Partial<MutationSummary> | undefined;
  return Boolean(summary && typeof summary === "object" && Array.isArray(summary.results) && typeof summary.enabled === "boolean" && typeof summary.attempted === "boolean" && Array.isArray(summary.scope));
}

function readConfiguredResults(root: string, input: string): { results?: MutationResult[]; error?: string } {
  try {
    const file = resolveRepositoryPath(root, input);
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object" || !("mutantResults" in parsed) && !("mutants" in parsed))) return { error: "Configured mutation result did not contain a recognized result list." };
    return { results: normalizeMutationReport(parsed, Number.MAX_SAFE_INTEGER) };
  } catch (error) {
    return { error: `Configured mutation result could not be parsed safely: ${redactSecrets(error instanceof Error ? error.message : String(error))}` };
  }
}

export function runTargetedMutation(options: MutationOptions): MutationSummary {
  const scope = mutationScope(options.diffs);
  if (!options.config.enabled) return summarize([], false, false, false, scope, "Mutation testing is disabled by configuration.");
  if (!scope.length) return summarize([{ id: "mutation-scope", status: "not_run", reason: "No changed production source files were in scope." }], true, false, false, scope, "No changed production source files were in scope.");
  const unsupportedLanguages = [...new Set(scope.map((file) => languageForFile(file)).filter((language): language is NonNullable<typeof language> => Boolean(language && language !== "typescript" && language !== "javascript")))];
  if (unsupportedLanguages.length && !options.config.command && !process.env.PR_PROOF_MUTATION_RESULTS) {
    const limitation = `No configured mutation adapter is available for ${unsupportedLanguages.join(", ")}; mutation evidence is unknown for this scope.`;
    return summarize([{ id: "mutation-adapter", status: "unknown", reason: limitation }], true, false, false, scope, limitation);
  }
  const key = cacheKey(options, scope);
  let cacheDirectory: string;
  try { cacheDirectory = resolveRepositoryPath(options.root, ".pr-proof/cache"); }
  catch { return summarize([], true, false, false, scope, "Mutation cache path is not safely contained in the repository."); }
  const cacheFile = resolveRepositoryPath(options.root, `.pr-proof/cache/${key}.mutation.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      if (fs.statSync(cacheFile).size > 16 * 1024 * 1024) throw new Error("cache entry exceeds the safety limit");
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as MutationSummary;
      if (validCachedSummary(cached)) return { ...cached, cacheHit: true };
    } catch {
      // Ignore an incomplete cache entry and recompute.
    }
  }

  const supplied = process.env.PR_PROOF_MUTATION_RESULTS;
  let results: MutationResult[] = [];
  let limitation: string | undefined;
  let attempted = false;
  if (supplied) {
    const suppliedResult = readConfiguredResults(options.root, supplied);
    attempted = true;
    if (suppliedResult.results) {
      results = suppliedResult.results.slice(0, options.config.max_mutants);
    } else {
      limitation = suppliedResult.error ?? `Configured mutation result was not found inside the repository: ${supplied}`;
    }
  } else {
    const command = options.config.command ?? (fs.existsSync(path.join(options.root, "node_modules", ".bin", "stryker")) ? "npx stryker run" : undefined);
    if (command) {
      attempted = true;
      let commandArgs: string[] | undefined;
      try { if (!options.allowShellCommands) commandArgs = tokenizeCommand(command); }
      catch (error) {
        limitation = `Mutation command was not executed because it is not a safe executable/argument list: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
        results = [{ id: "mutation-run", status: "unknown", reason: limitation }];
      }
      let result: ReturnType<typeof spawnSync> | undefined;
      try {
        result = results.length ? undefined : commandArgs
          ? spawnSync(commandArgs[0], commandArgs.slice(1), { cwd: options.root, shell: false, encoding: "utf8", timeout: options.config.timeout_seconds * 1000, killSignal: "SIGTERM", maxBuffer: 16 * 1024 * 1024, env: safeChildEnvironment({ PR_PROOF_MUTATION_SCOPE: scope.join(","), PR_PROOF_MUTATION_MAX_MUTANTS: String(options.config.max_mutants), PR_PROOF_MUTATION_TIMEOUT_SECONDS: String(options.config.timeout_seconds) }) })
          : spawnSync(command, { cwd: options.root, shell: true, encoding: "utf8", timeout: options.config.timeout_seconds * 1000, killSignal: "SIGTERM", maxBuffer: 16 * 1024 * 1024, env: safeChildEnvironment({ PR_PROOF_MUTATION_SCOPE: scope.join(","), PR_PROOF_MUTATION_MAX_MUTANTS: String(options.config.max_mutants), PR_PROOF_MUTATION_TIMEOUT_SECONDS: String(options.config.timeout_seconds) }) });
      } catch (error) {
        limitation = `Mutation command could not be started: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
        results = [{ id: "mutation-run", status: "unknown", reason: limitation }];
      }
      if (result) {
        if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") results = [{ id: "mutation-run", status: "timeout", reason: "Mutation command exceeded the configured timeout." }];
        else if (result.status !== 0) {
          limitation = `Mutation command failed with exit code ${String(result.status)}; the rest of the report remains valid.`;
          results = [{ id: "mutation-run", status: "unknown", reason: limitation }];
        }
      }
      const reportFile = path.join(options.root, "reports", "mutation.json");
      if (result?.status === 0 && !results.some((item) => item.status === "timeout") && fs.existsSync(reportFile)) {
        try { results = normalizeMutationReport(JSON.parse(fs.readFileSync(reportFile, "utf8")), options.config.max_mutants); } catch { limitation = "Mutation output was not valid JSON."; }
      }
    } else {
      limitation = "StrykerJS is not installed and no mutation result adapter was supplied.";
      results = [{ id: "mutation-run", status: "unknown", reason: limitation }];
    }
  }
  const summary = summarize(results, true, attempted, false, scope, limitation);
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporary = `${cacheFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, cacheFile);
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* cache is best effort */ }
    }
  } catch {
    // A read-only or concurrently modified cache must not change the verification verdict.
  }
  return summary;
}
