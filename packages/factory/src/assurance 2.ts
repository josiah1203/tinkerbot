import { mayRecordRelease, type FactoryProjection, type TaskContract, type WorkerContract, type WorkerReceipt, type VerificationVerdictV2 } from "./graph";
import { verifyWorkerReceipt } from "./production";

export interface FactoryFinding { ruleId: string; severity: "info" | "warning" | "error"; message: string; blocking: boolean; }
export interface FactoryAssuranceInput { task?: TaskContract; workerContract?: WorkerContract; receipt?: WorkerReceipt; projection: FactoryProjection; workerIds: string[]; releaseActorId?: string; integration?: { conflicts: string[]; assembled: boolean }; reproducible?: boolean; }
export interface FactoryAssuranceReport { verificationVerdict: VerificationVerdictV2; findings: FactoryFinding[]; releaseEligible: boolean; }

/** Deterministic checks only. It reads claims; it does not upgrade them or make review decisions. */
export function assessFactoryChange(input: FactoryAssuranceInput): FactoryAssuranceReport {
  const findings: FactoryFinding[] = [];
  if (!input.task) findings.push({ ruleId: "traceability.task-missing", severity: "error", message: "A change requires a traceable parent task.", blocking: true });
  if (!input.workerContract) findings.push({ ruleId: "traceability.work-order-missing", severity: "error", message: "A change requires a structured worker contract.", blocking: true });
  if (input.workerContract && !input.receipt) findings.push({ ruleId: "receipt.missing", severity: "error", message: "Worker receipt is required before assurance can complete.", blocking: true });
  if (input.workerContract && input.receipt) for (const error of verifyWorkerReceipt(input.receipt, input.workerContract).errors) findings.push({ ruleId: "receipt.invalid", severity: "error", message: error, blocking: true });
  if (input.integration?.conflicts.length) findings.push({ ruleId: "integration.conflict", severity: "error", message: `Integration conflicts require a reviewed resolution: ${input.integration.conflicts.join(", ")}`, blocking: true });
  if (input.integration && !input.integration.assembled) findings.push({ ruleId: "integration.not-assembled", severity: "warning", message: "Multiple changes must be assembled before final verification.", blocking: true });
  if (input.reproducible === false) findings.push({ ruleId: "reproducibility.unknown", severity: "error", message: "Execution cannot be reproduced.", blocking: true });
  const release = input.releaseActorId ? mayRecordRelease(input.projection, input.releaseActorId, input.workerIds) : { ok: false, reason: "release_authority_not_supplied" };
  if (!release.ok) findings.push({ ruleId: "release.gate", severity: "error", message: release.reason ?? "Release is not eligible.", blocking: true });
  const verdict: VerificationVerdictV2 = findings.some((finding) => finding.blocking) ? "FAIL" : input.projection.verificationVerdict;
  return { verificationVerdict: verdict, findings, releaseEligible: release.ok && !findings.some((finding) => finding.blocking) };
}
