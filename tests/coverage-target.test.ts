import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../packages/core/src";
import {
  calculateChangedLineCoverage,
  parseCoveragePyJson,
  parseGcov,
  parseGoCoverprofile,
  parseIstanbulJson,
  parseLcov,
  parseLlvmCovJson,
  readCoverage,
  readCoverageAtRevision,
} from "../packages/coverage/src";
import type { CoverageReport, FileDiff, ImpactReport, PrProofConfig, PrProofReport } from "../packages/core/src";
import { parseUnifiedDiff } from "../packages/git/src";
import { analyzeNonVacuity, analyzeTestDiffs, analyzeTestIntegrity } from "../packages/test-integrity/src";
import { analyzeImpact } from "../packages/impact-analysis/src";
import { createControlPlaneServer, resolveControlPlaneDirectory, runControlPlaneServer, safeControlPlaneFilePath } from "../packages/cli/src/serve";
import { parseArtifact } from "../packages/artifacts/src";
import { renderMarkdown, renderReport, renderSarif, renderTerminal } from "../packages/reporters/src";
import { buildProvenance } from "../packages/provenance/src";
import { analyzeFixtures } from "../packages/fixtures/src";
import { buildGraph, parseSource } from "../packages/parser/src";
import { normalizeMutationReport, runTargetedMutation } from "../packages/mutation/src";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repository(): { root: string; revision: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-coverage-target-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "coverage@example.com"]);
  git(root, ["config", "user.name", "Coverage Target"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/service.ts"), "import { value } from './value';\n// comment\nexport function authorize() {\n  if (!value) throw new Error('unauthorized');\n  return true;\n}\n");
  fs.writeFileSync(path.join(root, "src/value.ts"), "export const value = true;\n");
  fs.writeFileSync(path.join(root, "coverage/lcov.info"), "SF:src/service.ts\nDA:3,1\nDA:4,0\nDA:5,1\nend_of_record\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return { root, revision: git(root, ["rev-parse", "HEAD"]) };
}

function changed(pathname: string, lines: number[]): FileDiff {
  return { path: pathname, status: "modified", additions: lines.length, deletions: 0, changedLines: lines, deletedLines: [], hunks: [], patch: "" };
}

test("coverage parsers preserve valid evidence while diagnosing malformed and unsafe records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-parser-target-"));
  fs.mkdirSync(path.join(root, "src"));
  const lcov = parseLcov([
    "SF:src/a.ts",
    "DA:1,2",
    "DA:bad,1",
    "FNDA:2,run",
    "FNDA:bad,",
    "BRDA:1,0,0,2",
    "BRDA:1,0,1,bad",
    "end_of_record",
    "SF:C:\\outside.ts",
  ].join("\n"), root);
  expect(lcov.files["src/a.ts"]?.functions?.run).toBe(2);
  expect(lcov.unknowns).toHaveLength(4);

  const istanbul = parseIstanbulJson(JSON.stringify({
    invalid: [],
    [path.join(root, "src/a.ts")]: {
      statementMap: { 0: { start: { line: 1 }, end: { line: 2 } }, bad: { start: { line: 0 } } },
      s: { 0: 3, bad: -1 },
      f: { ok: 1, bad: -1 },
      b: { ok: [3, 2], bad: "nope" },
    },
    [path.join(root, "src/b.ts")]: { statementMap: [], s: [], f: [], b: [] },
  }), root);
  expect(istanbul.files["src/a.ts"]?.lines[2]).toBe(3);
  expect(istanbul.files["src/a.ts"]?.branches?.ok).toBe(2);
  expect((istanbul.unknowns ?? []).length).toBeGreaterThanOrEqual(5);

  expect(parseGoCoverprofile("mode: set\n../outside.go:1.1,2.1 1 1\nsrc/a.go:2.1,1.1 1 1", root).unknowns).toHaveLength(2);
  expect(parseGcov("        -:    0:Source:../outside.c\n        1:    1:int main(){}", root).unknowns).toHaveLength(1);
  expect(parseCoveragePyJson(JSON.stringify({ files: { "../outside.py": { executed_lines: [1] }, "src/a.py": { executed_lines: [], missing_lines: [] } } }), root).unknowns).toHaveLength(2);
  expect((parseLlvmCovJson(JSON.stringify({ data: [{ files: [{ segments: [] }, { filename: "../outside.c", segments: [] }] }] }), root).unknowns ?? []).length).toBeGreaterThanOrEqual(2);
  const artifact = parseArtifact(JSON.stringify({ "src/a.ts": { s: { 0: 1, 1: 0 } }, invalid: null }), "coverage-final.json", "istanbul");
  expect(artifact.metrics.files).toBe(2);
  expect(artifact.records[0]?.coveredStatements).toBe(1);
});

