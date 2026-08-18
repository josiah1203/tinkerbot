import fs from "node:fs";
import type { ArtifactEvidence } from "../../core/src/types";
import { normalizeMutationReport } from "../../mutation/src";
import { resolveRepositoryPath } from "../../core/src/safety";

export type ArtifactType = ArtifactEvidence["type"];

function attribute(text: string, name: string): string | undefined {
  return text.match(new RegExp(`${name}=["']([^"']*)["']`))?.[1];
}

function baseArtifact(type: ArtifactType, source: string): ArtifactEvidence {
  return { type, producer: type === "generic" ? "pr-proof-generic-adapter" : type, source, status: "parsed", completeness: "complete", unknowns: [], metrics: {}, records: [] };
}

function parseLcov(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("lcov", source);
  let current: Record<string, unknown> | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("SF:")) { current = { file: line.slice(3), coveredLines: [] }; result.records.push(current); }
    else if (line.startsWith("DA:") && current) {
      const [lineNumber, count] = line.slice(3).split(",").map(Number);
      if (Number.isInteger(lineNumber) && lineNumber > 0 && Number.isFinite(count) && count >= 0) { (current.coveredLines as number[]).push(lineNumber); if (count > 0) current.covered = Number(current.covered ?? 0) + 1; }
      else result.unknowns.push(`LCOV contained a malformed DA record: ${line}`);
    }
    else if (line.startsWith("end_of_record")) current = undefined;
  }
  if (current) result.unknowns.push("LCOV ended before end_of_record for the last source file.");
  result.metrics.files = result.records.length;
  if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("LCOV contained no SF records."); }
  else if (result.unknowns.length) { result.status = "partial"; result.completeness = "partial"; }
  return result;
}

function parseIstanbul(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("istanbul", source);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: ["Istanbul JSON could not be parsed."] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...result, status: "malformed", completeness: "unknown", unknowns: ["Istanbul JSON did not contain a file coverage object."] };
  const files = parsed as Record<string, unknown>;
  for (const [file, value] of Object.entries(files)) {
    const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const statementCounts = Object.values((data.s ?? {}) as Record<string, unknown>).map(Number);
    result.records.push({ file, coveredStatements: statementCounts.filter((count) => count > 0).length, statements: statementCounts.length });
  }
  result.metrics.files = result.records.length;
  if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("Istanbul JSON contained no file coverage records."); }
  return result;
}

function parseGoCoverprofile(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("go-coverprofile", source);
  const records = new Map<string, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("mode:")) continue;
    const match = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!match) { result.unknowns.push(`Go coverage contained a malformed record: ${line}`); continue; }
    const record = records.get(match[1]!) ?? { file: match[1]!, coveredLines: [], blocks: 0 };
    const start = Number(match[2]);
    const end = Number(match[3]);
    const count = Number(match[4]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || !Number.isFinite(count) || count < 0) { result.unknowns.push(`Go coverage contained an invalid record: ${line}`); continue; }
    record.blocks = Number(record.blocks ?? 0) + 1;
    if (count > 0) for (let current = start; current <= end; current += 1) (record.coveredLines as number[]).push(current);
    records.set(match[1]!, record);
  }
  result.records = [...records.values()].map((record) => ({ ...record, coveredLines: [...new Set(record.coveredLines as number[])].sort((left, right) => left - right) }));
  result.metrics.files = result.records.length;
  result.metrics.blocks = result.records.reduce((total, record) => total + Number(record.blocks ?? 0), 0);
  if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("Go coverage contained no source records."); }
  else if (result.unknowns.length) { result.status = "partial"; result.completeness = "partial"; }
  return result;
}

function parseGcov(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("gcov", source);
  const records = new Map<string, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/)) {
    const sourceMatch = line.match(/^\s*[-#=\d]+:\s*0:Source:(.+)$/);
    if (sourceMatch) records.set(sourceMatch[1]!.trim(), { file: sourceMatch[1]!.trim(), coveredLines: [] });
    const match = line.match(/^\s*(\d+|#+|=+|-):\s*(\d+):/);
    if (!match || !records.size) continue;
    const file = [...records.keys()].at(-1)!;
    const lineNumber = Number(match[2]);
    if (lineNumber > 0 && /^\d+$/.test(match[1]!)) (records.get(file)!.coveredLines as number[]).push(lineNumber);
  }
  result.records = [...records.values()].map((record) => ({ ...record, coveredLines: [...new Set(record.coveredLines as number[])].sort((left, right) => left - right) }));
  result.metrics.files = result.records.length;
  if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("gcov contained no Source records."); }
  return result;
}

function parseCoveragePy(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("coverage.py", source);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const files = parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files as Record<string, unknown> : undefined;
    if (!files) return { ...result, status: "malformed", completeness: "unknown", unknowns: ["coverage.py JSON did not contain a files object."] };
    for (const [file, value] of Object.entries(files)) {
      const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const executed = Array.isArray(data.executed_lines) ? data.executed_lines.filter((line): line is number => Number.isInteger(line)) : [];
      const missing = Array.isArray(data.missing_lines) ? data.missing_lines.filter((line): line is number => Number.isInteger(line)) : [];
      result.records.push({ file, executedLines: executed, missingLines: missing });
    }
    result.metrics.files = result.records.length;
    if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("coverage.py JSON contained no file records."); }
    return result;
  } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: ["coverage.py JSON could not be parsed."] }; }
}

