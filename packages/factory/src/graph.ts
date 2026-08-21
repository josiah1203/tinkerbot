import crypto from "node:crypto";
import type { FactoryStageId, WorkOrderState } from "./index";
import { isLegalWorkOrderTransition } from "./transition-contract";

/** The provider-neutral, append-only source of truth for every Tinkerbot surface. */
export const FACTORY_EVENT_TYPES = [
  "factory.created", "objective.created", "intent.created", "intent.challenged", "intent.revised", "intent.approved", "intent.rejected", "intent.superseded",
  "spec.created", "spec.approved", "work_order.created", "work_order.transitioned", "task.decomposed", "task.queued", "task.assigned", "task.blocked", "task.started", "task.completed", "task.reworked",
  "worker.registered", "worker.session_started", "worker.claim_emitted", "worker.session_completed", "change.proposed", "change.updated", "integration_candidate.created", "integration_candidate.assembled",
  "verification.started", "verification.completed", "verification.recorded", "evidence.receipt_created", "review.requested", "review.completed", "review.recorded", "approval.requested", "approval.recorded", "release.requested", "release.completed", "release.decided", "release.executed", "release.rolled_back",
  "outcome.measurement_started", "outcome.observed", "outcome.matured", "incident.created", "capacity.updated", "cost.recorded", "autonomy.changed", "policy.updated", "external_reference.created", "external_command.received",
] as const;
export type FactoryEventType = (typeof FACTORY_EVENT_TYPES)[number];
export const LEGACY_FACTORY_EVENT_TYPES = ["verification.completed", "review.completed", "release.completed"] as const;
export type LegacyFactoryEventType = (typeof LEGACY_FACTORY_EVENT_TYPES)[number];
export const CANONICAL_FACTORY_EVENT_TYPES = ["verification.recorded", "review.recorded", "approval.requested", "approval.recorded", "release.requested", "release.decided", "release.executed", "release.rolled_back", "work_order.transitioned"] as const;
export type CanonicalFactoryEventType = (typeof CANONICAL_FACTORY_EVENT_TYPES)[number];
export const WORK_ORDER_TRANSITION_EVENT_TYPES = ["task.queued", "spec.created", "task.started", "review.requested", "verification.started", "task.blocked", "task.reworked", "integration_candidate.assembled"] as const;
export const FACTORY_COMMAND_BOUNDARY_EVENT_TYPES = [...CANONICAL_FACTORY_EVENT_TYPES, ...WORK_ORDER_TRANSITION_EVENT_TYPES, "change.proposed", "change.updated"] as const;
export function isFactoryCommandBoundaryEventType(type: FactoryEventType): boolean { return (FACTORY_COMMAND_BOUNDARY_EVENT_TYPES as readonly string[]).includes(type); }
export type VerificationVerdictV2 = "PASS" | "FAIL" | "UNKNOWN";
export type ReviewDecision = "NOT_REVIEWED" | "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";
export type ReviewAssessmentV2 = "NOT_REVIEWED" | "CLEAR" | "NEEDS_HUMAN_REVIEW" | "REVISE";
export type ReviewOutcome = "NO_FINDINGS" | "FINDINGS" | "ESCALATE";
export type ApprovalScope = "SPEC" | "RELEASE" | "ROLLBACK";
export type ApprovalOutcome = "GRANTED" | "DENIED";
export type ApprovalTargetOutcome = "RELEASE" | "HOLD" | "ROLLBACK";
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
export interface ChangeSet { changeSetId: string; taskId: string; sessionId: string; revision: string; files: string[]; workOrderId?: string; digest?: string; }
export interface ChangeSetScopePayload { workOrderId: string; changeSetId: string; changeSetDigest: string; }
export interface BranchRef { branchRefId: string; repositoryId: string; name: string; commitSha?: string; }
export interface PullRequestRef { pullRequestRefId: string; repositoryId: string; externalReferenceId: string; branchRefId: string; }
export interface IntegrationCandidate { integrationCandidateId: string; factoryId: string; changeSetIds: string[]; status: "created" | "assembled" | "verified" | "rejected"; }
export interface VerificationRun { verificationRunId: string; changeSetId: string; verdict: VerificationVerdictV2; deterministic: true; }
export interface EvidenceReceipt { evidenceReceiptId: string; verificationRunId: string; digest: string; provenance: ClaimStatus; }
export interface ReviewAssessmentRecord { reviewAssessmentId: string; changeSetId: string; reviewerId: string; decision?: ReviewDecision; outcome?: ReviewOutcome; independence: "SELF" | "INDEPENDENT_AGENT" | "SECOND_HUMAN" | "REQUIRED_HUMAN"; }
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
export interface IntegrationConnection { integrationConnectionId: string; organizationId: string; factoryId: string; provider: ExternalReference["provider"]; status: "active" | "paused" | "revoked"; secretRef?: string; createdAt: string; updatedAt: string; }
export interface AuditEvent { auditEventId: string; organizationId: string; factoryId: string; actorId: string; action: string; aggregateId?: string; correlationId: string; occurredAt: string; provenance: ClaimStatus; }

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
export type ReviewEventId = string & { readonly __factoryEventType: "review" };
export type ApprovalEventId = string & { readonly __factoryEventType: "approval" };
export function asReviewEventId(eventId: string): ReviewEventId { return eventId as ReviewEventId; }
export function asApprovalEventId(eventId: string): ApprovalEventId { return eventId as ApprovalEventId; }