test("coverage discovery recognizes committed formats and handles absent, unsafe, and unreadable artifacts", () => {
  const fixture = repository();
  expect(readCoverage(fixture.root).format).toBe("lcov");
  expect(readCoverageAtRevision(fixture.root, fixture.revision).available).toBe(true);
  expect(readCoverageAtRevision(fixture.root, "missing-revision").unknowns?.[0]).toMatch(/could not be resolved/);
  expect(readCoverage(fixture.root, "../outside.info").available).toBe(false);
  fs.mkdirSync(path.join(fixture.root, "coverage/directory.info"));
  expect(readCoverage(fixture.root, "coverage/directory.info").unknowns?.[0]).toMatch(/could not be read/);

  const formats = [
    ["custom.dat", "mode: set\nsrc/value.go:1.1,1.2 1 1", "go-coverprofile"],
    ["custom.gcov", "        -:    0:Source:src/value.c\n        1:    1:int value;", "gcov"],
    ["python.json", JSON.stringify({ files: { "src/value.py": { executed_lines: [1], missing_lines: [] } } }), "coverage.py"],
    ["llvm.json", JSON.stringify({ data: [{ files: [{ filename: "src/value.c", segments: [[1, 1, 1]] }] }] }), "llvm-cov"],
    ["istanbul.json", JSON.stringify({ "src/value.ts": { statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } }, s: { 0: 1 } } }), "istanbul"],
    ["bad.dat", "not coverage", "unknown"],
  ] as const;
  for (const [name, contents, expected] of formats) {
    fs.writeFileSync(path.join(fixture.root, name), contents);
    expect(readCoverage(fixture.root, name).format).toBe(expected);
  }
});

test("changed-line coverage ignores non-executable inputs and reports high-risk gaps", () => {
  const fixture = repository();
  fs.mkdirSync(path.join(fixture.root, "src/directory.ts"));
  const evidence: CoverageReport = {
    format: "lcov",
    available: true,
    files: { "src/service.ts": { file: "src/service.ts", lines: { 3: 1, 4: 0, 5: 1 } } },
    unknowns: [],
  };
  const result = calculateChangedLineCoverage(fixture.root, [
    changed("src/service.ts", [1, 2, 3, 4, 5, 99]),
    changed("src/service.test.ts", [1]),
    changed("README.md", [1]),
    changed("missing.ts", [1]),
    changed("../outside.ts", [1]),
    changed("src/directory.ts", [1]),
  ], evidence, new Set(["src/service.ts"]));
  expect(result.changedExecutableLines).toBe(3);
  expect(result.changedLinesCovered).toBe(2);
  expect(result.changedLinesCoveredByModifiedTests).toBe(2);
  expect(result.highRiskUncovered).toEqual(["src/service.ts:4"]);
});

function invalid(mutator: (config: PrProofConfig) => void, message: RegExp): void {
  const config = structuredClone(DEFAULT_CONFIG);
  mutator(config);
  expect(() => validateConfig(config)).toThrow(message);
}

