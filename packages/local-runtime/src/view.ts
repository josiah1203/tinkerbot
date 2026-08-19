import type { SqliteFactoryStore } from "./sqlite-store";
import { compareEvalAttempts } from "../../factory/src/evals";
import { customerCostView, type CostEstimate, type CustomerCostView } from "../../factory/src/runtime";

export interface LocalRuntimeView {
  local: true;
  organizationId: "local";
  billing: "seats_only";
  upgradesVerdict: false;
  plans: Array<{ planId: string; skip: string[]; selectedPipeline: string; escalationReason?: string; cost: unknown; stages: unknown }>;
  costs: Array<{ planId: string; estimate: CustomerCostView; actuals: unknown }>;
  evals: Array<{ taskId: string; suiteId: string; passed: boolean; upgradesVerdict: false }>;
  evalCompare: { improved: string[]; regressed: string[]; unchanged: string[]; upgradesVerdict: false };
  workOrders: Array<{ workOrderId: string; status: string; currentStage: string }>;
}

export function localRuntimeView(store: SqliteFactoryStore): LocalRuntimeView {
  const plans = [...store.plans.values()].map((plan) => ({
    planId: plan.planId,
    skip: plan.skip,
    selectedPipeline: plan.selectedPipeline,
    escalationReason: plan.escalationReason,
    cost: customerCostView(plan.cost, plan.skip),
    stages: plan.stages,
  }));
  const costs = [...store.estimates.entries()].map(([planId, estimate]) => ({
    planId,
    estimate: customerCostView(estimate as CostEstimate),
    actuals: [...store.actuals.values()].flat(),
  }));
  const evals = store.attempts.map((attempt) => ({ taskId: attempt.taskId, suiteId: attempt.suiteId, passed: attempt.passed, upgradesVerdict: false as const }));
  const compare = compareEvalAttempts(store.attempts, store.attempts);
  return {
    local: true,
    organizationId: "local",
    billing: "seats_only",
    upgradesVerdict: false,
    plans,
    costs,
    evals,
    evalCompare: { ...compare, upgradesVerdict: false },
    workOrders: [...store.orders.values()].map((order) => ({ workOrderId: order.workOrderId, status: order.status, currentStage: String(order.currentStage) })),
  };
}

export function formatPlanTab(view: LocalRuntimeView): string {
  if (!view.plans.length) return "Plan tab. No local ExecutionPlan yet. Run `tb factory plan` or `tb run --local`. tb check is the verdict.";
  return view.plans.map((plan) => [
    `Plan ${plan.planId}`,
    `Pipeline ${plan.selectedPipeline}. Skip: ${(plan.skip ?? []).join(", ") || "(none)"}.`,
    plan.escalationReason ? `Escalation: ${plan.escalationReason}` : "No escalation.",
    "Agents cannot self-approve. Verification is never skipped.",
  ].join("\n")).join("\n\n");
}

export function formatCostTab(view: LocalRuntimeView): string {
  if (!view.costs.length && !view.plans.length) return "Cost tab. Tinkerbot invoices seats only. BYOK spend is billed by your provider.";
  const rows = view.costs.length ? view.costs : view.plans.map((plan) => ({ planId: plan.planId, estimate: plan.cost as CustomerCostView, actuals: [] }));
  return rows.map((row) => {
    const estimate = row.estimate ?? { platformInvoice: "seats_only" };
    const byok = estimate.byokSpendCents != null ? `BYOK ${estimate.byokSpendCents}¢. ${estimate.byokNote ?? "Billed by your provider; not on your Tinkerbot invoice."}` : "No BYOK spend recorded.";
    return [`Plan ${row.planId}`, `platformInvoice=${estimate.platformInvoice}`, estimate.provider ? `Provider ${estimate.provider}` : undefined, byok].filter(Boolean).join("\n");
  }).join("\n\n");
}

export function formatEvalTab(view: LocalRuntimeView): string {
  return [
    "Eval tab. Scorers cannot upgrade tb check.",
    `Attempts: ${view.evals.length}. upgradesVerdict=${view.evalCompare.upgradesVerdict}`,
    `Improved ${view.evalCompare.improved.length} · regressed ${view.evalCompare.regressed.length} · unchanged ${view.evalCompare.unchanged.length}`,
  ].join("\n");
}