export interface VerificationRecordedPayload {
  workOrderId: string;
  changeSetId: string;
  changeSetDigest: string;
  verificationRunId: string;
  verdict: VerificationVerdictV2;
  evidenceReceiptId?: string;
}
export interface ReviewRecordedPayload {
  workOrderId: string;
  changeSetId: string;
  changeSetDigest: string;
  reviewId: ReviewEventId;
  outcome: ReviewOutcome;
  reviewerId: string;
  independence: "SELF" | "INDEPENDENT_AGENT" | "SECOND_HUMAN" | "REQUIRED_HUMAN";
}
export interface ApprovalRequestedPayload {
  workOrderId: string;
  changeSetId?: string;
  changeSetDigest?: string;
  scope: ApprovalScope;
  requestId: string;
}
export type ApprovalRecordedPayload =
  | {
      workOrderId: string;
      changeSetId?: string;
      changeSetDigest?: string;
      approvalEventId: ApprovalEventId;
      scope: "SPEC";
      outcome: ApprovalOutcome;
      approverId: string;
      rationale?: string;
      releaseId?: never;
      targetOutcome?: never;
    }
  | {
      workOrderId: string;
      changeSetId: string;
      changeSetDigest: string;
      approvalEventId: ApprovalEventId;
      scope: "RELEASE";
      outcome: ApprovalOutcome;
      targetOutcome: "RELEASE" | "HOLD";
      approverId: string;
      rationale?: string;
      releaseId?: never;
    }
  | {
      workOrderId: string;
      changeSetId?: string;
      changeSetDigest: string;
      approvalEventId: ApprovalEventId;
      scope: "ROLLBACK";
      outcome: ApprovalOutcome;
      targetOutcome: "ROLLBACK";
      approverId: string;
      rationale?: string;
      releaseId: string;
    };
export interface ReleaseRequestedPayload {
  workOrderId: string;
  requestId: string;
  changeSetId?: string;
  changeSetDigest?: string;
}
export type ReleaseApprovalRef =
  | { kind: "release_approval"; eventId: ApprovalEventId; scope: "RELEASE"; targetOutcome: "RELEASE" | "HOLD"; changeSetDigest: string; releaseId?: never }
  | { kind: "release_approval"; eventId: ApprovalEventId; scope: "ROLLBACK"; targetOutcome: "ROLLBACK"; changeSetDigest: string; releaseId: string };
export interface ReleaseDecidedPayload {
  workOrderId: string;
  releaseId: string;
  outcome: Exclude<ReleaseDecisionV2, "NOT_RELEASED">;
  approvalRef: ReleaseApprovalRef;
  changeSetId?: string;
  changeSetDigest: string;
  reason?: string;
}
export interface ReleaseExecutedPayload { workOrderId: string; releaseId: string; changeSetDigest?: string; executionRef?: string; }
export interface ReleaseRolledBackPayload { workOrderId: string; releaseId: string; rollbackId?: string; reason?: string; }
export interface WorkOrderTransitionPayload { workOrderId: string; fromState: WorkOrderState; toState: WorkOrderState; causeId: string; currentStage: FactoryStageId | "complete"; }

export interface FactoryEvent<T = unknown> {
  eventId: string;
  type: FactoryEventType;
  aggregateId: string;
  aggregateType: string;
  organizationId: string;
  factoryId: string;
  actorId: string;
  actorType: "human" | "agent" | "system" | "integration";
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  aggregateSequence?: number;
  commandId?: string;
  idempotencyKey?: string;
  payloadFingerprint?: string;
  schemaVersion: 1;
  policyVersion?: string;
  provenance: ClaimStatus;
  externalReferences?: ExternalReference[];
  payload: T;
}

/** Disjoint canonical event envelopes used by command handlers. Legacy
 * `FactoryEvent` rows remain readable, but new binding events should be typed
 * through this union so a review cannot accidentally carry an approval or
 * release outcome payload. */
export type VerificationRecordedEvent = FactoryEvent<VerificationRecordedPayload> & { type: "verification.recorded" };
export type ReviewRecordedEvent = FactoryEvent<ReviewRecordedPayload> & { type: "review.recorded" };
export type ApprovalRequestedEvent = FactoryEvent<ApprovalRequestedPayload> & { type: "approval.requested" };
export type ApprovalRecordedEvent = FactoryEvent<ApprovalRecordedPayload> & { type: "approval.recorded" };
export type ReleaseRequestedEvent = FactoryEvent<ReleaseRequestedPayload> & { type: "release.requested" };
export type ReleaseDecidedEvent = FactoryEvent<ReleaseDecidedPayload> & { type: "release.decided" };
export type ReleaseExecutedEvent = FactoryEvent<ReleaseExecutedPayload> & { type: "release.executed" };
export type ReleaseRolledBackEvent = FactoryEvent<ReleaseRolledBackPayload> & { type: "release.rolled_back" };
export type WorkOrderTransitionEvent = FactoryEvent<WorkOrderTransitionPayload> & { type: "work_order.transitioned" };
export type CanonicalFactoryEvent = VerificationRecordedEvent | ReviewRecordedEvent | ApprovalRequestedEvent | ApprovalRecordedEvent | ReleaseRequestedEvent | ReleaseDecidedEvent | ReleaseExecutedEvent | ReleaseRolledBackEvent | WorkOrderTransitionEvent;

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isReviewOutcome(value: unknown): value is ReviewOutcome { return value === "NO_FINDINGS" || value === "FINDINGS" || value === "ESCALATE"; }
function isApprovalScope(value: unknown): value is ApprovalScope { return value === "SPEC" || value === "RELEASE" || value === "ROLLBACK"; }
function isApprovalOutcome(value: unknown): value is ApprovalOutcome { return value === "GRANTED" || value === "DENIED"; }
function isApprovalTargetOutcome(value: unknown): value is ApprovalTargetOutcome { return value === "RELEASE" || value === "HOLD" || value === "ROLLBACK"; }
function isReleaseOutcome(value: unknown): value is Exclude<ReleaseDecisionV2, "NOT_RELEASED"> { return value === "RELEASE" || value === "HOLD" || value === "ROLLBACK"; }