function parseLlvmCov(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("llvm-cov", source);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = Array.isArray(parsed.data) ? parsed.data : [parsed];
    for (const item of data) {
      const files = item && typeof item === "object" && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).files) ? (item as Record<string, unknown>).files as unknown[] : [];
      for (const value of files) {
        const file = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const segments = Array.isArray(file.segments) ? file.segments.filter((segment): segment is unknown[] => Array.isArray(segment)) : [];
        result.records.push({ file: file.filename, coveredLines: segments.filter((segment) => Number(segment[2]) > 0).map((segment) => Number(segment[0])).filter((line) => Number.isInteger(line) && line > 0) });
      }
    }
    result.metrics.files = result.records.length;
    if (!result.records.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("LLVM coverage JSON contained no file records."); }
    return result;
  } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: ["LLVM coverage JSON could not be parsed."] }; }
}

function parseJunit(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("junit", source);
  const suites = [...raw.matchAll(/<testsuite\b[^>]*>/g)];
  const cases = [
    ...[...raw.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)].map((match) => ({ attrs: match[1] ?? "", body: match[2] ?? "" })),
    ...[...raw.matchAll(/<testcase\b([^>]*)\/>/g)].map((match) => ({ attrs: match[1] ?? "", body: "" })),
  ];
  result.metrics.suites = suites.length;
  result.metrics.tests = cases.length;
  result.metrics.failures = (raw.match(/<failure\b/g) ?? []).length;
  result.metrics.errors = (raw.match(/<error\b/g) ?? []).length;
  result.metrics.skipped = (raw.match(/<skipped\b/g) ?? []).length;
  for (const match of cases) {
    const attrs = match.attrs;
    const body = match.body;
    result.records.push({ name: attribute(attrs, "name"), classname: attribute(attrs, "classname"), status: /<failure\b|<error\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed", duration: attribute(attrs, "time") });
  }
  if (!suites.length && !cases.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("JUnit XML contained no test suites or cases."); }
  return result;
}

function parseTestJson(raw: string, source: string, type: "jest" | "vitest"): ArtifactEvidence {
  const result = baseArtifact(type, source);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: [`${type} JSON could not be parsed.`] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...result, status: "malformed", completeness: "unknown", unknowns: [`${type} JSON did not contain an object result.`] };
  const testResults: unknown[] = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  result.metrics.total = Number(parsed.numTotalTests ?? parsed.numTotalTestSuites ?? testResults.length) || 0;
  result.metrics.passed = Number(parsed.numPassedTests) || testResults.filter((item) => !/fail/i.test(JSON.stringify(item))).length;
  result.metrics.failed = Number(parsed.numFailedTests) || testResults.filter((item) => /fail/i.test(JSON.stringify(item))).length;
  result.records = testResults.map((item) => typeof item === "object" && item ? item as Record<string, unknown> : { value: item });
  if (!testResults.length && !parsed.numTotalTests && !parsed.numTotalTestSuites) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push(`${type} JSON did not contain recognizable test results.`); }
  return result;
}

function parseSarif(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("sarif", source);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: ["SARIF JSON could not be parsed."] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...result, status: "malformed", completeness: "unknown", unknowns: ["SARIF JSON did not contain an object."] };
  const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
  for (const run of runs) {
    if (!run || typeof run !== "object" || Array.isArray(run)) { result.unknowns.push("SARIF contained a non-object run."); continue; }
    const value = run as Record<string, unknown>;
    const results = Array.isArray(value.results) ? value.results : [];
    result.records.push(...results.map((item) => typeof item === "object" && item && !Array.isArray(item) ? item as Record<string, unknown> : { value: item }));
  }
  result.metrics.runs = runs.length;
  result.metrics.findings = result.records.length;
  if (!runs.length) { result.status = "partial"; result.completeness = "unknown"; result.unknowns.push("SARIF contained no runs."); }
  return result;
}

