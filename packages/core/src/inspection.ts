import type { Finding, PrProofConfig, ReviewAssessment, Verdict } from "./types";
import { calculateVerdict } from "./verdict";

export type InspectionModuleId = "test-integrity" | "change-impact" | "api-contracts" | "fixture-integrity" | "mutation" | "coverage" | "policy" | "select-tests" | "eval-judge" | "worker-claim";
export type InspectionProvenance = "verified" | "attested" | "reported" | "inferred" | "unknown";

export interface InspectionModule {
  id: InspectionModuleId;
  requirement: "required" | "line-dependent" | "advisory";
  blocksVerification: boolean;
}

export const INSPECTION_MODULES: InspectionModule[] = [
  { id: "test-integrity", requirement: "required", blocksVerification: true },
  { id: "change-impact", requirement: "required", blocksVerification: true },
  { id: "api-contracts", requirement: "line-dependent", blocksVerification: true },
  { id: "fixture-integrity", requirement: "line-dependent", blocksVerification: true },
  { id: "mutation", requirement: "advisory", blocksVerification: false },
  { id: "coverage", requirement: "advisory", blocksVerification: false },
  { id: "policy", requirement: "required", blocksVerification: true },
  { id: "select-tests", requirement: "advisory", blocksVerification: false },
  { id: "eval-judge", requirement: "advisory", blocksVerification: false },
  { id: "worker-claim", requirement: "advisory", blocksVerification: false },
];

export const UNKNOWN_CODES = [
  "evidence_unavailable",
  "source_not_uploaded",
  "oidc_ingest_missing",
  "environment_not_reproducible",
  "required_test_not_executed",
  "dependency_graph_incomplete",
  "runtime_outcome_not_observed",
  "receipt_stale",
  "worker_claim_unverifiable",
] as const;
export type UnknownCode = (typeof UNKNOWN_CODES)[number];

export function moduleFeedsVerification(id: InspectionModuleId): boolean {
  return INSPECTION_MODULES.find((module) => module.id === id)?.blocksVerification === true;
}

export function deriveReviewAssessment(findings: Finding[], verificationVerdict: Verdict): ReviewAssessment {
  if (verificationVerdict === "FAIL" || findings.some((finding) => finding.severity === "critical" || finding.severity === "high")) return "REVISE";
  if (verificationVerdict === "UNKNOWN" || findings.some((finding) => finding.severity === "warning")) return "NEEDS_HUMAN_REVIEW";
  return "CLEAR";
}

export function codeUnknown(code: string): string {
  return code;
}

export function classifyUnknown(text: string): string {
  const trimmed = text.trim();
  if (UNKNOWN_CODES.some((code) => trimmed === code || trimmed.startsWith(`${code}:`))) return trimmed;
  const lower = trimmed.toLowerCase();
  let code: UnknownCode = "evidence_unavailable";
  if (/source not uploaded|source-upload|source_not_uploaded/.test(lower)) code = "source_not_uploaded";
  else if (/oidc|ingest missing/.test(lower)) code = "oidc_ingest_missing";
  else if (/stale/.test(lower)) code = "receipt_stale";
  else if (/worker claim|tests passed|self-verif/.test(lower)) code = "worker_claim_unverifiable";
  else if (/test not executed|required test|impacted tests not/.test(lower)) code = "required_test_not_executed";
  else if (/reproduc/.test(lower)) code = "environment_not_reproducible";
  else if (/dependenc/.test(lower)) code = "dependency_graph_incomplete";
  else if (/outcome/.test(lower)) code = "runtime_outcome_not_observed";
  return `${code}: ${trimmed}`;
}

export function classifyUnknowns(unknowns: string[]): string[] {
  return [...new Set(unknowns.map(classifyUnknown))];
}

export function combineVerification(input: {
  findings: Finding[];
  config: PrProofConfig;
  unknowns: string[];
  reportedClaims?: Array<{ statement: string; provenance: InspectionProvenance }>;
}): { verificationVerdict: Verdict; reviewAssessment: ReviewAssessment; ignoredReported: number } {
  const ignoredReported = (input.reportedClaims ?? []).filter((claim) => claim.provenance === "reported").length;
  const unknowns = classifyUnknowns(input.unknowns);
  const verificationVerdict = calculateVerdict(input.findings, input.config, unknowns);
  return {
    verificationVerdict,
    reviewAssessment: deriveReviewAssessment(input.findings, verificationVerdict),
    ignoredReported,
  };
}
