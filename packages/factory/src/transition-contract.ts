/**
 * The single executable route contract for WorkOrder lifecycle transitions.
 * The WorkOrder model, command boundary, and transition tests all consume
 * this table; documentation may describe it, but may not redefine it.
 */
export const WORK_ORDER_TRANSITION_CONTRACT = {
  intake: ["triage", "specification", "implementation", "verification", "blocked", "cancelled", "unknown"],
  triage: ["specification", "implementation", "verification", "blocked", "cancelled", "failed", "unknown"],
  specification: ["implementation", "approval", "blocked", "cancelled", "failed", "unknown"],
  implementation: ["review", "verification", "blocked", "cancelled", "failed", "unknown"],
  review: ["verification", "implementation", "approval", "blocked", "cancelled", "failed", "unknown"],
  verification: ["approval", "review", "blocked", "failed", "unknown"],
  approval: ["ready", "implementation", "blocked", "cancelled", "unknown"],
  ready: ["merged", "blocked", "cancelled", "unknown"],
  merged: ["released", "unknown"],
  released: [],
  blocked: ["intake", "triage", "specification", "implementation", "review", "verification", "approval", "cancelled", "failed", "unknown"],
  failed: ["intake", "cancelled", "unknown"],
  cancelled: ["unknown"],
  unknown: ["intake", "blocked", "failed", "cancelled"],
} as const;

export type WorkOrderTransitionContractState = keyof typeof WORK_ORDER_TRANSITION_CONTRACT;

export function isLegalWorkOrderTransition(fromState: string, toState: string): boolean {
  const targets = WORK_ORDER_TRANSITION_CONTRACT[fromState as WorkOrderTransitionContractState];
  return Boolean(targets && (targets as readonly string[]).includes(toState));
}

export function workOrderTransitionContractEdges(): Array<{ fromState: WorkOrderTransitionContractState; toState: string }> {
  return (Object.entries(WORK_ORDER_TRANSITION_CONTRACT) as Array<[WorkOrderTransitionContractState, readonly string[]]>).flatMap(([fromState, targets]) => targets.map((toState) => ({ fromState, toState })));
}
