import type { AutonomyMode, ProductionLineId, RiskLevel } from "./os";
import type { ApprovalMode } from "./runtime";
import type { InlineApprovalRecord } from "./store";

export function mayUseInlineSelfReview(input: {
  approval: ApprovalMode;
  risk?: RiskLevel;
  autonomyMode?: AutonomyMode;
  lineId?: ProductionLineId;
  actorKind: "human" | "agent";
}): { allowed: boolean; reason: string } {
  if (input.approval !== "inline_self_review") return { allowed: false, reason: "approval_mode_is_human_async" };
  if (input.actorKind !== "human") return { allowed: false, reason: "agent_cannot_approve" };
  if (input.autonomyMode === "restricted") return { allowed: false, reason: "restricted_work" };
  if (input.lineId === "security" || input.lineId === "release" || input.lineId === "incident") return { allowed: false, reason: "line_forbids_inline_review" };
  if (input.risk === "high") return { allowed: false, reason: "risk_too_high" };
  return { allowed: true, reason: "low_risk_solo_inline_self_review" };
}

export function validateInlineApproval(record: InlineApprovalRecord): { ok: true } | { ok: false; reason: string } {
  if (record.actorKind === "agent") return { ok: false, reason: "agent_cannot_approve" };
  if (!record.approver || record.approver === record.requester && /agent|bot|foreman/i.test(record.approver)) return { ok: false, reason: "agent_cannot_approve" };
  if (/agent:|factory-agent|foreman/i.test(record.approver)) return { ok: false, reason: "agent_cannot_approve" };
  return { ok: true };
}
