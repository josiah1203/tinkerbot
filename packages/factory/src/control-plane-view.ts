export type VerificationVerdictView = "pass" | "blocked" | "fail" | "unknown" | "not_run";
export type ReviewDecisionView = "not_required" | "awaiting_human" | "approved" | "rejected" | "changes_requested";
export type ReleaseDecisionView = "not_eligible" | "awaiting_authorization" | "approved" | "hold" | "released" | "rolled_back" | "cancelled";
export type OutcomeStatusView = "pending" | "accepted" | "reworked" | "failed" | "rejected" | "unknown";
export type WorkOrderStageView = "intake" | "spec" | "build" | "test" | "verify" | "release";
export type WorkOrderGroupView = "blocked" | "awaiting_review" | "in_progress" | "ready" | "released" | "unknown";

export interface ActionCapability {
  id: string;
  label: string;
  allowed: boolean;
  reason?: string;
}

export interface WorkOrderView {
  id: string;
  workOrderId: string;
  title: string;
  factoryId: string;
  /** Canonical persisted state retained for API compatibility and filtering. */
  status?: string;
  repository?: { id: string; name: string };
  stage: WorkOrderStageView;
  actor?: { id: string; name: string; kind: "agent" | "human" | "system" };
  risk: "low" | "medium" | "high" | "critical" | "unknown";
  updatedAt: string;
  verificationVerdict: VerificationVerdictView;
  reviewDecision: ReviewDecisionView;
  releaseDecision: ReleaseDecisionView;
  outcomeStatus: OutcomeStatusView;
  unresolvedUnknownCount: number;
  latestRunId?: string;
  group: WorkOrderGroupView;
  availableActions: ActionCapability[];
  intent?: string;
  acceptanceCriteria?: string;
  sourceType?: string;
  sourceId?: string;
  branch?: string;
  commitSha?: string;
  blockedReason?: string;
}

const VERDICTS = new Set<VerificationVerdictView>(["pass", "blocked", "fail", "unknown", "not_run"]);
const REVIEWS = new Set<ReviewDecisionView>(["not_required", "awaiting_human", "approved", "rejected", "changes_requested"]);
const RELEASES = new Set<ReleaseDecisionView>(["not_eligible", "awaiting_authorization", "approved", "hold", "released", "rolled_back", "cancelled"]);
const OUTCOMES = new Set<OutcomeStatusView>(["pending", "accepted", "reworked", "failed", "rejected", "unknown"]);

export function normalizeVerificationVerdict(value: unknown, fallback: VerificationVerdictView = "unknown"): VerificationVerdictView {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "pass" || key === "passed") return "pass";
  if (key === "fail" || key === "failed") return "fail";
  if (key === "blocked") return "blocked";
  if (key === "not_run" || key === "notrun") return "not_run";
  if (key === "unknown" || key === "unmeasured") return "unknown";
  return VERDICTS.has(key as VerificationVerdictView) ? key as VerificationVerdictView : fallback;
}

export function normalizeReviewDecision(value: unknown, fallback: ReviewDecisionView = "awaiting_human"): ReviewDecisionView {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "clear") return "not_required";
  if (key === "needs_human_review" || key === "not_reviewed" || key === "pending") return "awaiting_human";
  if (key === "revise" || key === "changes_requested") return "changes_requested";
  if (key === "approve" || key === "approved") return "approved";
  if (key === "reject" || key === "rejected") return "rejected";
  return REVIEWS.has(key as ReviewDecisionView) ? key as ReviewDecisionView : fallback;
}

export function normalizeReleaseDecision(value: unknown, input: { verification: VerificationVerdictView; review: ReviewDecisionView; released?: boolean } = { verification: "unknown", review: "awaiting_human" }): ReleaseDecisionView {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (input.released || key === "release" || key === "released") return "released";
  if (key === "rolled_back" || key === "rollback") return "rolled_back";
  if (key === "cancelled" || key === "canceled") return "cancelled";
  if (key === "hold" || key === "held") return "hold";
  if (key === "approved" || key === "ready") return input.verification === "pass" && input.review === "approved" ? "awaiting_authorization" : "not_eligible";
  if (key === "awaiting_authorization" || key === "awaiting_approval") return "awaiting_authorization";
  return RELEASES.has(key as ReleaseDecisionView) ? key as ReleaseDecisionView : "not_eligible";
}

export function normalizeOutcomeStatus(value: unknown, fallback: OutcomeStatusView = "pending"): OutcomeStatusView {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "accepted" || key === "success" || key === "successful_release") return "accepted";
  if (key === "failed" || key === "fail") return "failed";
  if (key === "reworked") return "reworked";
  if (key === "rejected" || key === "reject") return "rejected";
  if (key === "unknown" || key === "unmeasured") return "unknown";
  return OUTCOMES.has(key as OutcomeStatusView) ? key as OutcomeStatusView : fallback;
}

export function stageView(value: unknown): WorkOrderStageView {
  const key = String(value ?? "intake").trim().toLowerCase();
  if (["intake", "triage", "foreman"].includes(key)) return "intake";
  if (["spec", "specification", "planning", "architecture"].includes(key)) return "spec";
  if (["build", "implementation", "building"].includes(key)) return "build";
  if (["test", "testing"].includes(key)) return "test";
  if (["verify", "verification", "review", "security"].includes(key)) return "verify";
  if (["release", "approval", "ready", "merged", "released", "complete", "outcome"].includes(key)) return "release";
  return "intake";
}

export function groupView(input: { status?: unknown; group?: unknown; verification: VerificationVerdictView; review: ReviewDecisionView; release: ReleaseDecisionView; outcome: OutcomeStatusView }): WorkOrderGroupView {
  const raw = String(input.group ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const status = String(input.status ?? "").trim().toLowerCase();
  if (["blocked", "needs_attention", "failed"].includes(raw) || ["blocked", "failed", "fail"].includes(status) || ["blocked", "fail"].includes(input.verification)) return "blocked";
  if (["released", "completed", "done"].includes(raw) || input.release === "released" || status === "released") return "released";
  if (raw === "unknown" || input.verification === "unknown" || input.outcome === "unknown") return "unknown";
  if (raw === "ready" || input.release === "awaiting_authorization" || input.release === "approved" || input.release === "hold") return "ready";
  if (["awaiting_review", "waiting_for_approval", "approval"].includes(raw) || input.review === "awaiting_human") return "awaiting_review";
  if (raw === "in_progress" || ["intake", "triage", "specification", "implementation", "review", "verification"].includes(status)) return "in_progress";
  return "unknown";
}