test("strict configuration validation rejects unknown nested keys and unsafe waiver variants", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-config-target-"));
  const configFile = path.join(root, "pr-proof.yml");
  for (const yaml of [
    "validation:\n  strict: true\nframework:\n  unknown: true\n",
    "validation:\n  strict: true\ntest_integrity:\n  mutation_testing:\n    unknown: true\n",
    "validation:\n  strict: true\ntest_integrity:\n  ignores:\n    - rule: x\n      reason: y\n      unknown: true\n",
    "validation:\n  strict: true\nbaseline:\n  waivers:\n    - ruleId: x\n      reason: y\n      owner: z\n      createdAt: 2026-01-01\n      unknown: true\n",
  ]) {
    fs.writeFileSync(configFile, yaml);
    expect(() => loadConfig(root)).toThrow(/Unknown configuration key/);
  }

  invalid((config) => { config.impact.max_dependency_depth = 11; }, /max_dependency_depth/);
  invalid((config) => { config.test_integrity.mutation_testing.max_mutants = 1001; }, /mutation limits/);
  invalid((config) => { config.baseline.waivers = [{ ruleId: "x", reason: "why", owner: "me", createdAt: "invalid" }]; }, /dates must be valid/);
  invalid((config) => { config.baseline.waivers = [{ ruleId: "*", reason: "why", owner: "me", createdAt: "2026-01-01" }]; }, /blanket ruleId/);
  invalid((config) => { config.baseline.waivers = [{ ruleId: "x", path: "../outside", reason: "why", owner: "me", createdAt: "2026-01-01" }]; }, /paths must be repository-relative/);
  invalid((config) => { config.baseline.waivers = [{ ruleId: "x", reason: "why", owner: "me", createdAt: "2026-02-01", expiresAt: "2026-01-01" }]; }, /expiry cannot precede/);
  invalid((config) => {
    const waiver = { ruleId: "x", reason: "why", owner: "me", createdAt: "2026-01-01" };
    config.baseline.waivers = [waiver, { ...waiver }];
  }, /duplicate entries/);

  expect(() => validateConfig(null as never)).toThrow(/configuration must be an object/);
  invalid((config) => { config.version = 2; }, /Unsupported/);
  invalid((config) => { config.languages.mode = "invalid" as never; }, /languages.mode/);
  invalid((config) => { config.languages.include = ["java" as never]; }, /supported language/);
  invalid((config) => { config.languages.include = ["go", "go"]; }, /duplicates/);
  invalid((config) => { config.framework.command = ""; }, /framework.command/);
  invalid((config) => { config.framework.test_runner = "bad runner"; }, /Unsupported test runner/);
  invalid((config) => { config.base.ref = ""; }, /base.ref/);
  invalid((config) => { config.framework.coverage_file = "../outside"; }, /coverage_file/);
  invalid((config) => { config.framework.test_timeout_seconds = 0; }, /test_timeout_seconds/);
  invalid((config) => { config.validation.strict = "yes" as never; }, /validation.strict/);
  invalid((config) => { config.framework.command = "rm everything"; }, /unsafe shell syntax/);
  invalid((config) => { config.test_integrity.mode = "invalid" as never; }, /test_integrity.mode/);
  invalid((config) => { config.test_integrity.require_new_tests_fail_on_base = "yes" as never; }, /require_new_tests_fail_on_base/);
  invalid((config) => { config.impact.fail_on = [""]; }, /impact.fail_on/);
  invalid((config) => { config.test_integrity.ignores = {} as never; }, /ignores must be an array/);
  invalid((config) => { config.test_integrity.mutation_testing.command = 1 as never; }, /mutation_testing.command/);
  invalid((config) => { config.test_integrity.mutation_testing.enabled = "yes" as never; }, /mutation_testing.enabled/);
  invalid((config) => { config.limits.max_changed_files = 0; }, /analysis limits/);
  invalid((config) => { config.output.check_run = "yes" as never; }, /output.check_run/);
  invalid((config) => { config.baseline.enabled = "yes" as never; }, /baseline.enabled/);
  invalid((config) => { config.baseline.path = "../baseline"; }, /baseline.path/);
  invalid((config) => { config.baseline.waivers = {} as never; }, /waivers must be an array/);
  invalid((config) => { config.fixtures.enabled = "yes" as never; }, /fixtures.enabled/);
  invalid((config) => { config.fixtures.max_snapshot_lines = 0; }, /max_snapshot_lines/);
  invalid((config) => { config.fixtures.approved_paths = ["../outside"]; }, /fixtures paths/);
  invalid((config) => { config.selection.full_suite_on_unknown = "yes" as never; }, /full_suite_on_unknown/);
  invalid((config) => { config.selection.confidence_threshold = "certain" as never; }, /confidence_threshold/);
  invalid((config) => { config.policy.pack = ""; }, /policy.pack/);
  invalid((config) => { config.policy.pack = "unknown"; }, /Unknown policy pack/);
  invalid((config) => { config.baseline.waivers = [{ ruleId: "x" } as never]; }, /entries require/);
});