/** Guards domain authority before an event enters either local or hosted append-only storage. */
export function assertFactoryEventAuthority(event: FactoryEvent): void {
  const payload = isRecord(event.payload) ? event.payload : {};
  if ((event.type === "verification.completed" || event.type === "verification.recorded") && event.provenance !== "DETERMINISTICALLY_VERIFIED") throw new Error("only_deterministic_verification_may_write_verdict");
  if ((event.type === "approval.recorded" || event.type === "release.completed" || event.type === "release.decided") && event.actorType === "agent") throw new Error("worker_cannot_approve_or_release_own_work");
  if (event.type === "review.recorded") {
    if (payload.decision === "APPROVE" || payload.outcome === "APPROVE") throw new Error("review_event_cannot_grant_approval");
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.changeSetId) || !nonEmptyString(payload.changeSetDigest) || !nonEmptyString(payload.reviewId) || !isReviewOutcome(payload.outcome)) throw new Error("invalid_review_recorded_payload");
  }
  if (event.type === "verification.recorded") {
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.changeSetId) || !nonEmptyString(payload.changeSetDigest) || !nonEmptyString(payload.verificationRunId) || !["PASS", "FAIL", "UNKNOWN"].includes(String(payload.verdict))) throw new Error("invalid_verification_recorded_payload");
  }
  if (event.type === "change.proposed" || event.type === "change.updated") {
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.changeSetId) || !nonEmptyString(payload.changeSetDigest)) throw new Error("invalid_change_set_scope_payload");
  }
  if (event.type === "approval.requested") {
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.requestId) || !isApprovalScope(payload.scope)) throw new Error("invalid_approval_requested_payload");
  }
  if (event.type === "release.requested") {
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.requestId)) throw new Error("invalid_release_requested_payload");
  }
  if (event.type === "approval.recorded") {
    if (nonEmptyString(payload.decision)) {
      // Legacy approval rows remain readable during migration.
    } else {
      if (!nonEmptyString(payload.workOrderId) || payload.approvalEventId !== event.eventId || !isApprovalScope(payload.scope) || !isApprovalOutcome(payload.outcome) || !nonEmptyString(payload.approverId)) throw new Error("invalid_approval_recorded_payload");
      if (payload.scope === "SPEC") {
        if (payload.targetOutcome !== undefined || payload.releaseId !== undefined) throw new Error("invalid_spec_approval_scope");
      } else if (payload.scope === "RELEASE") {
        if (!isApprovalTargetOutcome(payload.targetOutcome) || !["RELEASE", "HOLD"].includes(payload.targetOutcome) || !nonEmptyString(payload.changeSetId) || !nonEmptyString(payload.changeSetDigest) || payload.releaseId !== undefined) throw new Error("invalid_release_approval_scope");
      } else if (payload.targetOutcome !== "ROLLBACK" || !nonEmptyString(payload.changeSetDigest) || !nonEmptyString(payload.releaseId)) {
        throw new Error("invalid_rollback_approval_scope");
      }
    }
  }
  if (event.type === "release.executed" && (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.releaseId))) throw new Error("invalid_release_executed_payload");
  if (event.type === "release.rolled_back" && (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.releaseId))) throw new Error("invalid_release_rolled_back_payload");
  if (event.type === "work_order.transitioned" && (!nonEmptyString(payload.workOrderId) || !isWorkOrderStateValue(payload.fromState) || !isWorkOrderStateValue(payload.toState) || !nonEmptyString(payload.causeId) || !isFactoryStageValue(payload.currentStage))) throw new Error("invalid_work_order_transition_payload");
  if (event.type === "release.decided") {
    if (!nonEmptyString(payload.workOrderId) || !nonEmptyString(payload.releaseId) || !nonEmptyString(payload.changeSetDigest) || !isReleaseOutcome(payload.outcome) || !isRecord(payload.approvalRef) || payload.approvalRef.kind !== "release_approval") throw new Error("invalid_release_decided_payload");
    const approvalRef = payload.approvalRef as Record<string, unknown>;
    if (!nonEmptyString(approvalRef.eventId) || !isApprovalScope(approvalRef.scope) || !isReleaseOutcome(approvalRef.targetOutcome) || approvalRef.targetOutcome !== payload.outcome) throw new Error("invalid_release_approval_reference");
    if (payload.outcome === "ROLLBACK" && !nonEmptyString(approvalRef.releaseId)) throw new Error("rollback_requires_active_release_reference");
    if (payload.outcome !== "ROLLBACK" && !nonEmptyString(approvalRef.changeSetDigest)) throw new Error("release_decision_requires_change_set_digest");
  }
  if (event.type === "outcome.observed" && payload.mature === false && payload.status === "POSITIVE") throw new Error("immature_outcome_cannot_be_positive");
}

/** New command-side code must use canonical event families; legacy families are read/migration-only. */
export function assertCanonicalFactoryEvent(event: FactoryEvent): void {
  if ((LEGACY_FACTORY_EVENT_TYPES as readonly string[]).includes(event.type)) throw new Error("legacy_factory_event_emission_forbidden");
  if (event.type === "approval.recorded" && isRecord(event.payload) && nonEmptyString(event.payload.decision)) throw new Error("legacy_approval_payload_emission_forbidden");
  assertFactoryEventAuthority(event);
}

