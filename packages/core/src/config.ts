import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { hasShellControl, resolveRepositoryPath } from "./safety";
import type { PrProofConfig } from "./types";

export const DEFAULT_CONFIG: PrProofConfig = {
  version: 1,
  framework: {
    test_runner: "vitest",
    command: "pnpm test --run",
    coverage_file: "coverage/lcov.info",
    test_timeout_seconds: 120,
  },
  languages: {
    mode: "auto",
    include: ["typescript", "javascript", "python", "go", "rust", "c", "cpp"],
    exclude: [],
  },
  base: { ref: "origin/main" },
  test_integrity: {
    mode: "advisory",
    require_new_tests_fail_on_base: false,
    run_base_tests: true,
    mutation_testing: {
      enabled: false,
      max_mutants: 20,
      changed_lines_only: true,
      timeout_seconds: 120,
    },
    ignores: [],
  },
  impact: {
    max_dependency_depth: 2,
    include_tests: true,
    include_public_exports: true,
    include_routes: true,
    fail_on: ["critical_unverified_impact"],
  },
  output: {
    check_run: true,
    sticky_comment: true,
    sarif: true,
    annotations: true,
    fail_on_unknown: false,
  },
  limits: {
    max_changed_files: 500,
    max_changed_lines: 10000,
    max_files_analyzed: 5000,
    max_symbols_analyzed: 50000,
    max_findings: 200,
    analysis_timeout_seconds: 120,
  },
  validation: {
    strict: false,
    allow_shell_commands: false,
    toolchain_checks: true,
  },
  baseline: {
    path: ".pr-proof/baseline.json",
    enabled: true,
    fail_on_new: false,
    waivers: [],
  },
  fixtures: {
    enabled: true,
    max_snapshot_lines: 200,
    approved_paths: [],
    generated_paths: [],
    require_acknowledgement: false,
  },
  selection: {
    confidence_threshold: "medium",
    full_suite_on_unknown: true,
  },
  policy: {
    pack: "default",
  },
};

