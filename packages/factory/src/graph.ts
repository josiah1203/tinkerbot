import crypto from "node:crypto";

/** The provider-neutral, append-only source of truth for every Tinkerbot surface. */
export const FACTORY_EVENT_TYPES = [
  "factory.created", "objective.created", "intent.created", "intent.challenged", "intent.revised", "intent.approved", "intent.rejected", "intent.superseded",
  "spec.created", "spec.approved", "work_order.created", "task.decomposed", "task.queued", "task.assigned", "task.blocked", "task.started", "task.completed", "task.reworked",
  "worker.registered", "worker.session_started", "worker.claim_emitted", "worker.session_completed", "change.proposed", "change.updated", "integration_candidate.created", "integration_candidate.assembled",
  "verification.started", "verification.completed", "evidence.receipt_created", "review.requested", "review.completed", "approval.recorded", "release.requested", "release.completed", "release.rolled_back",
  "outcome.measurement_started", "outcome.observed", "outcome.matured", "incident.created", "capacity.updated", "cost.recorded", "autonomy.changed", "policy.updated", "external_reference.created", "external_command.received",
] as const;
export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];
export type VerificationVerdictV2 = "PASS" | "FAIL" | "UNKNOWN";
export type ReviewDecision = "NOT_REVIEWED" | "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";
export type ReleaseDecisionV2 = "NOT_RELEASED" | "RELEASE" | "HOLD" | "ROLLBACK";
export type OutcomeStatus = "UNMEASURED" | "PENDING" | "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN";
export type OutcomeMaturity = "IMMATURE" | "MATURE" | "CLOSED";
export type ClaimStatus = "REPORTED" | "ATTESTED" | "DETERMINISTICALLY_VERIFIED" | "HUMAN_VERIFIED" | "UNKNOWN";
export type IntentMode = "micro" | "standard" | "strategic";
export type AutonomyLevel = "ASSIST" | "EXECUTE" | "INTEGRATE" | "CONDITIONAL_AUTONOMY" | "HUMAN_CONTROLLED";
export type CapacityBand = "AVAILABLE" | "PROTECTED" | "AT_RISK" | "OVERLOADED" | "UNAVAILABLE";

/** Stable Factory Graph objects. Adapters refer to these IDs; they never own parallel state. */
export interface Organization { organizationId: string; name: string; }
export interface Factory { factoryId: string; organizationId: string; name: string; policyVersion: string; }
export interface Repository { repositoryId: string; factoryId: string; name: string; defaultBranch: string; }
export interface Objective { objectiveId: string; factoryId: string; title: string; ownerId: string; }
export interface DecisionRecord { decisionRecordId: string; intentId: string; ownerId: string; decision: "approved" | "rejected" | "deferred"; rationale: string; }
export interface Spec { specId: string; intentId: string; version: number; acceptanceCriteria: string[]; status: "draft" | "approved" | "rejected"; }
export interface WorkOrderNode { workOrderId: string; specId: string; intentId: string; factoryId: string; status: string; }
export interface Task { taskId: string; workOrderId: string; parentTaskId?: string; status: "queued" | "assigned" | "blocked" | "started" | "completed" | "reworked"; }
export interface TaskDependency { taskDependencyId: string; taskId: string; dependsOnTaskId: string; }
export interface Assignment { assignmentId: string; taskId: string; workerId: string; assignedAt: string; }
export interface WorkerDefinition { workerId: string; kind: "human" | "agent"; capabilities: string[]; concurrencyLimit: number; autonomy: AutonomyLevel; }
export interface WorkerCapability { capabilityId: string; workerId: string; name: string; repositoryId?: string; reliability: number; }
export interface WorkerSession { sessionId: string; workerId: string; taskId: string; executionCellId: string; status: "active" | "completed" | "failed"; }
export interface ExecutionCell { executionCellId: string; repositoryId: string; branchRef: string; permissionScope: string; networkPolicy: string; resourceBudget: string; cleanupAt: string; }
export interface ChangeSet { changeSetId: string; taskId: string; sessionId: string; revision: string; files: string[]; }
export interface BranchRef { branchRefId: string; repositoryId: string; name: string; commitSha?: string; }
export interface PullRequestRef { pullRequestRefId: string; repositoryId: string; externalReferenceId: string; branchRefId: string; }
export interface IntegrationCandidate { integrationCandidateId: string; factoryId: string; changeSetIds: string[]; status: "created" | "assembled" | "verified" | "rejected"; }
export interface VerificationRun { verificationRunId: string; changeSetId: string; verdict: VerificationVerdictV2; deterministic: true; }
export interface EvidenceReceipt { evidenceReceiptId: string; verificationRunId: string; digest: string; provenance: ClaimStatus; }
export interface ReviewAssessmentRecord { reviewAssessmentId: string; changeSetId: string; reviewerId: string; decision: ReviewDecision; independence: "SELF" | "INDEPENDENT_AGENT" | "SECOND_HUMAN" | "REQUIRED_HUMAN"; }
export interface ApprovalDecision { approvalDecisionId: string; workOrderId: string; approverId: string; decision: "approved" | "rejected"; }
export interface Release { releaseId: string; workOrderId: string; authorityId: string; decision: ReleaseDecisionV2; }
export interface OutcomePlan { outcomePlanId: string; intentId: string; baseline: string; target: string; measurementWindow: string; }
export interface OutcomeObservation { outcomeObservationId: string; releaseId: string; status: OutcomeStatus; maturity: OutcomeMaturity; sampleSize?: number; confidence?: number; }
export interface Incident { incidentId: string; releaseId?: string; severity: "low" | "medium" | "high" | "critical"; }
export interface Rollback { rollbackId: string; releaseId: string; reason: string; }
export interface PolicyVersion { policyVersionId: string; factoryId: string; version: string; digest: string; }
export interface AutonomyProfile { autonomyProfileId: string; workerId?: string; taskId?: string; level: AutonomyLevel; novelty: number; }
export interface CapacitySnapshot { capacitySnapshotId: string; factoryId: string; subjectId: string; band: CapacityBand; attentionDebt: number; }
export interface CostEvent { costEventId: string; workOrderId?: string; category: "cogs" | "prevention" | "appraisal" | "internal_failure" | "external_failure"; costCents: number; }
export interface QualityEvent { qualityEventId: string; workOrderId: string; kind: "rework" | "rollback" | "defect_escape" | "first_pass"; }