function eventContext(input: {
  aggregateId: string;
  aggregateType?: string;
  organizationId: string;
  factoryId: string;
  actorId: string;
  actorType: FactoryEvent["actorType"];
  correlationId?: string;
  causationId?: string;
  occurredAt?: string;
  policyVersion?: string;
  provenance?: ClaimStatus;
  eventId?: string;
  commandId?: string;
  idempotencyKey?: string;
}): Omit<FactoryEvent, "type" | "payload"> {
  return {
    eventId: input.eventId ?? factoryId("evt"),
    aggregateId: input.aggregateId,
    aggregateType: input.aggregateType ?? "work_order",
    organizationId: input.organizationId,
    factoryId: input.factoryId,
    actorId: input.actorId,
    actorType: input.actorType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    correlationId: input.correlationId ?? input.aggregateId,
    causationId: input.causationId,
    policyVersion: input.policyVersion,
    provenance: input.provenance ?? "ATTESTED",
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    schemaVersion: 1,
  };
}

export function createVerificationRecordedEvent(input: Parameters<typeof eventContext>[0] & Omit<VerificationRecordedPayload, "workOrderId"> & { workOrderId?: string }): VerificationRecordedEvent {
  const base = eventContext(input);
  const event = { ...base, type: "verification.recorded" as const, provenance: "DETERMINISTICALLY_VERIFIED" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, verificationRunId: input.verificationRunId, verdict: input.verdict, evidenceReceiptId: input.evidenceReceiptId } };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createReviewRecordedEvent(input: Parameters<typeof eventContext>[0] & Omit<ReviewRecordedPayload, "workOrderId" | "reviewId"> & { workOrderId?: string; reviewId?: string }): ReviewRecordedEvent {
  const base = eventContext(input);
  const eventId = base.eventId;
  const event = { ...base, eventId, type: "review.recorded" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, reviewId: asReviewEventId(input.reviewId ?? eventId), reviewerId: input.reviewerId, outcome: input.outcome, independence: input.independence } };
  assertCanonicalFactoryEvent(event);
  return event;
}

type ApprovalRecordedEventInputBase = Parameters<typeof eventContext>[0] & { workOrderId?: string; approverId: string; rationale?: string };
export type ApprovalRecordedEventInput =
  | (ApprovalRecordedEventInputBase & { scope: "SPEC"; outcome: ApprovalOutcome; changeSetId?: string; changeSetDigest?: string; releaseId?: never; targetOutcome?: never })
  | (ApprovalRecordedEventInputBase & { scope: "RELEASE"; outcome: ApprovalOutcome; changeSetId: string; changeSetDigest: string; targetOutcome: "RELEASE" | "HOLD"; releaseId?: never })
  | (ApprovalRecordedEventInputBase & { scope: "ROLLBACK"; outcome: ApprovalOutcome; changeSetId?: string; changeSetDigest: string; targetOutcome: "ROLLBACK"; releaseId: string });

export function createApprovalRecordedEvent(input: ApprovalRecordedEventInput): ApprovalRecordedEvent {
  const base = eventContext(input);
  const common = { workOrderId: input.workOrderId ?? input.aggregateId, approvalEventId: asApprovalEventId(base.eventId), approverId: input.approverId, rationale: input.rationale };
  const payload: ApprovalRecordedPayload = input.scope === "SPEC"
    ? { ...common, scope: "SPEC", outcome: input.outcome, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest }
    : input.scope === "RELEASE"
      ? { ...common, scope: "RELEASE", outcome: input.outcome, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, targetOutcome: input.targetOutcome }
      : { ...common, scope: "ROLLBACK", outcome: input.outcome, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, targetOutcome: "ROLLBACK", releaseId: input.releaseId };
  const event = { ...base, type: "approval.recorded" as const, payload };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createApprovalRequestedEvent(input: Parameters<typeof eventContext>[0] & Omit<ApprovalRequestedPayload, "workOrderId" | "scope"> & { workOrderId?: string; scope: ApprovalScope }): ApprovalRequestedEvent {
  const base = eventContext(input);
  const event = { ...base, type: "approval.requested" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, scope: input.scope, requestId: input.requestId } };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createReleaseRequestedEvent(input: Parameters<typeof eventContext>[0] & Omit<ReleaseRequestedPayload, "workOrderId"> & { workOrderId?: string }): ReleaseRequestedEvent {
  const base = eventContext(input);
  const event = { ...base, type: "release.requested" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, requestId: input.requestId, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest } };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createReleaseDecisionEvent(input: Parameters<typeof eventContext>[0] & Omit<ReleaseDecidedPayload, "workOrderId"> & { workOrderId?: string }): ReleaseDecidedEvent {
  const base = eventContext(input);
  const event = { ...base, type: "release.decided" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, releaseId: input.releaseId, outcome: input.outcome, approvalRef: input.approvalRef, changeSetId: input.changeSetId, changeSetDigest: input.changeSetDigest, reason: input.reason } };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createReleaseExecutedEvent(input: Parameters<typeof eventContext>[0] & Omit<ReleaseExecutedPayload, "workOrderId"> & { workOrderId?: string }): ReleaseExecutedEvent {
  const base = eventContext(input);
  const event = { ...base, type: "release.executed" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, releaseId: input.releaseId, changeSetDigest: input.changeSetDigest, executionRef: input.executionRef } };
  assertCanonicalFactoryEvent(event);
  return event;
}

