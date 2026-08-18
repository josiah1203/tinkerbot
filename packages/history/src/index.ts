import fs from "node:fs";
import path from "node:path";
import type { HistoryRecord, PrProofReport, TestSelectionPlan } from "../../core/src/types";
import { TOOL_VERSION } from "../../core/src/version";

export const HISTORY_FILE = ".pr-proof/history.jsonl";

export function historyPath(root: string): string {
  return path.join(root, HISTORY_FILE);
}

export function historyRecordFromReport(report: PrProofReport, durationMs: number | null, selected: TestSelectionPlan | undefined, changedFiles: number | null, repository = report.repository, recordedAt = new Date().toISOString()): HistoryRecord {
  const findingsByRule: Record<string, number> = {};
  for (const finding of report.findings) findingsByRule[finding.ruleId] = (findingsByRule[finding.ruleId] ?? 0) + 1;
  const unknownRate = report.findings.length ? report.findings.filter((finding) => finding.resolution === "unknown" || finding.baselineState === "unknown").length / report.findings.length : report.limitations.length ? 1 : 0;
  return { schemaVersion: 1, repository, base: report.base, head: report.head, toolVersion: report.toolVersion, recordedAt, verdict: report.verdict, findingsByRule, unknownRate, coverage: report.summary.changedLinesCoveredPercentage, mutantsAttempted: report.testIntegrity?.mutation?.results.length ?? 0, mutantsKilled: report.testIntegrity?.mutation?.killed ?? 0, selectedTests: selected?.selected.length ?? null, durationMs, changedFiles, baselineChanges: report.baseline ? report.baseline.newCount + report.baseline.resolvedCount : null };
}

export function appendHistory(root: string, record: HistoryRecord): string {
  const file = historyPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

export interface HistoryReadResult {
  records: HistoryRecord[];
  malformedLines: number;
  ignoredSchemaLines: number;
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<HistoryRecord>;
  return record.schemaVersion === 1
    && typeof record.repository === "string"
    && typeof record.base === "string"
    && typeof record.head === "string"
    && typeof record.toolVersion === "string"
    && typeof record.recordedAt === "string"
    && ["PASS", "NEEDS_REVIEW", "UNKNOWN", "FAIL"].includes(String(record.verdict))
    && Boolean(record.findingsByRule && typeof record.findingsByRule === "object" && !Array.isArray(record.findingsByRule));
}

export function readHistoryDetails(root: string): HistoryReadResult {
  const file = historyPath(root);
  if (!fs.existsSync(file)) return { records: [], malformedLines: 0, ignoredSchemaLines: 0 };
  let content: string;
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return { records: [], malformedLines: 0, ignoredSchemaLines: 1 };
    content = fs.readFileSync(file, "utf8");
  } catch {
    return { records: [], malformedLines: 1, ignoredSchemaLines: 0 };
  }
  const records: HistoryRecord[] = [];
  let malformedLines = 0;
  let ignoredSchemaLines = 0;
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isHistoryRecord(parsed)) records.push(parsed);
      else ignoredSchemaLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines, ignoredSchemaLines };
}

export function readHistory(root: string): HistoryRecord[] {
  return readHistoryDetails(root).records;
}

export function compareHistory(root: string, revision: string): { current?: HistoryRecord; matches: HistoryRecord[]; unknowns: string[] } {
  const details = readHistoryDetails(root);
  const records = details.records;
  const matches = records.filter((record) => record.head === revision);
  const unknowns: string[] = [];
  if (!records.length) unknowns.push("No local verification history exists yet.");
  if (details.malformedLines) unknowns.push(`${details.malformedLines} malformed history record(s) were ignored.`);
  if (details.ignoredSchemaLines) unknowns.push(`${details.ignoredSchemaLines} history record(s) used an unsupported schema.`);
  if (records.some((record) => record.toolVersion !== TOOL_VERSION)) unknowns.push("History contains records from a different PR Proof tool version.");
  return { current: records.at(-1), matches, unknowns };
}
