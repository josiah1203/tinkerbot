import fs from "node:fs";
import path from "node:path";
import type { CoverageFile, CoverageReport, CoverageSummary, FileDiff } from "../../core/src/types";
import { repositoryRelativePath, resolveRepositoryPath } from "../../core/src/safety";
import { resolveRevision } from "../../git/src";
import { isSourceFile, isTestFile } from "../../git/src";
import { execFileSync } from "node:child_process";

function normalized(root: string, file: string): string | undefined {
  const candidate = file.replace(/^file:\/\//, "");
  if (/^[A-Za-z]:[\\/]/.test(candidate) && !path.isAbsolute(candidate)) return undefined;
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/") || ".";
}

function emptyReport(unknowns: string[] = []): CoverageReport {
  return { format: "unknown", files: {}, available: false, unknowns };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseLcov(text: string, root: string): CoverageReport {
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  let current: CoverageFile | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const file = normalized(root, line.slice(3).trim());
      if (!file) {
        current = undefined;
        unknowns.push(`LCOV source path is outside the repository or is not portable: ${line.slice(3)}`);
        continue;
      }
      current = files[file] ?? { file, lines: {}, functions: {}, branches: {} };
      files[file] = current;
    } else if (current && line.startsWith("DA:")) {
      const [lineNumber, count] = line.slice(3).split(",");
      const parsedLine = Number(lineNumber);
      const parsedCount = Number(count ?? 0);
      if (Number.isInteger(parsedLine) && parsedLine > 0 && Number.isFinite(parsedCount) && parsedCount >= 0) current.lines[parsedLine] = Math.max(current.lines[parsedLine] ?? 0, parsedCount);
      else unknowns.push(`LCOV contained a malformed DA record: ${line}`);
    } else if (current && line.startsWith("FNDA:")) {
      const [count, name] = line.slice(5).split(",");
      const parsedCount = Number(count ?? 0);
      if (name && Number.isFinite(parsedCount) && parsedCount >= 0) current.functions![name] = Math.max(current.functions![name] ?? 0, parsedCount);
      else unknowns.push(`LCOV contained a malformed FNDA record: ${line}`);
    } else if (current && line.startsWith("BRDA:")) {
      const parts = line.slice(5).split(",");
      const key = parts.slice(0, 3).join(":");
      const count = parts[3] === "-" ? 0 : Number(parts[3] ?? 0);
      if (key && Number.isFinite(count) && count >= 0) current.branches![key] = Math.max(current.branches![key] ?? 0, count);
      else unknowns.push(`LCOV contained a malformed BRDA record: ${line}`);
    } else if (line === "end_of_record") current = undefined;
  }
  return { format: "lcov", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

function parseIstanbulFile(file: string, value: Record<string, unknown>, root: string): { coverage?: CoverageFile; unknowns: string[] } {
  const normalizedFile = normalized(root, file);
  if (!normalizedFile) return { unknowns: [`Istanbul coverage path is outside the repository or is not portable: ${file}`] };
  const result: CoverageFile = { file: normalizedFile, lines: {}, functions: {}, branches: {} };
  const unknowns: string[] = [];
  const statementMap = record(value.statementMap) ?? {};
  const statementCounts = record(value.s) ?? {};
  if (value.statementMap !== undefined && !record(value.statementMap)) unknowns.push(`Istanbul statementMap for ${file} was not an object.`);
  if (value.s !== undefined && !record(value.s)) unknowns.push(`Istanbul statement counts for ${file} were not an object.`);
  for (const [id, location] of Object.entries(statementMap)) {
    const locationRecord = record(location);
    const startRecord = record(locationRecord?.start);
    const endRecord = record(locationRecord?.end);
    const start = startRecord?.line;
    const end = endRecord?.line ?? start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) <= 0 || (end as number) < (start as number)) continue;
    const count = Number(statementCounts[id] ?? 0);
    if (!Number.isFinite(count) || count < 0) { unknowns.push(`Istanbul statement count for ${file}:${id} was invalid.`); continue; }
    const startLine = start as number;
    const endLine = end as number;
    for (let line = startLine; line <= endLine; line += 1) result.lines[line] = Math.max(result.lines[line] ?? 0, count);
  }
  const functions = record(value.f) ?? {};
  const branches = record(value.b) ?? {};
  if (value.f !== undefined && !record(value.f)) unknowns.push(`Istanbul function counts for ${file} were not an object.`);
  if (value.b !== undefined && !record(value.b)) unknowns.push(`Istanbul branch counts for ${file} were not an object.`);
  for (const [id, value] of Object.entries(functions)) {
    const count = Number(value);
    if (Number.isFinite(count) && count >= 0) result.functions![id] = count;
    else unknowns.push(`Istanbul function count for ${file}:${id} was invalid.`);
  }
  for (const [id, branch] of Object.entries(branches)) {
    const counts = Array.isArray(branch) ? branch.map(Number).filter((count) => Number.isFinite(count) && count >= 0) : [];
    if (!Array.isArray(branch)) unknowns.push(`Istanbul branch count for ${file}:${id} was not an array.`);
    if (counts.length) result.branches![id] = Math.min(...counts);
  }
  return { coverage: result, unknowns };
}