test("reporters cover absent evidence, null percentages, repository findings, and fallback assurance formats", () => {
  const finding = { id: "repository", ruleId: "system.unknown", category: "system", severity: "info", message: "Unknown", explanation: "No evidence", suggestedAction: "Inspect", confidence: "low", resolution: "unknown", file: "repository" };
  const report = {
    schemaVersion: 1,
    schemaId: "https://pr-proof.dev/schemas/report/v1",
    toolVersion: "0.1.0",
    repository: "local",
    base: "base",
    head: "head",
    verdict: "UNKNOWN",
    summary: {},
    findings: [finding],
    limitations: [],
    testIntegrity: { findings: [], newTests: 0, modifiedTests: 0, deletedTests: 0, testsPassingOnBase: 0, coverage: { available: false, percentage: null, coverageDelta: null, changedLinesCoveredByModifiedTests: 0 }, unknowns: [] },
  } as unknown as PrProofReport;
  expect(renderTerminal(report)).toContain("Coverage: unavailable");
  expect(renderMarkdown(report)).toContain("unknown");
  expect(renderSarif(report)).not.toContain("physicalLocation");
  expect(renderReport(report, "receipt")).toContain('"status": "unknown"');
  expect(renderReport(report, "change-assurance")).toContain("assurance-bundle");
  expect(renderReport(report, "release-manifest")).toContain("release-manifest");
  const absent = { ...report, testIntegrity: undefined, impact: undefined, findings: [] };
  expect(renderTerminal(absent)).toContain("Not run");
  expect(renderMarkdown(absent)).toContain("No findings");
});

test("provenance identifies language-native test names and every evidence relationship", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-provenance-target-"));
  const files: Record<string, string> = {
    "tests/test_api.py": "async def test_python():\n    pass\n",
    "pkg/api_test.go": "func TestGo(t *testing.T) {}\n",
    "tests/api_test.rs": "fn test_rust() {}\n",
    "tests/api_test.cpp": "TEST(Api, Works) {}\n",
    "tests/api.test.ts": "it('typescript case', () => {});\n",
  };
  for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); }
  const pathFor = (id: string, testFile: string, overrides: Record<string, unknown> = {}) => ({ id, sourceFile: `src/${id}.ts`, sourceSymbol: "run", file: `src/${id}.ts`, symbol: "run", classification: "direct", reason: id, testFiles: [testFile], verified: false, verificationState: "partially_verified", modifiedByPr: true, ...overrides });
  const impact = { paths: [
    pathFor("python", "tests/test_api.py", { coverageLines: [1], verified: true, verificationState: "verified" }),
    pathFor("go", "pkg/api_test.go", { classification: "downstream", sourceSymbol: undefined }),
    pathFor("rust", "tests/api_test.rs", { classification: "cross_package" }),
    pathFor("cpp", "tests/api_test.cpp", { classification: "runtime_unknown", verificationState: "unknown" }),
    pathFor("ts", "tests/api.test.ts", { classification: "generated", sourceSymbol: undefined }),
  ] } as unknown as ImpactReport;
  const records = buildProvenance(root, impact.paths.map((item) => changed(item.sourceFile, [1])), impact);
  expect(records.map((item) => item.testName)).toEqual(expect.arrayContaining(["test_python", "TestGo", "test_rust", "Api", "typescript case"]));
  expect(records.map((item) => item.provenanceMethod)).toEqual(expect.arrayContaining(["runtime_coverage", "import_graph", "unresolved", "file_proximity"]));
});