export interface IntentContract {
  intentId: string; mode: IntentMode; title: string; why: string; expectedBehavior: string;
  objectiveId?: string; acceptanceCriteria?: string[]; nonGoals?: string[]; risk?: "low" | "medium" | "high" | "critical";
  expectedOutcome?: string; baselineMetric?: string; targetMetric?: string; measurementWindow?: string;
  supportingEvidence?: string[]; assumptions?: string[]; alternatives?: string[]; constraints?: string[];
  decisionOwner?: string; requiredApprovers?: string[]; killCriteria?: string[]; reviewDate?: string;
}
export interface TaskContract {
  taskId: string; intentId: string; acceptanceCriteria: string[]; dependencies: string[]; requiredCapability: string[];
  expectedEffort?: string; expectedDuration?: string; risk: "low" | "medium" | "high" | "critical"; novelty: number;
  requiredWorkerType: "human" | "agent" | "hybrid"; requiredReviewerType: "self" | "independent_agent" | "human";
  integrationContract?: string; completionConditions: string[]; rollbackPlan?: string;
}
export interface WorkerContract { factoryId: string; intentId: string; decisionRecordId?: string; specId?: string; workOrderId: string; taskId: string; acceptanceCriteria: string[]; nonGoals: string[]; allowedPaths: string[]; risk: string; novelty: number; policyVersion: string; budget?: { usdCents?: number; tokens?: number }; deadline?: string; requiredArtifacts: string[]; requiredReviewer: string; }
export interface WorkerReceipt { workerId: string; sessionId: string; changeRef: string; filesChanged: string[]; modulesAffected: string[]; summary: string; rationale: string; assumptions: string[]; claims: Array<{ criterion: string; status: ClaimStatus; value: string }>; testsRun: string[]; checksNotRun: string[]; toolsUsed: string[]; dependenciesIntroduced: string[]; knownRisks: string[]; unverifiedClaims: string[]; followUps: string[]; costCents: number; durationMs: number; provider?: string; model?: string; provenanceSignature: string; }
export interface ExternalReference { externalReferenceId: string; provider: "github" | "slack" | "jira" | "linear" | "webhook"; externalId: string; aggregateId: string; url?: string; }
export interface FactoryEvent<T = Record<string, unknown>> { eventId: string; type: FactoryEventType; aggregateId: string; aggregateType: string; organizationId: string; factoryId: string; actorId: string; actorType: "human" | "agent" | "system" | "integration"; occurredAt: string; correlationId: string; causationId?: string; schemaVersion: 1; policyVersion?: string; provenance: ClaimStatus; externalReferences?: ExternalReference[]; payload: T; }