export function createReleaseRolledBackEvent(input: Parameters<typeof eventContext>[0] & Omit<ReleaseRolledBackPayload, "workOrderId"> & { workOrderId?: string }): ReleaseRolledBackEvent {
  const base = eventContext(input);
  const event = { ...base, type: "release.rolled_back" as const, payload: { workOrderId: input.workOrderId ?? input.aggregateId, releaseId: input.releaseId, rollbackId: input.rollbackId, reason: input.reason } };
  assertCanonicalFactoryEvent(event);
  return event;
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
  append<T = unknown>(event: Omit<FactoryEvent<T>, "eventId" | "occurredAt" | "schemaVersion"> & Partial<Pick<FactoryEvent, "eventId" | "occurredAt" | "schemaVersion">>): FactoryEvent<T> {
    const full = { ...event, eventId: event.eventId ?? factoryId("evt"), occurredAt: event.occurredAt ?? new Date().toISOString(), schemaVersion: 1 } as FactoryEvent<T>;
    if (isFactoryCommandBoundaryEventType(full.type)) throw new Error("factory_command_boundary_required");
    assertFactoryEventAuthority(full);
    if (this.events.some((item) => item.eventId === full.eventId)) throw new Error("duplicate_event_id");
    this.events.push(Object.freeze(full));
    return full;
  }
  all(): readonly FactoryEvent[] { return this.events; }
  byAggregate(aggregateId: string): readonly FactoryEvent[] { return this.events.filter((event) => event.aggregateId === aggregateId); }
  reconstruct(aggregateId: string): FactoryProjection { return projectFactoryEvents(this.byAggregate(aggregateId)); }
}

export interface FactoryProjection {
  aggregateId?: string;
  /** Compatibility route state, reconstructed from WorkOrder transition events. */
  workOrderState?: WorkOrderState;
  /** Compatibility stage, reconstructed from WorkOrder transition events. */
  currentStage?: FactoryStageId | "complete";
  currentActorId?: string;
  lastTransitionAt?: string;
  verificationVerdict: VerificationVerdictV2;
  reviewDecision: ReviewDecision;
  /** Canonical review projection; reviewDecision remains for legacy clients. */
  reviewAssessment?: ReviewAssessmentV2;
  releaseDecision: ReleaseDecisionV2;
  outcomeStatus: OutcomeStatus;
  outcomeMaturity: OutcomeMaturity;
  currentChangeSetId?: string;
  currentChangeSetDigest?: string;
  latestVerificationRunId?: string;
  releaseApprovalEventId?: ApprovalEventId;
  releaseApprovalScope?: ApprovalScope;
  releaseApprovalTargetOutcome?: ApprovalTargetOutcome;
  releaseApprovalDigest?: string;
  releaseId?: string;
  releaseExecuted?: boolean;
  eventCount: number;
}

function compareFactoryEvents(left: FactoryEvent, right: FactoryEvent): number {
  if (left.aggregateSequence !== undefined && right.aggregateSequence !== undefined && left.aggregateSequence !== right.aggregateSequence) return left.aggregateSequence - right.aggregateSequence;
  const occurred = left.occurredAt.localeCompare(right.occurredAt);
  return occurred || left.eventId.localeCompare(right.eventId);
}

function eventDigest(payload: Record<string, unknown>): string | undefined {
  const value = payload.changeSetDigest ?? payload.digest;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const WORK_ORDER_STATE_VALUES: readonly WorkOrderState[] = ["intake", "triage", "specification", "implementation", "review", "verification", "approval", "ready", "merged", "released", "blocked", "failed", "cancelled", "unknown"];
const FACTORY_STAGE_VALUES: readonly FactoryStageId[] = ["foreman", "triage", "specification", "architecture", "implementation", "test", "review", "security", "verification", "release", "outcome"];
function isWorkOrderStateValue(value: unknown): value is WorkOrderState { return typeof value === "string" && WORK_ORDER_STATE_VALUES.includes(value as WorkOrderState); }
function isFactoryStageValue(value: unknown): value is FactoryStageId | "complete" { return value === "complete" || (typeof value === "string" && FACTORY_STAGE_VALUES.includes(value as FactoryStageId)); }
function stageForWorkOrderState(state: WorkOrderState, prior?: FactoryStageId | "complete"): FactoryStageId | "complete" {
  if (state === "released" || state === "merged") return "complete";
  if (state === "ready" || state === "approval") return "release";
  return FACTORY_STAGE_VALUES.includes(state as FactoryStageId) ? state as FactoryStageId : prior ?? "foreman";
}

function reviewAssessmentForOutcome(value: unknown): ReviewAssessmentV2 {
  if (value === "NO_FINDINGS") return "CLEAR";
  if (value === "FINDINGS") return "REVISE";
  if (value === "ESCALATE") return "NEEDS_HUMAN_REVIEW";
  return "NOT_REVIEWED";
}

function digestMatchesCurrent(state: FactoryProjection, payload: Record<string, unknown>): boolean {
  const digest = eventDigest(payload);
  return !state.currentChangeSetDigest || !digest || state.currentChangeSetDigest === digest;
}

function stableEventPayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableEventPayload).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableEventPayload(record[key])}`).join(",")}}`;
}

function isIdempotentEventReplay(event: FactoryEvent, priorEvents: readonly FactoryEvent[]): boolean {
  return priorEvents.some((candidate) => candidate.type === event.type
    && stableEventPayload(candidate.payload) === stableEventPayload(event.payload)
    && typeof candidate.idempotencyKey === "string"
    && candidate.idempotencyKey === event.idempotencyKey
    && typeof candidate.payloadFingerprint === "string"
    && candidate.payloadFingerprint === event.payloadFingerprint);
}

