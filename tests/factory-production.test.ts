import { expect, test } from "vitest";
import { assembleIntegrationCandidate, createExecutionCellPolicy, validateWorkerContract, verifyWorkerReceipt, type WorkerContract, type WorkerReceipt } from "../packages/factory/src";

const contract: WorkerContract = { factoryId: "fac_1", intentId: "intent_1", workOrderId: "wo_1", taskId: "task_1", acceptanceCriteria: ["timezone is formatted correctly"], nonGoals: [], allowedPaths: ["src"], risk: "low", novelty: 0, policyVersion: "policy_1", requiredArtifacts: ["receipt"], requiredReviewer: "independent_agent" };
const receipt: WorkerReceipt = { workerId: "worker_1", sessionId: "session_1", changeRef: "commit_1", filesChanged: ["src/time.ts"], modulesAffected: ["time"], summary: "Fixed formatting", rationale: "Use the requested timezone", assumptions: [], claims: [{ criterion: "timezone is formatted correctly", status: "ATTESTED", value: "implemented" }], testsRun: ["pnpm test"], checksNotRun: [], toolsUsed: ["git"], dependenciesIntroduced: [], knownRisks: [], unverifiedClaims: [], followUps: [], costCents: 4, durationMs: 100, provenanceSignature: "sig" };

test("worker contracts and receipts are complete, scoped, and cannot self-verify", () => {
  expect(validateWorkerContract(contract)).toEqual([]);
  expect(verifyWorkerReceipt(receipt, contract)).toEqual({ valid: true, errors: [] });
  expect(verifyWorkerReceipt({ ...receipt, filesChanged: ["secrets.env"] }, contract).valid).toBe(false);
  expect(verifyWorkerReceipt({ ...receipt, claims: [{ ...receipt.claims[0]!, status: "DETERMINISTICALLY_VERIFIED" }] }, contract).valid).toBe(false);
});

test("execution cells and assembly protect secrets and conflicts", () => {
  expect(createExecutionCellPolicy({ repositoryVersion: "sha", branchRef: "tb/task", dependencyDigest: "sha256:x", toolManifest: ["git"], permissionBoundary: ["repo:write"], networkPolicy: "disabled", resourceBudget: { cpuSeconds: 60, memoryMb: 512 }, reproducibilityDigest: "sha256:y", cleanup: "destroy_after_completion" }).secretPolicy).toBe("none_in_contracts_or_logs");
  const candidate = assembleIntegrationCandidate({ factoryId: "fac_1", changeSets: [{ changeSetId: "c1", files: ["src/a.ts"], risk: "low" }, { changeSetId: "c2", files: ["src/a.ts"], risk: "high" }] });
  expect(candidate).toMatchObject({ allowed: false, conflicts: ["src/a.ts: c1, c2"] });
  expect(candidate.requiredActions).toContain("independent_human_review");
});
