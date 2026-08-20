import crypto from "node:crypto";
import type { IntegrationCandidate, TaskContract, WorkerContract, WorkerDefinition, WorkerReceipt } from "./graph";

export interface RegisteredWorker extends WorkerDefinition { provider?: string; model?: string; repositories: string[]; taskTypes: string[]; permissionScope: string[]; requiredReviewer: TaskContract["requiredReviewerType"]; costCentsPerHour?: number; }
export interface ExecutionCellPolicy { executionCellId: string; repositoryVersion: string; branchRef: string; dependencyDigest: string; toolManifest: string[]; permissionBoundary: string[]; secretPolicy: "none_in_contracts_or_logs"; networkPolicy: "disabled" | "allowlisted"; resourceBudget: { cpuSeconds: number; memoryMb: number }; reproducibilityDigest: string; cleanup: "destroy_after_completion" | "retain_for_review"; }
export interface AssemblyDecision { candidate: IntegrationCandidate; allowed: boolean; conflicts: string[]; requiredActions: string[]; }

export function validateWorkerContract(contract: WorkerContract): string[] {
  const missing: string[] = [];
  for (const field of ["factoryId", "intentId", "workOrderId", "taskId", "policyVersion", "requiredReviewer"] as const) if (!contract[field]) missing.push(field);
  if (!contract.acceptanceCriteria.length) missing.push("acceptanceCriteria");
  if (!contract.requiredArtifacts.length) missing.push("requiredArtifacts");
  if (contract.allowedPaths.some((value) => /secret|token|password|private[_-]?key/i.test(value))) missing.push("allowedPaths must never contain a secret reference");
  return missing;
}

export function verifyWorkerReceipt(receipt: WorkerReceipt, contract: WorkerContract): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const field of ["workerId", "sessionId", "changeRef", "summary", "rationale", "provenanceSignature"] as const) if (!receipt[field]) errors.push(field);
  if (receipt.costCents < 0 || receipt.durationMs < 0) errors.push("cost and duration must be non-negative");
  if (receipt.filesChanged.some((file) => !contract.allowedPaths.some((scope) => scope === "*" || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`)))) errors.push("receipt changed a file outside allowedPaths");
  for (const criterion of contract.acceptanceCriteria) if (!receipt.claims.some((claim) => claim.criterion === criterion)) errors.push(`missing claim for acceptance criterion: ${criterion}`);
  if (receipt.claims.some((claim) => claim.status === "DETERMINISTICALLY_VERIFIED")) errors.push("workers may report or attest claims; only assurance may mark deterministic verification");
  return { valid: errors.length === 0, errors };
}

export function createExecutionCellPolicy(input: Omit<ExecutionCellPolicy, "executionCellId" | "secretPolicy">): ExecutionCellPolicy {
  if (input.permissionBoundary.some((entry) => /secret|production-admin/i.test(entry))) throw new Error("execution_cell_permission_scope_rejected");
  return { ...input, executionCellId: `cell_${crypto.randomUUID().replace(/-/g, "")}`, secretPolicy: "none_in_contracts_or_logs" };
}

export function assembleIntegrationCandidate(input: { factoryId: string; changeSets: Array<{ changeSetId: string; files: string[]; risk: TaskContract["risk"] }>; }): AssemblyDecision {
  const owners = new Map<string, string[]>();
  for (const change of input.changeSets) for (const file of change.files) owners.set(file, [...(owners.get(file) ?? []), change.changeSetId]);
  const conflicts = [...owners.entries()].filter(([, ids]) => ids.length > 1).map(([file, ids]) => `${file}: ${ids.join(", ")}`);
  const highRisk = input.changeSets.some((change) => change.risk === "high" || change.risk === "critical");
  const candidate: IntegrationCandidate = { integrationCandidateId: `ic_${crypto.randomUUID().replace(/-/g, "")}`, factoryId: input.factoryId, changeSetIds: input.changeSets.map((change) => change.changeSetId), status: "created" };
  return { candidate, allowed: conflicts.length === 0, conflicts, requiredActions: [...(conflicts.length ? ["resolve_conflicts_as_new_change", "rerun_contract_tests", "rerun_full_verification"] : ["run_contract_tests", "run_full_verification"]), ...(highRisk ? ["independent_human_review"] : [])] };
}