export function projectFactoryEvents(events: readonly FactoryEvent[]): FactoryProjection {
  const isWorkOrder = events[0]?.aggregateType === "work_order";
  const state: FactoryProjection = { aggregateId: events[0]?.aggregateId, workOrderState: isWorkOrder ? "intake" : undefined, currentStage: isWorkOrder ? "foreman" : undefined, verificationVerdict: "UNKNOWN", reviewDecision: "NOT_REVIEWED", reviewAssessment: "NOT_REVIEWED", releaseDecision: "NOT_RELEASED", outcomeStatus: "UNMEASURED", outcomeMaturity: "IMMATURE", eventCount: events.length };
  for (const event of [...events].sort(compareFactoryEvents)) {
    const value = isRecord(event.payload) ? event.payload : {};
    if (event.aggregateType === "work_order") {
      if (event.type === "work_order.created") {
        if (isWorkOrderStateValue(value.status)) state.workOrderState = value.status;
        if (isFactoryStageValue(value.currentStage)) state.currentStage = value.currentStage;
        else if (state.workOrderState) state.currentStage = stageForWorkOrderState(state.workOrderState, state.currentStage);
        state.currentActorId = event.actorId;
        state.lastTransitionAt = event.occurredAt;
      }
      if (isWorkOrderStateValue(value.toState) && isWorkOrderStateValue(value.fromState)) {
        state.workOrderState = value.toState;
        state.currentStage = isFactoryStageValue(value.currentStage) ? value.currentStage : stageForWorkOrderState(value.toState, state.currentStage);
        state.currentActorId = event.actorId;
        state.lastTransitionAt = event.occurredAt;
      }
    }
    if (event.type === "change.proposed" || event.type === "change.updated") {
      const digest = eventDigest(value);
      const changeSetId = typeof value.changeSetId === "string" ? value.changeSetId : undefined;
      if (digest || changeSetId) {
        const newDigest = Boolean(digest && digest !== state.currentChangeSetDigest);
        const firstChangeSet = !state.currentChangeSetDigest && !state.currentChangeSetId;
        state.currentChangeSetDigest = digest;
        state.currentChangeSetId = changeSetId;
        if (newDigest || firstChangeSet) {
          state.verificationVerdict = "UNKNOWN";
          state.latestVerificationRunId = undefined;
          state.reviewAssessment = "NOT_REVIEWED";
          state.reviewDecision = "NOT_REVIEWED";
          state.releaseDecision = "NOT_RELEASED";
          state.releaseApprovalEventId = undefined;
          state.releaseApprovalScope = undefined;
          state.releaseApprovalTargetOutcome = undefined;
          state.releaseApprovalDigest = undefined;
          state.releaseId = undefined;
          state.releaseExecuted = false;
        }
      }
    }
    if (event.type === "verification.recorded" || event.type === "verification.completed") {
      if (digestMatchesCurrent(state, value)) {
        const digest = eventDigest(value);
        if (!state.currentChangeSetDigest && digest) state.currentChangeSetDigest = digest;
        if (!state.currentChangeSetId && typeof value.changeSetId === "string") state.currentChangeSetId = value.changeSetId;
        state.verificationVerdict = value.verdict === "PASS" || value.verdict === "FAIL" ? value.verdict : "UNKNOWN";
        if (typeof value.verificationRunId === "string") state.latestVerificationRunId = value.verificationRunId;
      }
    }
    if (event.type === "review.recorded" && digestMatchesCurrent(state, value)) {
      state.reviewAssessment = reviewAssessmentForOutcome(value.outcome);
    }
    if (event.type === "review.completed" && digestMatchesCurrent(state, value)) {
      const decision = ["APPROVE", "REQUEST_CHANGES", "ESCALATE"].includes(String(value.decision)) ? value.decision as ReviewDecision : "NOT_REVIEWED";
      state.reviewDecision = decision;
      state.reviewAssessment = decision === "APPROVE" ? "CLEAR" : decision === "REQUEST_CHANGES" ? "REVISE" : decision === "ESCALATE" ? "NEEDS_HUMAN_REVIEW" : "NOT_REVIEWED";
    }
    if (event.type === "approval.recorded") {
      const scope = value.scope ?? value.approvalScope;
      if (scope === "SPEC" && value.outcome === "GRANTED" && digestMatchesCurrent(state, value)) state.reviewDecision = "APPROVE";
      if ((scope === "RELEASE" || scope === "ROLLBACK") && value.outcome === "GRANTED" && digestMatchesCurrent(state, value)) {
        state.releaseApprovalEventId = asApprovalEventId(typeof value.approvalEventId === "string" ? value.approvalEventId : event.eventId);
        state.releaseApprovalScope = scope;
        if (isApprovalTargetOutcome(value.targetOutcome)) state.releaseApprovalTargetOutcome = value.targetOutcome;
        state.releaseApprovalDigest = eventDigest(value);
      }
      // Legacy approval rows are preserved for old client projections only.
      if (value.decision === "approved") {
        state.reviewDecision = "APPROVE";
        state.reviewAssessment = "CLEAR";
      }
    }
    if (event.type === "release.decided") {
      const outcome = value.outcome;
      if (isReleaseOutcome(outcome)) {
        state.releaseDecision = outcome;
        state.releaseId = typeof value.releaseId === "string" ? value.releaseId : state.releaseId;
        const approvalRef = isRecord(value.approvalRef) ? value.approvalRef : undefined;
        if (approvalRef?.eventId && typeof approvalRef.eventId === "string") state.releaseApprovalEventId = asApprovalEventId(approvalRef.eventId);
        if (approvalRef?.scope === "RELEASE" || approvalRef?.scope === "ROLLBACK") state.releaseApprovalScope = approvalRef.scope;
        if (isApprovalTargetOutcome(approvalRef?.targetOutcome)) state.releaseApprovalTargetOutcome = approvalRef.targetOutcome;
        if (typeof approvalRef?.changeSetDigest === "string") state.releaseApprovalDigest = approvalRef.changeSetDigest;
      }
    }
    if (event.type === "release.executed") state.releaseExecuted = true;
    if (event.type === "release.rolled_back") state.releaseExecuted = false;
    // Legacy release.completed is migration-only. Only an explicit RELEASE
    // payload can project RELEASE; HOLD and missing outcomes never do.
    if (event.type === "release.completed" && value.decision === "RELEASE") {
      state.releaseDecision = "RELEASE";
      state.releaseExecuted = true;
    }
    if (event.type === "outcome.measurement_started") state.outcomeStatus = "PENDING";
    if (event.type === "outcome.observed") state.outcomeStatus = (["POSITIVE", "NEUTRAL", "NEGATIVE"] as string[]).includes(String(value.status)) ? value.status as OutcomeStatus : "UNKNOWN";
    if (event.type === "outcome.matured") state.outcomeMaturity = value.closed ? "CLOSED" : "MATURE";
  }
  return state;
}

