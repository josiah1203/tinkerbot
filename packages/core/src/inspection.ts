import type { Finding, PrProofConfig, Verdict } from "./types";
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

export function moduleFeedsVerification(id: InspectionModuleId): boolean {
  return INSPECTION_MODULES.find((module) => module.id === id)?.blocksVerification === true;
}

export function combineVerification(input: {
  findings: Finding[];
  config: PrProofConfig;
  unknowns: string[];
  reportedClaims?: Array<{ statement: string; provenance: InspectionProvenance }>;
}): { verificationVerdict: Verdict; ignoredReported: number } {
  const ignoredReported = (input.reportedClaims ?? []).filter((claim) => claim.provenance === "reported").length;
  const verdict = calculateVerdict(input.findings, input.config, input.unknowns);
  return { verificationVerdict: verdict, ignoredReported };
}

export function codeUnknown(code: string): string {
  return code;
}
