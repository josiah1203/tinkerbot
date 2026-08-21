import { expect, test } from "vitest";
import { assessFactoryChange, type FactoryProjection, type TaskContract, type WorkerContract, type WorkerReceipt } from "../packages/factory/src";

const projection: FactoryProjection = { verificationVerdict: "PASS", reviewDecision: "APPROVE", releaseDecision: "NOT_RELEASED", outcomeStatus: "PENDING", outcomeMaturity: "IMMATURE", eventCount: 4 };
const task: TaskContract = { taskId: "task", intentId: "intent", acceptanceCriteria: ["works"], dependencies: [], requiredCapability: ["implementation"], risk: "low", novelty: 0, requiredWorkerType: "agent", requiredReviewerType: "independent_agent", completionConditions: ["verified"] };
const contract: WorkerContract = { factoryId: "fac", intentId: "intent", workOrderId: "wo", taskId: "task", acceptanceCriteria: ["works"], nonGoals: [], allowedPaths: ["src"], risk: "low", novelty: 0, policyVersion: "p", requiredArtifacts: ["receipt"], requiredReviewer: "independent_agent" };
const receipt: WorkerReceipt = { workerId: "worker", sessionId: "s", changeRef: "c", filesChanged: ["src/a.ts"], modulesAffected: [], summary: "x", rationale: "x", assumptions: [], claims: [{ criterion: "works", status: "ATTESTED", value: "x" }], testsRun: [], checksNotRun: [], toolsUsed: [], dependenciesIntroduced: [], knownRisks: [], unverifiedClaims: [], followUps: [], costCents: 0, durationMs: 0, provenanceSignature: "sig" };

test("factory assurance blocks missing traceability and self-release without changing review state", () => {
  expect(assessFactoryChange({ projection, workerIds: ["worker"], releaseActorId: "worker" }).findings.map((finding) => finding.ruleId)).toContain("traceability.task-missing");
  const report = assessFactoryChange({ task, workerContract: contract, receipt, projection, workerIds: ["worker"], releaseActorId: "release-owner", integration: { conflicts: [], assembled: true }, reproducible: true });
  expect(report).toMatchObject({ verificationVerdict: "PASS", releaseEligible: true });
});