test("fixture analysis covers disabled, approved, deleted, churned, renamed, and weakened evidence", () => {
  const config = structuredClone(DEFAULT_CONFIG.fixtures);
  config.max_snapshot_lines = 1;
  config.require_acknowledgement = true;
  config.approved_paths = ["approved/**"];
  expect(analyzeFixtures([], { ...config, enabled: false }).unknowns[0]).toMatch(/disabled/);
  const hunk = { oldStart: 1, oldCount: 2, newStart: 1, newCount: 1, header: "@@ -1,2 +1 @@", lines: ["-throw unauthorized", "-expect(value).toEqual({ ok: false })", "+expect(value).toBeTruthy()"] };
  const diffs: FileDiff[] = [
    { ...changed("tests/__snapshots__/api.snap", [1]), status: "deleted", deletions: 3, additions: 0, hunks: [hunk], patch: hunk.lines.join("\n") },
    { ...changed("fixtures/errors.json", [1]), status: "deleted", deletions: 2, hunks: [hunk], patch: hunk.lines.join("\n") },
    { ...changed("fixtures/renamed.json", [1]), status: "renamed", oldPath: "fixtures/old.json", hunks: [], patch: "" },
  ];
  const result = analyzeFixtures(diffs, config);
  expect(result.findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining(["fixture.snapshot-deleted", "fixture.snapshot-churn", "fixture.snapshot-unexplained", "fixture.acknowledgement-missing", "fixture.record-deleted", "fixture.expected-error-removed", "fixture.less-specific"]));
  expect(result.unknowns.join(" ")).toMatch(/Renamed fixture|Snapshot changes/);
  expect(analyzeFixtures([{ ...changed("approved/fixture.json", [1]), hunks: [hunk], patch: hunk.lines.join("\n") }], config).findings).toHaveLength(0);
});

test("parser adapters cover aliases, declarations, dynamic imports, directives, macros, and bounded validation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-parser-branches-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"], exact: ["src/value.ts"] } } }));
  fs.writeFileSync(path.join(root, "src/value.ts"), "export const value = 1;\n");
  const tsModule = parseSource("src/main.ts", [
    "import value, * as ns from '@lib/value';",
    "import { missing as alias } from './missing';",
    "export { alias };",
    "export * from './missing-export';",
    "export default class Service { constructor() {} method() { return value; } }",
    "interface Shape { value: number }",
    "type Alias = Shape; enum Kind { A } namespace Space {}",
    "const arrow = () => import('./dynamic-missing');",
    "const unknown = import(name);",
    "app.options('/health', arrow);",
  ].join("\n"), root);
  expect(tsModule.symbols.map((item) => item.kind)).toEqual(expect.arrayContaining(["class", "method", "interface", "type", "enum", "namespace", "function"]));
  expect(tsModule.unknowns.length).toBeGreaterThan(2);
  expect(tsModule.dynamicReferences).not.toHaveLength(0);

  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/project\n");
  fs.mkdirSync(path.join(root, "pkg"));
  fs.writeFileSync(path.join(root, "pkg/value.go"), "package pkg\nfunc Value() {}\n");
  const go = parseSource("main.go", "package main\nimport (\n alias \"example.com/project/pkg\"\n)\n//go:generate tool\nfunc Main() { alias.Value() }\n", root);
  expect(go.imports[0]?.resolvedFile).toBe("pkg/value.go");
  expect(go.unknowns[0]).toMatch(/directive/);
  fs.mkdirSync(path.join(root, "src/inner"));
  fs.writeFileSync(path.join(root, "src/inner/mod.rs"), "pub fn value() {}\n");
  const rust = parseSource("src/lib.rs", "pub mod inner;\nuse crate::inner::value;\nmacro_rules! generated { () => {} }\n#[derive(Debug)]\npub struct Item;\n", root);
  expect(rust.symbols.some((item) => item.kind === "macro")).toBe(true);
  expect(rust.dynamicReferences.length).toBeGreaterThan(1);

  const graph = buildGraph(root, ["../outside.ts", "main.go"], undefined, { validateSyntax: true, maxValidatedFiles: 0 });
  expect(graph.unknowns.join(" ")).toMatch(/could not be read|capped/);
});