export function parseIstanbulJson(text: string, root: string): CoverageReport {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return emptyReport(["Istanbul JSON could not be parsed."]); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyReport(["Istanbul JSON did not contain a file coverage object."]);
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  for (const [file, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      unknowns.push(`Istanbul coverage record for ${file} was not an object.`);
      continue;
    }
    const parsedFile = parseIstanbulFile(file, value as Record<string, unknown>, root);
    if (parsedFile.coverage) files[parsedFile.coverage.file] = parsedFile.coverage;
    unknowns.push(...parsedFile.unknowns);
  }
  return { format: "istanbul", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

export function parseGoCoverprofile(text: string, root: string): CoverageReport {
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("mode:")) continue;
    const match = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) {
      unknowns.push(`Go coverage contained a malformed record: ${line}`);
      continue;
    }
    const file = normalized(root, match[1]!);
    const start = Number(match[2]);
    const end = Number(match[3]);
    const count = Number(match[5]);
    if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start || !Number.isFinite(count) || count < 0) {
      unknowns.push(`Go coverage contained an unsafe or invalid source record: ${line}`);
      continue;
    }
    const coverage = files[file] ?? { file, lines: {}, functions: {}, branches: {} };
    for (let current = start; current <= end; current += 1) coverage.lines[current] = Math.max(coverage.lines[current] ?? 0, count);
    files[file] = coverage;
  }
  return { format: "go-coverprofile", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

export function parseGcov(text: string, root: string): CoverageReport {
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  let currentFile: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const sourceMatch = line.match(/^\s*[-#=\d]+:\s*0:Source:(.+)$/);
    if (sourceMatch) {
      currentFile = normalized(root, sourceMatch[1]!.trim());
      if (!currentFile) unknowns.push(`gcov source path is outside the repository or is not portable: ${sourceMatch[1]}`);
      else files[currentFile] = files[currentFile] ?? { file: currentFile, lines: {}, functions: {}, branches: {} };
      continue;
    }
    if (!currentFile) continue;
    const record = line.match(/^\s*(\d+|#+|=+|-):\s*(\d+):/);
    if (!record) continue;
    const lineNumber = Number(record[2]);
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) continue;
    const count = /^\d+$/.test(record[1]!) ? Number(record[1]) : 0;
    files[currentFile]!.lines[lineNumber] = Math.max(files[currentFile]!.lines[lineNumber] ?? 0, count);
  }
  return { format: "gcov", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

export function parseCoveragePyJson(text: string, root: string): CoverageReport {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return emptyReport(["coverage.py JSON could not be parsed."]); }
  const object = record(parsed);
  const fileRecords = record(object?.files);
  if (!fileRecords) return emptyReport(["coverage.py JSON did not contain a files object."]);
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  for (const [file, value] of Object.entries(fileRecords)) {
    const coverageValue = record(value);
    const normalizedFile = normalized(root, file);
    if (!coverageValue || !normalizedFile) {
      unknowns.push(`coverage.py record was invalid or outside the repository: ${file}`);
      continue;
    }
    const executed = Array.isArray(coverageValue.executed_lines) ? coverageValue.executed_lines : [];
    const missing = Array.isArray(coverageValue.missing_lines) ? coverageValue.missing_lines : [];
    const result: CoverageFile = { file: normalizedFile, lines: {}, functions: {}, branches: {} };
    for (const line of executed) if (Number.isInteger(line) && Number(line) > 0) result.lines[Number(line)] = 1;
    for (const line of missing) if (Number.isInteger(line) && Number(line) > 0 && result.lines[Number(line)] === undefined) result.lines[Number(line)] = 0;
    if (!executed.length && !missing.length) unknowns.push(`coverage.py record had no line data for ${file}.`);
    files[normalizedFile] = result;
  }
  return { format: "coverage.py", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

export function parseLlvmCovJson(text: string, root: string): CoverageReport {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return emptyReport(["LLVM coverage JSON could not be parsed."]); }
  const object = record(parsed);
  const data = Array.isArray(object?.data) ? object.data : [object];
  const files: Record<string, CoverageFile> = {};
  const unknowns: string[] = [];
  for (const entry of data) {
    const entryRecord = record(entry);
    const fileRecords = Array.isArray(entryRecord?.files) ? entryRecord.files : [];
    for (const fileValue of fileRecords) {
      const fileRecord = record(fileValue);
      const fileName = typeof fileRecord?.filename === "string" ? fileRecord.filename : undefined;
      const normalizedFile = fileName ? normalized(root, fileName) : undefined;
      if (!fileRecord || !normalizedFile) {
        unknowns.push("LLVM coverage contained a file outside the repository or without a filename.");
        continue;
      }
      const coverage: CoverageFile = files[normalizedFile] ?? { file: normalizedFile, lines: {}, functions: {}, branches: {} };
      const segments = Array.isArray(fileRecord.segments) ? fileRecord.segments : [];
      for (const segment of segments) {
        if (!Array.isArray(segment) || !Number.isInteger(segment[0]) || !Number.isFinite(Number(segment[2]))) continue;
        const line = Number(segment[0]);
        const count = Number(segment[2]);
        if (line > 0 && count >= 0) coverage.lines[line] = Math.max(coverage.lines[line] ?? 0, count);
      }
      files[normalizedFile] = coverage;
    }
  }
  if (!Object.keys(files).length) unknowns.push("LLVM coverage JSON did not contain file segment data.");
  return { format: "llvm-cov", files, source: text, available: Object.keys(files).length > 0, unknowns };
}

function parseCoverageArtifact(text: string, root: string, fileName: string): CoverageReport {
  const lower = fileName.toLowerCase();
  if (lower.endsWith("lcov.info") || /^\s*(?:tn:|sf:)/m.test(text)) return parseLcov(text, root);
  if (lower.endsWith(".out") || /^\s*mode:\s*(?:set|count|atomic)\s*$/m.test(text)) return parseGoCoverprofile(text, root);
  if (lower.endsWith(".gcov") || /^\s*[-#=\d]+:\s*0:Source:/m.test(text)) return parseGcov(text, root);
  try {
    const parsed = JSON.parse(text) as unknown;
    const object = record(parsed);
    if (record(object?.files) && Object.values(record(object?.files) ?? {}).some((value) => record(value)?.executed_lines !== undefined || record(value)?.missing_lines !== undefined)) return parseCoveragePyJson(text, root);
    if (Array.isArray(object?.data) || (Array.isArray(object?.files) && object.files.some((value) => record(value)?.segments !== undefined))) return parseLlvmCovJson(text, root);
  } catch {
    return emptyReport([`Coverage artifact ${fileName} was not valid JSON or a recognized text format.`]);
  }
  return parseIstanbulJson(text, root);
}

export function readCoverage(root: string, configured?: string): CoverageReport {
  const candidates = configured ? [configured] : ["coverage/lcov.info", "coverage/coverage-final.json", "coverage/coverage.json", "coverage/coverage.out", "coverage.out", "coverage/coverage.gcov"];
  for (const candidate of candidates) {
    let file: string;
    try { file = resolveRepositoryPath(root, candidate); }
    catch (error) { return emptyReport([error instanceof Error ? error.message : String(error)]); }
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      return parseCoverageArtifact(text, root, file);
    } catch (error) {
      return emptyReport([`Coverage artifact could not be read: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }
  return emptyReport();
}

export function readCoverageAtRevision(root: string, revision: string, configured?: string): CoverageReport {
  const candidates = configured ? [configured] : ["coverage/lcov.info", "coverage/coverage-final.json", "coverage/coverage.json", "coverage/coverage.out", "coverage.out", "coverage/coverage.gcov"];
  let resolvedRevision: string;
  try { resolvedRevision = resolveRevision(revision, root); }
  catch { return emptyReport([`Coverage base revision could not be resolved: ${revision}`]); }
  for (const candidate of candidates) {
    try {
      const relative = repositoryRelativePath(root, candidate);
      const text = execFileSync("git", ["show", `${resolvedRevision}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return parseCoverageArtifact(text, root, relative);
    } catch {
      // Base coverage artifacts are optional and often generated rather than committed.
    }
  }
  return emptyReport();
}

function isExecutableLine(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed)
    && !trimmed.startsWith("//")
    && !trimmed.startsWith("/*")
    && !trimmed.startsWith("*")
    && !trimmed.startsWith("#")
    && !trimmed.startsWith("import ")
    && !trimmed.startsWith("from ")
    && !trimmed.startsWith("package ")
    && !trimmed.startsWith("use ")
    && !trimmed.startsWith("export type ");
}

export function calculateChangedLineCoverage(root: string, diffs: FileDiff[], coverage: CoverageReport, modifiedTestFiles: Set<string>): CoverageSummary {
  const changedLines: Array<{ file: string; line: number; text: string }> = [];
  for (const diff of diffs) {
    if (isTestFile(diff.path) || !isSourceFile(diff.path)) continue;
    let file: string;
    try { file = resolveRepositoryPath(root, diff.path); } catch { continue; }
    if (!fs.existsSync(file)) continue;
    let sourceLines: string[];
    try { sourceLines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { continue; }
    for (const line of diff.changedLines) {
      if (isExecutableLine(sourceLines[line - 1] ?? "")) changedLines.push({ file: diff.path, line, text: sourceLines[line - 1] ?? "" });
    }
  }
  const covered = changedLines.filter(({ file, line }) => {
    const normalizedFile = normalized(root, file);
    return Boolean(normalizedFile && (coverage.files[normalizedFile]?.lines[line] ?? 0) > 0);
  });
  const percentage = changedLines.length ? (covered.length / changedLines.length) * 100 : null;
  const highRiskUncovered = changedLines.filter(({ file, line, text }) => !covered.some((entry) => entry.file === file && entry.line === line) && /auth|permission|token|validate|error|catch|throw|forbidden|unauthorized/i.test(`${file} ${text}`)).map(({ file, line }) => `${file}:${line}`);
  const modifiedTestRelated = modifiedTestFiles.size > 0 ? covered.filter(({ file }) => modifiedTestFiles.has(file)) : [];
  const uncoveredLines = changedLines.filter(({ file, line }) => !covered.some((entry) => entry.file === file && entry.line === line)).map(({ file, line }) => `${file}:${line}`);
  return {
    available: coverage.available,
    changedExecutableLines: changedLines.length,
    changedLinesCovered: covered.length,
    changedLinesCoveredByModifiedTests: modifiedTestRelated.length,
    changedLinesNotCovered: changedLines.length - covered.length,
    percentage,
    coverageDelta: null,
    highRiskUncovered,
    uncoveredLines,
  };
}