function merge<T>(base: T, override: Partial<T>): T {
  if (!override || typeof override !== "object") return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const previous = result[key];
    if (value && typeof value === "object" && !Array.isArray(value) && previous && typeof previous === "object" && !Array.isArray(previous)) {
      result[key] = merge(previous, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function findConfig(root: string, explicit?: string): string | undefined {
  if (explicit) return resolveRepositoryPath(root, explicit);
  for (const candidate of [
    ".tinkerbot/config.yml", ".tinkerbot/config.yaml", ".tinkerbot/config.json",
    ".tinkerbot/tinkerbot.yml", ".tinkerbot/tinkerbot.yaml", ".tinkerbot/tinkerbot.json",
    ".pr-proof/config.yml", ".pr-proof/config.yaml", ".pr-proof/config.json",
    "pr-proof.yml", "pr-proof.yaml", "pr-proof.json",
  ]) {
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

export function loadConfig(root: string, explicit?: string): PrProofConfig {
  const file = findConfig(root, explicit);
  if (explicit && (!file || !fs.existsSync(file))) throw new Error(`Configuration file not found: ${path.resolve(root, explicit)}`);
  if (!file || !fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const raw = fs.readFileSync(file, "utf8");
  const parsedUnknown = path.extname(file) === ".json" ? JSON.parse(raw) : parseYaml(raw);
  if (parsedUnknown !== null && !isRecord(parsedUnknown)) throw new Error("Configuration root must be an object");
  const parsed = parsedUnknown as Partial<PrProofConfig> | null;
  const config = merge(structuredClone(DEFAULT_CONFIG), parsed ?? {});
  if (config.validation?.strict) validateUnknownKeys(parsed ?? {});
  validateConfig(config);
  return config;
}

const KNOWN_TOP_LEVEL_KEYS = new Set(["version", "framework", "languages", "base", "test_integrity", "impact", "output", "limits", "validation", "baseline", "fixtures", "selection", "policy"]);
const KNOWN_SECTION_KEYS: Record<string, Set<string>> = {
  framework: new Set(["test_runner", "command", "coverage_file", "test_timeout_seconds"]),
  languages: new Set(["mode", "include", "exclude"]),
  base: new Set(["ref"]),
  test_integrity: new Set(["mode", "require_new_tests_fail_on_base", "run_base_tests", "mutation_testing", "ignores"]),
  impact: new Set(["max_dependency_depth", "include_tests", "include_public_exports", "include_routes", "fail_on"]),
  output: new Set(["check_run", "sticky_comment", "sarif", "annotations", "fail_on_unknown"]),
  limits: new Set(["max_changed_files", "max_changed_lines", "max_files_analyzed", "max_symbols_analyzed", "max_findings", "analysis_timeout_seconds"]),
  validation: new Set(["strict", "allow_shell_commands", "toolchain_checks"]),
  baseline: new Set(["path", "enabled", "fail_on_new", "waivers"]),
  fixtures: new Set(["enabled", "max_snapshot_lines", "approved_paths", "generated_paths", "require_acknowledgement"]),
  selection: new Set(["confidence_threshold", "full_suite_on_unknown"]),
  policy: new Set(["pack"]),
};
const KNOWN_NESTED_KEYS: Record<string, Set<string>> = {
  "test_integrity.mutation_testing": new Set(["enabled", "max_mutants", "changed_lines_only", "timeout_seconds", "command"]),
};
const KNOWN_IGNORE_KEYS = new Set(["rule", "path", "reason"]);
const KNOWN_WAIVER_KEYS = new Set(["ruleId", "fingerprint", "path", "reason", "owner", "createdAt", "expiresAt", "issue"]);

function validateUnknownKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (!KNOWN_TOP_LEVEL_KEYS.has(key)) throw new Error(`Unknown configuration key: ${key}`);
  for (const [section, allowed] of Object.entries(KNOWN_SECTION_KEYS)) {
    const sectionValue = value[section];
    if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) continue;
    for (const key of Object.keys(sectionValue as Record<string, unknown>)) if (!allowed.has(key)) throw new Error(`Unknown configuration key: ${section}.${key}`);
  }
  const mutation = (value.test_integrity as Record<string, unknown> | undefined)?.mutation_testing;
  if (mutation && typeof mutation === "object" && !Array.isArray(mutation)) {
    for (const key of Object.keys(mutation as Record<string, unknown>)) if (!KNOWN_NESTED_KEYS["test_integrity.mutation_testing"].has(key)) throw new Error(`Unknown configuration key: test_integrity.mutation_testing.${key}`);
  }
  const ignores = (value.test_integrity as Record<string, unknown> | undefined)?.ignores;
  if (Array.isArray(ignores)) {
    for (const [index, ignore] of ignores.entries()) {
      if (!ignore || typeof ignore !== "object" || Array.isArray(ignore)) continue;
      for (const key of Object.keys(ignore as Record<string, unknown>)) if (!KNOWN_IGNORE_KEYS.has(key)) throw new Error(`Unknown configuration key: test_integrity.ignores[${index}].${key}`);
    }
  }
  const waivers = (value.baseline as Record<string, unknown> | undefined)?.waivers;
  if (Array.isArray(waivers)) {
    for (const [index, waiver] of waivers.entries()) {
      if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) continue;
      for (const key of Object.keys(waiver as Record<string, unknown>)) if (!KNOWN_WAIVER_KEYS.has(key)) throw new Error(`Unknown configuration key: baseline.waivers[${index}].${key}`);
    }
  }
}

function hasUnsafeShellSyntax(command: string): boolean {
  return /(?:^|\s)(?:rm|sudo|curl|wget|git\s+reset\s+--hard)(?:\s|$)/.test(command) || hasShellControl(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

function requireRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
}

function requireBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function requireNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

export function validateConfig(config: PrProofConfig): void {
  requireRecord(config, "configuration");
  requireNumber(config.version, "version");
  requireRecord(config.framework, "framework");
  requireRecord(config.languages, "languages");
  requireRecord(config.base, "base");
  requireRecord(config.test_integrity, "test_integrity");
  requireRecord(config.test_integrity.mutation_testing, "test_integrity.mutation_testing");
  requireRecord(config.impact, "impact");
  requireRecord(config.output, "output");
  requireRecord(config.limits, "limits");
  requireRecord(config.validation, "validation");
  requireRecord(config.baseline, "baseline");
  requireRecord(config.fixtures, "fixtures");
  requireRecord(config.selection, "selection");
  requireRecord(config.policy, "policy");
  const allowShellCommands = config.validation?.allow_shell_commands === true;
  if (config.version !== 1) throw new Error(`Unsupported pr-proof configuration version: ${String(config.version)}`);
  if (!["auto", "explicit"].includes(config.languages.mode)) throw new Error("languages.mode must be auto or explicit");
  const validLanguages = new Set(["typescript", "javascript", "python", "go", "rust", "c", "cpp"]);
  for (const [name, values] of [["languages.include", config.languages.include], ["languages.exclude", config.languages.exclude]] as const) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !validLanguages.has(value))) throw new Error(`${name} must contain supported language identifiers`);
  }
  if (new Set(config.languages.include).size !== config.languages.include.length || new Set(config.languages.exclude).size !== config.languages.exclude.length) throw new Error("languages.include and languages.exclude must not contain duplicates");
  if (!config.framework.command || typeof config.framework.command !== "string") throw new Error("framework.command must be a string");
  if (typeof config.framework.test_runner !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(config.framework.test_runner)) throw new Error(`Unsupported test runner: ${config.framework.test_runner}`);
  if (!config.base.ref || typeof config.base.ref !== "string" || !config.base.ref.trim()) throw new Error("base.ref must be a non-empty string");
  if (config.framework.coverage_file !== undefined && !isSafeRelativePath(config.framework.coverage_file)) throw new Error("framework.coverage_file must be a repository-relative path");
  requireNumber(config.framework.test_timeout_seconds, "framework.test_timeout_seconds");
  if (config.framework.test_timeout_seconds <= 0 || config.framework.test_timeout_seconds > 3600) throw new Error("framework.test_timeout_seconds must be between 1 and 3600 seconds");
  requireBoolean(config.validation.strict, "validation.strict");
  requireBoolean(config.validation.allow_shell_commands, "validation.allow_shell_commands");
  requireBoolean(config.validation.toolchain_checks, "validation.toolchain_checks");
  if (!allowShellCommands && hasUnsafeShellSyntax(config.framework.command)) throw new Error("framework.command contains unsafe shell syntax; set validation.allow_shell_commands: true only after review");
  if (!["advisory", "blocking"].includes(config.test_integrity.mode)) throw new Error("test_integrity.mode must be advisory or blocking");
  requireBoolean(config.test_integrity.require_new_tests_fail_on_base, "test_integrity.require_new_tests_fail_on_base");
  requireBoolean(config.test_integrity.run_base_tests, "test_integrity.run_base_tests");
  if (!Number.isFinite(config.impact.max_dependency_depth) || config.impact.max_dependency_depth < 0 || config.impact.max_dependency_depth > 10) {
    throw new Error("impact.max_dependency_depth must be between 0 and 10");
  }
  requireBoolean(config.impact.include_tests, "impact.include_tests");
  requireBoolean(config.impact.include_public_exports, "impact.include_public_exports");
  requireBoolean(config.impact.include_routes, "impact.include_routes");
  if (!Array.isArray(config.impact.fail_on) || config.impact.fail_on.some((item) => typeof item !== "string" || !item.trim())) throw new Error("impact.fail_on must be an array of rule names");
  if (!Array.isArray(config.test_integrity.ignores)) throw new Error("test_integrity.ignores must be an array");
  if (config.test_integrity.mutation_testing.command !== undefined && typeof config.test_integrity.mutation_testing.command !== "string") throw new Error("test_integrity.mutation_testing.command must be a string");
  if (config.test_integrity.mutation_testing.command && !allowShellCommands && hasUnsafeShellSyntax(config.test_integrity.mutation_testing.command)) throw new Error("test_integrity.mutation_testing.command contains unsafe shell syntax; set validation.allow_shell_commands: true only after review");
  requireBoolean(config.test_integrity.mutation_testing.enabled, "test_integrity.mutation_testing.enabled");
  requireBoolean(config.test_integrity.mutation_testing.changed_lines_only, "test_integrity.mutation_testing.changed_lines_only");
  requireNumber(config.test_integrity.mutation_testing.max_mutants, "test_integrity.mutation_testing.max_mutants");
  requireNumber(config.test_integrity.mutation_testing.timeout_seconds, "test_integrity.mutation_testing.timeout_seconds");
  if (config.test_integrity.mutation_testing.max_mutants < 0 || config.test_integrity.mutation_testing.max_mutants > 1000 || config.test_integrity.mutation_testing.timeout_seconds <= 0 || config.test_integrity.mutation_testing.timeout_seconds > 900) {
    throw new Error("mutation limits must be positive and within safe maximums");
  }
  for (const [name, value] of Object.entries(config.limits)) requireNumber(value, `limits.${name}`);
  if (config.limits.max_changed_files <= 0 || config.limits.max_changed_files > 100_000 || config.limits.max_changed_lines <= 0 || config.limits.max_changed_lines > 10_000_000 || config.limits.max_files_analyzed <= 0 || config.limits.max_files_analyzed > 100_000 || config.limits.max_symbols_analyzed <= 0 || config.limits.max_symbols_analyzed > 1_000_000 || config.limits.max_findings <= 0 || config.limits.max_findings > 10_000 || config.limits.analysis_timeout_seconds <= 0 || config.limits.analysis_timeout_seconds > 3600) throw new Error("analysis limits must be positive and within safe maximums");
  for (const [name, value] of Object.entries(config.output)) requireBoolean(value, `output.${name}`);
  for (const ignore of config.test_integrity.ignores) if (!ignore.rule || !ignore.reason) throw new Error("test_integrity.ignores entries require rule and reason");
  if (typeof config.baseline.enabled !== "boolean" || typeof config.baseline.fail_on_new !== "boolean") throw new Error("baseline.enabled and baseline.fail_on_new must be booleans");
  if (!isSafeRelativePath(config.baseline.path)) throw new Error("baseline.path must be a repository-relative path");
  if (!Array.isArray(config.baseline.waivers)) throw new Error("baseline.waivers must be an array");
  if (typeof config.fixtures.enabled !== "boolean" || typeof config.fixtures.require_acknowledgement !== "boolean") throw new Error("fixtures.enabled and fixtures.require_acknowledgement must be booleans");
  if (!Number.isInteger(config.fixtures.max_snapshot_lines) || config.fixtures.max_snapshot_lines <= 0 || config.fixtures.max_snapshot_lines > 1_000_000) throw new Error("fixtures.max_snapshot_lines must be a positive integer within the safe maximum");
  if (!Array.isArray(config.fixtures.approved_paths) || !Array.isArray(config.fixtures.generated_paths) || [...config.fixtures.approved_paths, ...config.fixtures.generated_paths].some((value) => !isSafeRelativePath(value))) throw new Error("fixtures paths must be repository-relative arrays");
  if (!config.selection || typeof config.selection.full_suite_on_unknown !== "boolean") throw new Error("selection.full_suite_on_unknown must be a boolean");
  if (!("low medium high".split(" ") as string[]).includes(config.selection.confidence_threshold)) throw new Error("selection.confidence_threshold must be low, medium, or high");
  if (!config.policy.pack || typeof config.policy.pack !== "string") throw new Error("policy.pack must be a non-empty string");
  if (!(new Set(["default", "strict", "public-api", "security-sensitive", "database-change", "agent-authored-change", "monorepo"])).has(config.policy.pack)) throw new Error(`Unknown policy pack: ${config.policy.pack}`);
  for (const waiver of config.baseline.waivers) {
    if (!waiver.ruleId || !waiver.reason || !waiver.owner || !waiver.createdAt) throw new Error("baseline.waivers entries require ruleId, reason, owner, and createdAt");
    if (waiver.ruleId === "*") throw new Error("baseline waivers cannot use a blanket ruleId of *");
    if (waiver.path && !isSafeRelativePath(waiver.path)) throw new Error("baseline waiver paths must be repository-relative");
    if (!Number.isFinite(Date.parse(String(waiver.createdAt))) || (waiver.expiresAt && !Number.isFinite(Date.parse(String(waiver.expiresAt))))) throw new Error("baseline waiver dates must be valid ISO-compatible dates");
    if (waiver.expiresAt && Date.parse(String(waiver.expiresAt)) < Date.parse(String(waiver.createdAt))) throw new Error("baseline waiver expiry cannot precede createdAt");
  }
  const waiverKeys = new Set<string>();
  for (const waiver of config.baseline.waivers) {
    const key = JSON.stringify(waiver);
    if (waiverKeys.has(key)) throw new Error("baseline.waivers cannot contain duplicate entries");
    waiverKeys.add(key);
  }
}