test("mutation normalization and execution cover alternate report shapes, statuses, shell mode, and missing adapters", () => {
  const entries = [
    { status: "Killed", fileName: "src/a.ts", location: { start: { line: 1 } }, mutatorName: "Boolean", statusReason: "done" },
    { id: "s", status: "Survived", file: "src/b.ts", range: { line: 2 }, mutator: "Math", reason: "alive" },
    { id: "t", status: "Timeout" }, { id: "n", status: "NoCoverage" }, { id: "r", status: "NotRun" }, { id: "u", status: null },
  ];
  expect(normalizeMutationReport({ mutantResults: entries }, 10).map((item) => item.status)).toEqual(expect.arrayContaining(["killed", "survived", "timeout", "no_coverage", "not_run", "unknown"]));
  expect(normalizeMutationReport({ mutants: entries }, 1)).toHaveLength(1);
  expect(normalizeMutationReport(null, 10)).toHaveLength(0);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-mutation-branches-"));
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const source = changed("src/value.ts", [1]);
  const config = { enabled: true, max_mutants: 5, changed_lines_only: true, timeout_seconds: 1 };
  expect(runTargetedMutation({ root, diffs: [source], config, base: "base", head: "head" }).limitation).toMatch(/not installed/);
  process.env.PR_PROOF_MUTATION_RESULTS = "missing.json";
  expect(runTargetedMutation({ root, diffs: [source], config, base: "base-2", head: "head" }).limitation).toMatch(/not found/);
  delete process.env.PR_PROOF_MUTATION_RESULTS;
  const failed = runTargetedMutation({ root, diffs: [source], config: { ...config, command: "node -e \"process.exit(2)\"" }, base: "base-3", head: "head", allowShellCommands: true });
  expect(failed.limitation).toMatch(/exit code 2/);
});