/** Guards domain authority before an event enters either local or hosted append-only storage. */
export function assertFactoryEventAuthority(event: FactoryEvent): void {
  if (event.type === "verification.completed" && event.provenance !== "DETERMINISTICALLY_VERIFIED") throw new Error("only_deterministic_verification_may_write_verdict");
  if ((event.type === "approval.recorded" || event.type === "release.completed") && event.actorType === "agent") throw new Error("worker_cannot_approve_or_release_own_work");
  if (event.type === "outcome.observed" && (event.payload as Record<string, unknown>).mature === false && (event.payload as Record<string, unknown>).status === "POSITIVE") throw new Error("immature_outcome_cannot_be_positive");
}

export function factoryId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`; }
export function createMicroIntent(title: string, why = title): IntentContract { return { intentId: factoryId("intent"), mode: "micro", title, why, expectedBehavior: `Change behaves as requested: ${title}`, acceptanceCriteria: [`${title} is complete`], risk: "low" }; }
export function validateIntent(intent: IntentContract): string[] {
  const missing = !intent.why || !intent.expectedBehavior ? ["why and expectedBehavior are required"] : [];
  if (intent.mode !== "micro") for (const field of ["objectiveId", "acceptanceCriteria", "nonGoals", "risk", "expectedOutcome"] as const) if (!intent[field] || (Array.isArray(intent[field]) && !intent[field].length)) missing.push(`${field} is required for ${intent.mode}`);
  if (intent.mode === "strategic") for (const field of ["baselineMetric", "targetMetric", "measurementWindow", "decisionOwner", "killCriteria"] as const) if (!intent[field] || (Array.isArray(intent[field]) && !intent[field].length)) missing.push(`${field} is required for strategic intent`);
  return missing;
}

export class FactoryEventLedger {
  private readonly events: FactoryEvent[] = [];
  append<T extends Record<string, unknown>>(event: Omit<FactoryEvent<T>, "eventId" | "occurredAt" | "schemaVersion"> & Partial<Pick<FactoryEvent, "eventId" | "occurredAt" | "schemaVersion">>): FactoryEvent<T> {
    const full = { ...event, eventId: event.eventId ?? factoryId("evt"), occurredAt: event.occurredAt ?? new Date().toISOString(), schemaVersion: 1 } as FactoryEvent<T>;
    assertFactoryEventAuthority(full);
    if (this.events.some((item) => item.eventId === full.eventId)) throw new Error("duplicate_event_id");
    this.events.push(Object.freeze(full));
    return full;
  }
  all(): readonly FactoryEvent[] { return this.events; }
  byAggregate(aggregateId: string): readonly FactoryEvent[] { return this.events.filter((event) => event.aggregateId === aggregateId); }
  reconstruct(aggregateId: string): FactoryProjection { return projectFactoryEvents(this.byAggregate(aggregateId)); }
}

export interface FactoryProjection { aggregateId?: string; verificationVerdict: VerificationVerdictV2; reviewDecision: ReviewDecision; releaseDecision: ReleaseDecisionV2; outcomeStatus: OutcomeStatus; outcomeMaturity: OutcomeMaturity; eventCount: number; }
export function projectFactoryEvents(events: readonly FactoryEvent[]): FactoryProjection {
  const state: FactoryProjection = { aggregateId: events[0]?.aggregateId, verificationVerdict: "UNKNOWN", reviewDecision: "NOT_REVIEWED", releaseDecision: "NOT_RELEASED", outcomeStatus: "UNMEASURED", outcomeMaturity: "IMMATURE", eventCount: events.length };
  for (const event of events) {
    const value = event.payload as Record<string, unknown>;
    if (event.type === "verification.completed") state.verificationVerdict = value.verdict === "PASS" || value.verdict === "FAIL" ? value.verdict : "UNKNOWN";
    if (event.type === "review.completed") state.reviewDecision = (["APPROVE", "REQUEST_CHANGES", "ESCALATE"] as string[]).includes(String(value.decision)) ? value.decision as ReviewDecision : "NOT_REVIEWED";
    if (event.type === "approval.recorded" && value.decision === "approved") state.reviewDecision = "APPROVE";
    if (event.type === "release.completed") state.releaseDecision = "RELEASE";
    if (event.type === "release.rolled_back") state.releaseDecision = "ROLLBACK";
    if (event.type === "outcome.measurement_started") state.outcomeStatus = "PENDING";
    if (event.type === "outcome.observed") state.outcomeStatus = (["POSITIVE", "NEUTRAL", "NEGATIVE"] as string[]).includes(String(value.status)) ? value.status as OutcomeStatus : "UNKNOWN";
    if (event.type === "outcome.matured") state.outcomeMaturity = value.closed ? "CLOSED" : "MATURE";
  }
  return state;
}

export function mayRecordRelease(state: FactoryProjection, actorId: string, workerIds: readonly string[]): { ok: boolean; reason?: string } {
  if (workerIds.includes(actorId)) return { ok: false, reason: "worker_cannot_approve_or_release_own_work" };
  if (state.verificationVerdict !== "PASS") return { ok: false, reason: "deterministic_verification_not_passed" };
  if (state.reviewDecision !== "APPROVE") return { ok: false, reason: "independent_approval_required" };
  return { ok: true };
}

export function calculateFactoryEconomics(events: readonly FactoryEvent[]): { cogsCents: number; copqCents: number; acceptedChanges: number; unrevertedChanges: number; outcomePositiveChanges: number; costPerAcceptedUnrevertedOutcomePositiveChange: number | null } {
  let cogsCents = 0; let copqCents = 0; let accepted = 0; let rolledBack = 0; let positive = 0;
  for (const event of events) { const data = event.payload as Record<string, unknown>; if (event.type === "cost.recorded") { const cents = Number(data.costCents ?? 0); cogsCents += cents; if (["internal_failure", "external_failure"].includes(String(data.copqCategory))) copqCents += cents; } if (event.type === "approval.recorded" && data.decision === "approved") accepted += 1; if (event.type === "release.rolled_back") rolledBack += 1; if (event.type === "outcome.observed" && data.status === "POSITIVE" && data.mature === true) positive += 1; }
  const denominator = Math.min(Math.max(accepted - rolledBack, 0), positive);
  return { cogsCents, copqCents, acceptedChanges: accepted, unrevertedChanges: Math.max(accepted - rolledBack, 0), outcomePositiveChanges: positive, costPerAcceptedUnrevertedOutcomePositiveChange: denominator ? (cogsCents + copqCents) / denominator : null };
}

export interface IntegrationCommand { command: "plan" | "challenge" | "status" | "assign" | "run" | "verify" | "evidence" | "review" | "approve" | "release" | "explain" | "why" | "cost" | "outcome" | "pause" | "resume"; raw: string; }
export function parseIntegrationCommand(raw: string): IntegrationCommand | undefined { const match = raw.trim().match(/^@tinkerbot\s+(plan|challenge|status|assign|run|verify|evidence|review|approve|release|explain|why|cost|outcome|pause|resume)\b/i); return match ? { command: match[1].toLowerCase() as IntegrationCommand["command"], raw } : undefined; }
export function integrationReply(input: { status: string; controlPlaneUrl: string }): string { return `${input.status}\nTinkerbot: ${input.controlPlaneUrl}`; }

/** Converts legacy WorkOrder state transitions into canonical graph events during migration. */
export function graphEventForWorkOrderTransition(input: { workOrderId: string; factoryId: string; organizationId: string; actor: string; policyVersion: string; fromState: string; toState: string; causeId: string; createdAt: string }): FactoryEvent | undefined {
  const eventType: Partial<Record<string, FactoryEventType>> = {
    triage: "task.queued", specification: "spec.created", implementation: "task.started", review: "review.requested", verification: "verification.started", approval: "review.completed", ready: "release.requested", merged: "integration_candidate.assembled", released: "release.completed", blocked: "task.blocked", failed: "task.reworked",
  };
  const type = eventType[input.toState];
  if (!type) return undefined;
  return { eventId: `legacy_${input.workOrderId}_${input.fromState}_${input.toState}_${input.causeId}`, type, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: input.factoryId, actorId: input.actor, actorType: "system", occurredAt: input.createdAt, correlationId: input.causeId, causationId: input.causeId, schemaVersion: 1, policyVersion: input.policyVersion, provenance: "ATTESTED", payload: { fromState: input.fromState, toState: input.toState } };
}