/** Enforces the small set of execution edges that cannot be inferred from a
 * projection column alone. The command boundary calls this with the ordered
 * history plus the current command batch; stores use it before direct legacy
 * transition adapters append their translated event. */
export function assertFactoryEventOrdering(event: FactoryEvent, priorEvents: readonly FactoryEvent[]): void {
  const priorProjection = projectFactoryEvents(priorEvents);
  const payload = isRecord(event.payload) ? event.payload : {};
  if (isWorkOrderStateValue(payload.fromState) && isWorkOrderStateValue(payload.toState)) {
    if (!isLegalWorkOrderTransition(payload.fromState, payload.toState)) throw new Error("invalid_work_order_transition");
    if (priorProjection.workOrderState && payload.fromState !== priorProjection.workOrderState) throw new Error("work_order_transition_source_mismatch");
  }
  const digest = eventDigest(payload);
  const historicalVerification = event.type === "verification.recorded"
    && Boolean(priorProjection.currentChangeSetDigest && digest && digest !== priorProjection.currentChangeSetDigest);
  if (["verification.recorded", "review.recorded", "approval.recorded", "release.decided"].includes(event.type) && !(event.type === "approval.recorded" && (payload.scope ?? payload.approvalScope) === "ROLLBACK") && !(event.type === "release.decided" && payload.outcome === "ROLLBACK")) {
    if (!historicalVerification && priorProjection.currentChangeSetDigest && digest && digest !== priorProjection.currentChangeSetDigest) throw new Error("stale_change_set");
  }
  if (priorProjection.releaseDecision === "RELEASE" && ["verification.recorded", "review.recorded", "release.decided"].includes(event.type)) {
    if (!historicalVerification) {
      const sameReleaseReplay = isIdempotentEventReplay(event, priorEvents);
      const rollbackApproval = event.type === "release.decided" && payload.outcome === "ROLLBACK";
      if (!rollbackApproval && !sameReleaseReplay && (!digest || digest !== priorProjection.currentChangeSetDigest)) throw new Error("stale_change_set_after_release");
      if (!rollbackApproval && !sameReleaseReplay) throw new Error("non_idempotent_event_after_release");
    }
  }
  if (priorProjection.releaseDecision === "RELEASE" && event.type === "approval.recorded" && (payload.scope ?? payload.approvalScope) !== "ROLLBACK") throw new Error("release_approval_closed_after_release");
  if (event.type === "release.decided") {
    const projection = priorProjection;
    if (payload.outcome === "RELEASE" || payload.outcome === "HOLD") {
      if (projection.verificationVerdict !== "PASS") throw new Error("release_requires_current_deterministic_pass");
      if (projection.reviewAssessment !== "CLEAR" && projection.reviewDecision !== "APPROVE") throw new Error("release_requires_current_review_clear");
      if (projection.currentChangeSetDigest && payload.changeSetDigest !== projection.currentChangeSetDigest) throw new Error("release_decision_stale_change_set");
    }
    if (payload.outcome === "ROLLBACK" && (projection.releaseDecision !== "RELEASE" || !projection.releaseExecuted || projection.releaseId !== payload.releaseId)) throw new Error("rollback_requires_executed_release");
  }
  if (event.type === "release.executed") {
    const payload = isRecord(event.payload) ? event.payload : {};
    const projection = projectFactoryEvents(priorEvents);
    if (priorEvents.some((candidate) => candidate.type === "release.executed") && !isIdempotentEventReplay(event, priorEvents)) throw new Error("release_execution_already_recorded");
    if (projection.releaseDecision !== "RELEASE" || (projection.releaseId && projection.releaseId !== payload.releaseId)) throw new Error("release_execution_requires_release_decision");
  }
  if (event.type === "release.rolled_back") {
    const payload = isRecord(event.payload) ? event.payload : {};
    const projection = projectFactoryEvents(priorEvents);
    if (priorEvents.some((candidate) => candidate.type === "release.rolled_back") && !isIdempotentEventReplay(event, priorEvents)) throw new Error("rollback_execution_already_recorded");
    if (projection.releaseDecision !== "ROLLBACK" || (projection.releaseId && projection.releaseId !== payload.releaseId)) throw new Error("rollback_execution_requires_rollback_decision");
  }
}

