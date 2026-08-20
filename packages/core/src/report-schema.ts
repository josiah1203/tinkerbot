import crypto from "node:crypto";
import type { Finding, PrProofReport } from "./types";

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_SCHEMA_ID = "https://pr-proof.dev/schemas/report/v1";
const VALID_VERDICTS = new Set(["PASS", "UNKNOWN", "FAIL"]);
const MAX_EVIDENCE_TEXT = 8_192;

export function findingStartLine(finding: Finding): number | undefined {
  return finding.startLine ?? finding.line;
}

export function findingEndLine(finding: Finding): number | undefined {
  return finding.endLine ?? finding.startLine ?? finding.line;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left: Finding, right: Finding): number {
  const severityWeight: Record<Finding["severity"], number> = { critical: 3, high: 2, warning: 1, info: 0 };
  return severityWeight[right.severity] - severityWeight[left.severity]
    || compareText(left.file ?? "", right.file ?? "")
    || (findingStartLine(left) ?? 1) - (findingStartLine(right) ?? 1)
    || compareText(left.ruleId, right.ruleId)
    || compareText(left.id, right.id)
    || compareText(left.message, right.message)
    || compareText(left.fingerprint ?? "", right.fingerprint ?? "");
}

function boundedText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_EVIDENCE_TEXT) return value;
  return `${value.slice(0, MAX_EVIDENCE_TEXT - 32)} … [truncated ${value.length - (MAX_EVIDENCE_TEXT - 32)} characters]`;
}

export function findingFingerprint(finding: Finding): string {
  const stable = JSON.stringify({
    ruleId: finding.ruleId,
    category: finding.category,
    file: finding.file ?? "repository",
    message: finding.message,
    classification: finding.classification ?? "",
    before: finding.evidence?.before ?? "",
    after: finding.evidence?.after ?? "",
    detail: finding.evidence?.detail ?? "",
  });
  return `sha256:${crypto.createHash("sha256").update(stable).digest("hex")}`;
}

function finalizeFinding(finding: Finding, report: PrProofReport): Finding {
  const evidence = finding.evidence ?? { detail: finding.explanation };
  return {
    ...finding,
    file: finding.file ?? "repository",
    startLine: findingStartLine(finding) ?? 1,
    endLine: findingEndLine(finding) ?? findingStartLine(finding) ?? 1,
    title: finding.title ?? finding.message,
    evidence: { before: boundedText(evidence.before), after: boundedText(evidence.after), detail: boundedText(evidence.detail) },
    fingerprint: finding.fingerprint ?? findingFingerprint(finding),
    module: finding.module ?? finding.category,
    resolution: finding.resolution ?? (finding.ruleId.includes("unknown") || finding.category === "system" ? "unknown" : "open"),
    toolVersion: finding.toolVersion ?? report.toolVersion,
    baseSha: finding.baseSha ?? report.base,
    headSha: finding.headSha ?? report.head,
  };
}

function finalizeFindings(findings: Finding[], report: PrProofReport): Finding[] {
  const finalized = findings.map((finding) => finalizeFinding(finding, report)).sort(compareFindings);
  const unique = new Map<string, Finding>();
  for (const finding of finalized) {
    const key = finding.fingerprint ?? findingFingerprint(finding);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, finding);
      continue;
    }
    const preferred = compareFindings(previous, finding) <= 0 ? previous : finding;
    unique.set(key, {
      ...preferred,
      blocking: Boolean(previous.blocking || finding.blocking),
      evidenceRefs: [...new Set([...(previous.evidenceRefs ?? []), ...(finding.evidenceRefs ?? [])])].sort(),
    });
  }
  return [...unique.values()].sort(compareFindings);
}

export function validateReport(report: PrProofReport): void {
  if (!report || typeof report !== "object") throw new Error("Report must be an object");
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`Unsupported report schema version: ${String(report.schemaVersion)}`);
  if (report.schemaId !== REPORT_SCHEMA_ID) throw new Error(`Invalid report schema identifier: ${String(report.schemaId)}`);
  if (typeof report.toolVersion !== "string" || typeof report.repository !== "string" || typeof report.base !== "string" || typeof report.head !== "string" || !report.summary || typeof report.summary !== "object" || !Array.isArray(report.limitations)) throw new Error("Report is missing required top-level fields");
  if (!VALID_VERDICTS.has(report.verdict)) throw new Error(`Invalid report verdict: ${String(report.verdict)}`);
  if (!Array.isArray(report.findings)) throw new Error("Report findings must be an array");
  for (const finding of [...report.findings, ...(report.testIntegrity?.findings ?? []), ...(report.impact?.findings ?? []), ...(report.contracts?.findings ?? []), ...(report.fixtures?.findings ?? [])]) {
    if (!finding.file || !finding.startLine || !finding.endLine || !finding.title || !finding.evidence || !finding.fingerprint || !finding.module || !finding.resolution || !finding.toolVersion || !finding.baseSha || !finding.headSha) throw new Error(`Finding ${finding.id} is missing stable report metadata`);
  }
}

/** Adds the stable metadata required by the versioned report contract. */
export function finalizeReport(report: PrProofReport): PrProofReport {
  const findings = finalizeFindings(report.findings, report);
  const testIntegrity = report.testIntegrity ? { ...report.testIntegrity, findings: finalizeFindings(report.testIntegrity.findings, report) } : undefined;
  const impact = report.impact ? { ...report.impact, findings: finalizeFindings(report.impact.findings, report) } : undefined;
  const contracts = report.contracts ? { ...report.contracts, findings: finalizeFindings(report.contracts.findings, report) } : undefined;
  const fixtures = report.fixtures ? { ...report.fixtures, findings: finalizeFindings(report.fixtures.findings, report) } : undefined;
  const finalized = { ...report, schemaId: report.schemaId ?? REPORT_SCHEMA_ID, findings, testIntegrity, impact, contracts, fixtures };
  validateReport(finalized);
  return finalized;
}
