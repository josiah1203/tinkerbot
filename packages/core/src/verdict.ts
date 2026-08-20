import type { Finding, PrProofConfig, Verdict } from "./types";

const SEVERITY_WEIGHT: Record<Finding["severity"], number> = { info: 0, warning: 1, high: 2, critical: 3 };

export function translateLegacyVerdict(verdict: string | undefined): Verdict {
  if (verdict === "PASS" || verdict === "FAIL" || verdict === "UNKNOWN") return verdict;
  if (verdict === "NEEDS_REVIEW") return "UNKNOWN";
  return "UNKNOWN";
}

export function calculateVerdict(findings: Finding[], config: PrProofConfig, unknowns: string[]): Verdict {
  if (config.test_integrity.mode === "blocking" && findings.some((finding) => finding.blocking && SEVERITY_WEIGHT[finding.severity] >= 2)) return "FAIL";
  if (findings.some((finding) => finding.severity === "critical" && finding.blocking)) return "FAIL";
  if (findings.some((finding) => SEVERITY_WEIGHT[finding.severity] >= 1)) return "UNKNOWN";
  if (unknowns.length > 0) return "UNKNOWN";
  return "PASS";
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (severity !== 0) return severity;
    const file = (a.file ?? "") < (b.file ?? "") ? -1 : (a.file ?? "") > (b.file ?? "") ? 1 : 0;
    if (file !== 0) return file;
    const line = (a.startLine ?? a.line ?? 1) - (b.startLine ?? b.line ?? 1);
    if (line !== 0) return line;
    const rule = a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
    return rule || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