function parseStryker(raw: string, source: string): ArtifactEvidence {
  const result = baseArtifact("stryker", source);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object" || !("mutantResults" in parsed) && !("mutants" in parsed))) return { ...result, status: "malformed", completeness: "unknown", unknowns: ["Stryker JSON did not contain a recognized mutant result list."] };
    const normalized = normalizeMutationReport(parsed, Number.MAX_SAFE_INTEGER);
    result.records = normalized.map((item) => ({ ...item }));
    result.metrics.mutants = normalized.length;
    result.metrics.killed = normalized.filter((item) => item.status === "killed").length;
    result.metrics.survived = normalized.filter((item) => item.status === "survived").length;
    result.metrics.unknown = normalized.filter((item) => item.status === "unknown" || item.status === "timeout").length;
    return result;
  } catch { return { ...result, status: "malformed", completeness: "unknown", unknowns: ["Stryker JSON could not be parsed."] }; }
}

export function detectArtifactType(source: string, raw = ""): ArtifactType {
  const lower = source.toLowerCase();
  if (lower.endsWith(".info") || lower.endsWith("lcov") || lower.includes("lcov")) return "lcov";
  if (lower.endsWith(".out") || /^\s*mode:\s*(?:set|count|atomic)\s*$/m.test(raw)) return "go-coverprofile";
  if (lower.endsWith(".gcov") || /^\s*[-#=\d]+:\s*0:Source:/m.test(raw)) return "gcov";
  if (lower.includes("istanbul") || lower.endsWith("coverage-final.json")) return "istanbul";
  if (raw.includes('"executed_lines"') || raw.includes('"missing_lines"')) return "coverage.py";
  if (raw.includes('"segments"') && (raw.includes('"filename"') || raw.includes('"data"'))) return "llvm-cov";
  if (lower.endsWith(".xml") || lower.includes("junit")) return "junit";
  if (lower.includes("stryker") || lower.includes("mutation")) return "stryker";
  if (lower.endsWith(".sarif") || lower.includes("sarif")) return "sarif";
  if (lower.includes("vitest")) return "vitest";
  if (lower.includes("jest")) return "jest";
  if (raw.includes('"runs"') && raw.includes('"$schema"')) return "sarif";
  if (raw.includes("<testsuite")) return "junit";
  return "generic";
}

export function parseArtifact(raw: string, source: string, type: ArtifactType = detectArtifactType(source, raw)): ArtifactEvidence {
  if (type === "lcov") return parseLcov(raw, source);
  if (type === "istanbul") return parseIstanbul(raw, source);
  if (type === "coverage.py") return parseCoveragePy(raw, source);
  if (type === "go-coverprofile") return parseGoCoverprofile(raw, source);
  if (type === "gcov") return parseGcov(raw, source);
  if (type === "llvm-cov") return parseLlvmCov(raw, source);
  if (type === "junit") return parseJunit(raw, source);
  if (type === "jest" || type === "vitest") return parseTestJson(raw, source, type);
  if (type === "stryker") return parseStryker(raw, source);
  if (type === "sarif") return parseSarif(raw, source);
  try {
    const parsed = JSON.parse(raw);
    const result = baseArtifact("generic", source);
    result.records = Array.isArray(parsed) ? parsed.map((item) => typeof item === "object" && item ? item as Record<string, unknown> : { value: item }) : [typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : { value: parsed }];
    result.metrics.records = result.records.length;
    return result;
  } catch { return { ...baseArtifact("generic", source), status: "malformed", completeness: "unknown", unknowns: ["Generic JSON evidence could not be parsed."] }; }
}

export function loadArtifact(root: string, input: string, type?: ArtifactType): ArtifactEvidence {
  let file: string;
  try { file = resolveRepositoryPath(root, input); }
  catch (error) { return { ...baseArtifact(type ?? detectArtifactType(input), input), status: "missing", completeness: "unknown", unknowns: [error instanceof Error ? error.message : String(error)] }; }
  if (!fs.existsSync(file)) return { ...baseArtifact(type ?? detectArtifactType(input), input), status: "missing", completeness: "unknown", unknowns: [`Artifact not found: ${input}`] };
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return { ...baseArtifact(type ?? detectArtifactType(input), input), status: "partial", completeness: "unknown", unknowns: [`Artifact exceeds the 16 MiB safety limit: ${input}`] };
    return parseArtifact(fs.readFileSync(file, "utf8"), input, type);
  }
  catch (error) { return { ...baseArtifact(type ?? detectArtifactType(input), input), status: "malformed", completeness: "unknown", unknowns: [`Artifact could not be read: ${error instanceof Error ? error.message : String(error)}`] }; }
}

export function parseGenericEvidence(raw: string, source = "inline-generic.json"): ArtifactEvidence {
  return parseArtifact(raw, source, "generic");
}