test("control-plane serving covers content types, SPA fallback, malformed paths, and startup", () => {
  expect(resolveControlPlaneDirectory()).toBe(path.resolve("apps/control-plane"));
  expect(() => resolveControlPlaneDirectory(path.join(os.tmpdir(), "missing-control-plane"))).toThrow(/Could not locate/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-control-plane-target-"));
  for (const [name, contents] of [["index.html", "index"], ["app.js", "js"], ["style.css", "css"], ["data.json", "{}"], ["icon.svg", "svg"], ["blob.bin", "bin"]]) fs.writeFileSync(path.join(root, name), contents);
  expect(safeControlPlaneFilePath(root, "/%00")).toBeNull();
  const server = createControlPlaneServer({ directory: root, port: 0 });
  const responses: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [];
  const response = {
    writeHead(status: number, headers?: Record<string, string>) { responses.push({ status, headers }); return this; },
    end(body?: string) { responses.at(-1)!.body = body; return this; },
    destroy() { return this; },
  };
  const stream = { on: vi.fn(), pipe: vi.fn() };
  stream.on.mockReturnValue(stream);
  const streamSpy = vi.spyOn(fs, "createReadStream").mockReturnValue(stream as unknown as fs.ReadStream);
  for (const url of ["/", "/app/overview", "/app.js", "/style.css", "/data.json", "/icon.svg", "/blob.bin"]) server.emit("request", { method: "GET", url }, response);
  server.emit("request", { method: "GET", url: "/%00" }, response);
  expect(responses.filter((item) => item.status === 200)).toHaveLength(7);
  expect(responses.map((item) => item.headers?.["content-type"])).toEqual(expect.arrayContaining(["text/html; charset=utf-8", "text/css; charset=utf-8", "text/javascript; charset=utf-8", "application/json; charset=utf-8", "image/svg+xml", "application/octet-stream"]));
  expect(responses.at(-1)?.status).toBe(400);
  streamSpy.mockRestore();
  server.close();

  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const listen = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server, ...args: unknown[]) {
    const callback = args.find((value) => typeof value === "function") as (() => void) | undefined;
    callback?.();
    return this;
  } as typeof http.Server.prototype.listen);
  expect(runControlPlaneServer({ directory: root, host: "127.0.0.1", port: 0 })).toBe(0);
  expect(stdout).toHaveBeenCalled();
  listen.mockRestore();
  stdout.mockRestore();
});

test("test integrity records tolerance erosion, exclusions, meaningful tests, and base coverage deltas", () => {
  const diff = parseUnifiedDiff([
    "diff --git a/tests/service.test.ts b/tests/service.test.ts",
    "--- a/tests/service.test.ts",
    "+++ b/tests/service.test.ts",
    "@@ -1,3 +1,4 @@",
    "-expect(value).toBeCloseTo(1, 5);",
    "-const options = { timeout: 10 };",
    "+expect(value).toBeCloseTo(1, 2);",
    "+const options = { timeout: 100 };",
    "+/* c8 ignore next */",
  ].join("\n"));
  const findings = analyzeTestDiffs(diff, process.cwd()).findings;
  expect(findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining(["tolerance.widened", "coverage.exclusion-added"]));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-nonvacuity-target-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "coverage@example.com"]);
  git(root, ["config", "user.name", "Coverage Target"]);
  fs.writeFileSync(path.join(root, "check.js"), "process.exit(1);\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "check.js"), "process.exit(0);\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const commandConfig = structuredClone(DEFAULT_CONFIG);
  commandConfig.framework.command = "node check.js";
  commandConfig.validation.toolchain_checks = false;
  expect(analyzeNonVacuity(root, base, head, commandConfig, ["tests/new.test.ts"]).results[0]?.status).toBe("meaningful");

  const fixture = repository();
  const coverage: CoverageReport = { format: "lcov", available: true, files: { "src/service.ts": { file: "src/service.ts", lines: { 3: 1, 4: 0, 5: 1 } } }, unknowns: [] };
  const integrity = analyzeTestIntegrity(fixture.root, [changed("src/service.ts", [3, 4, 5])], structuredClone(DEFAULT_CONFIG), { base: fixture.revision, coverage });
  expect(integrity.coverage.coverageDelta).toBe(0);
  expect(integrity.findings.some((item) => item.ruleId === "coverage.changed-line-uncovered")).toBe(true);
});

test("impact analysis returns an explicit unknown report when its time budget is exhausted", () => {
  const fixture = repository();
  const config = structuredClone(DEFAULT_CONFIG);
  config.validation.toolchain_checks = false;
  config.limits.analysis_timeout_seconds = 0;
  const result = analyzeImpact({ root: fixture.root, base: fixture.revision, head: fixture.revision, diffs: [changed("src/service.ts", [3])], config });
  expect(result.findings[0]?.ruleId).toBe("impact.analysis-unknown");
  expect(result.unknowns[0]).toMatch(/analysis limit/);
});
