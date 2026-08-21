import type { FactoryProjection, ReleaseDecisionV2, ReviewAssessmentV2, VerificationVerdictV2 } from "./graph";

export interface LegacyFactoryProjectionColumns {
  verificationVerdict?: string | null;
  reviewAssessment?: string | null;
  releaseDecision?: string | null;
}

export interface ProjectionShadowRead {
  checkedAt: string;
  expected: { verificationVerdict: VerificationVerdictV2; reviewAssessment: ReviewAssessmentV2; releaseDecision: "READY" | "BLOCKED" };
  observed: LegacyFactoryProjectionColumns;
  divergences: string[];
}

export function legacyColumnsForProjection(projection: FactoryProjection): ProjectionShadowRead["expected"] {
  return {
    verificationVerdict: projection.verificationVerdict,
    reviewAssessment: projection.reviewAssessment ?? "NOT_REVIEWED",
    releaseDecision: projection.releaseDecision === "RELEASE" ? "READY" : "BLOCKED",
  };
}

export function compareFactoryProjectionToLegacy(projection: FactoryProjection, legacy: LegacyFactoryProjectionColumns): string[] {
  const expected = legacyColumnsForProjection(projection);
  const divergences: string[] = [];
  if (legacy.verificationVerdict !== undefined && legacy.verificationVerdict !== null && String(legacy.verificationVerdict) !== expected.verificationVerdict) divergences.push(`verification_verdict:${String(legacy.verificationVerdict)}!=${expected.verificationVerdict}`);
  if (legacy.reviewAssessment !== undefined && legacy.reviewAssessment !== null && String(legacy.reviewAssessment) !== expected.reviewAssessment && !(expected.reviewAssessment === "NOT_REVIEWED" && String(legacy.reviewAssessment) === "NEEDS_HUMAN_REVIEW")) divergences.push(`review_assessment:${String(legacy.reviewAssessment)}!=${expected.reviewAssessment}`);
  if (legacy.releaseDecision !== undefined && legacy.releaseDecision !== null && String(legacy.releaseDecision) !== expected.releaseDecision) divergences.push(`release_decision:${String(legacy.releaseDecision)}!=${expected.releaseDecision}`);
  return divergences;
}

export function shadowReadFactoryProjection(projection: FactoryProjection, legacy: LegacyFactoryProjectionColumns, checkedAt = new Date().toISOString()): ProjectionShadowRead {
  return { checkedAt, expected: legacyColumnsForProjection(projection), observed: legacy, divergences: compareFactoryProjectionToLegacy(projection, legacy) };
}

export function shadowReadWindowSatisfied(startedAt: string, now = new Date().toISOString(), minimumDays = 7): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= minimumDays * 24 * 60 * 60 * 1000;
}

export function canonicalReleaseToLegacy(value: ReleaseDecisionV2): "READY" | "BLOCKED" {
  return value === "RELEASE" ? "READY" : "BLOCKED";
}