export function mayRecordRelease(state: FactoryProjection, actorId: string, workerIds: readonly string[], options?: { approvalEventId?: string; changeSetDigest?: string }): { ok: boolean; reason?: string } {
  if (workerIds.includes(actorId)) return { ok: false, reason: "worker_cannot_approve_or_release_own_work" };
  if (state.verificationVerdict !== "PASS") return { ok: false, reason: "deterministic_verification_not_passed" };
  if (state.reviewAssessment !== undefined ? state.reviewAssessment !== "CLEAR" : state.reviewDecision !== "APPROVE") return { ok: false, reason: "independent_approval_required" };
  if (options?.approvalEventId && state.releaseApprovalEventId !== options.approvalEventId) return { ok: false, reason: "release_approval_reference_required" };
  if (options?.changeSetDigest && state.currentChangeSetDigest !== options.changeSetDigest) return { ok: false, reason: "stale_change_set" };
  return { ok: true };
}

export function calculateFactoryEconomics(events: readonly FactoryEvent[]): { cogsCents: number; copqCents: number; acceptedChanges: number; unrevertedChanges: number; outcomePositiveChanges: number; costPerAcceptedUnrevertedOutcomePositiveChange: number | null } {
  let cogsCents = 0; let copqCents = 0; let accepted = 0; let rolledBack = 0; let positive = 0;
  for (const event of events) {
    const data = isRecord(event.payload) ? event.payload : {};
    if (event.type === "cost.recorded") {
      const cents = Number(data.costCents ?? 0);
      cogsCents += cents;
      if (["internal_failure", "external_failure"].includes(String(data.copqCategory))) copqCents += cents;
    }
    if (event.type === "approval.recorded" && (data.decision === "approved" || ((data.scope ?? data.approvalScope) === "RELEASE" && data.outcome === "GRANTED"))) accepted += 1;
    if (event.type === "release.rolled_back" || (event.type === "release.decided" && data.outcome === "ROLLBACK")) rolledBack += 1;
    if (event.type === "outcome.observed" && data.status === "POSITIVE" && data.mature === true) positive += 1;
  }
  const denominator = Math.min(Math.max(accepted - rolledBack, 0), positive);
  return { cogsCents, copqCents, acceptedChanges: accepted, unrevertedChanges: Math.max(accepted - rolledBack, 0), outcomePositiveChanges: positive, costPerAcceptedUnrevertedOutcomePositiveChange: denominator ? (cogsCents + copqCents) / denominator : null };
}

export interface IntegrationCommand { command: "plan" | "challenge" | "status" | "assign" | "run" | "verify" | "evidence" | "review" | "approve" | "release" | "explain" | "why" | "cost" | "outcome" | "pause" | "resume"; raw: string; }
export function parseIntegrationCommand(raw: string): IntegrationCommand | undefined { const match = raw.trim().match(/^@tinkerbot\s+(plan|challenge|status|assign|run|verify|evidence|review|approve|release|explain|why|cost|outcome|pause|resume)\b/i); return match ? { command: match[1].toLowerCase() as IntegrationCommand["command"], raw } : undefined; }
export function integrationReply(input: { status: string; controlPlaneUrl: string }): string { return `${input.status}\nTinkerbot: ${input.controlPlaneUrl}`; }

/** Converts legacy WorkOrder state transitions into canonical graph events during migration. */
export function graphEventForWorkOrderTransition(input: { workOrderId: string; factoryId: string; organizationId: string; actor: string; policyVersion: string; fromState: string; toState: string; causeId: string; createdAt: string; currentStage?: string; definitionDigest?: string; changeSetId?: string; changeSetDigest?: string }): FactoryEvent {
  const eventType: Partial<Record<string, FactoryEventType>> = {
    triage: "task.queued", specification: "spec.created", implementation: "task.started", review: "review.requested", verification: "verification.started", approval: "approval.requested", ready: "release.requested", merged: "integration_candidate.assembled", released: "release.executed", blocked: "task.blocked", failed: "task.reworked",
  };
  const type = eventType[input.toState] ?? "work_order.transitioned";
  const normalizedToState = isWorkOrderStateValue(input.toState) ? input.toState : "unknown";
  const currentStage = isFactoryStageValue(input.currentStage) ? input.currentStage : stageForWorkOrderState(normalizedToState);
  const payload: Record<string, unknown> = { fromState: input.fromState, toState: input.toState, workOrderId: input.workOrderId, causeId: input.causeId, currentStage };
  if (type === "approval.requested") Object.assign(payload, { requestId: input.causeId, scope: "SPEC" });
  if (type === "release.requested") Object.assign(payload, { requestId: input.causeId, changeSetId: input.changeSetId ?? input.workOrderId, changeSetDigest: input.changeSetDigest ?? input.definitionDigest });
  if (type === "release.executed") Object.assign(payload, { releaseId: `release_${input.workOrderId}`, changeSetDigest: input.changeSetDigest ?? input.definitionDigest });
  return { eventId: `transition_${input.workOrderId}_${input.fromState}_${input.toState}_${input.causeId}`, type, aggregateId: input.workOrderId, aggregateType: "work_order", organizationId: input.organizationId, factoryId: input.factoryId, actorId: input.actor, actorType: "system", occurredAt: input.createdAt, correlationId: input.causeId, causationId: input.causeId, schemaVersion: 1, policyVersion: input.policyVersion, provenance: "ATTESTED", payload };
}
