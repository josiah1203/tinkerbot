import { factoryId, type CapacityBand, type IntentContract, type TaskContract } from "./graph";

export interface TaskDag { dagId: string; intentId: string; version: number; tasks: TaskContract[]; dependencies: Array<{ taskId: string; dependsOnTaskId: string }>; }
export interface PriorityInputs { expectedOutcomeValue: number; strategicImportance: number; urgency: number; customerImpact: number; confidence: number; risk: number; novelty: number; estimatedCost: number; dependencyCount: number; availableCapacity: number; historicalOutcome: number; }
export interface PriorityDecision { score: number; inputs: PriorityInputs; explanation: string[]; }
export interface RoutingInputs { risk: TaskContract["risk"]; novelty: number; reversibility: number; blastRadius: number; ambiguity: number; workerReliability: number; workerConcurrency: { active: number; limit: number }; reviewCapacity: CapacityBand; integrationCapacity: CapacityBand; queueAgeHours: number; protectedCapacity: boolean; }
export interface RoutingDecision { mode: "agent_default" | "hybrid" | "human_default"; requiredReview: TaskContract["requiredReviewerType"]; autonomy: "ASSIST" | "EXECUTE" | "HUMAN_CONTROLLED"; controls: string[]; explanation: string[]; }

/** Deterministic starter DAG. AI may propose alternatives but cannot hide dependencies or controls. */
export function decomposeIntent(intent: IntentContract, version = 1): TaskDag {
  const risk = intent.risk ?? "low";
  const requiredReviewerType: TaskContract["requiredReviewerType"] = risk === "low" ? "self" : risk === "medium" ? "independent_agent" : "human";
  const specTask: TaskContract = { taskId: factoryId("task"), intentId: intent.intentId, acceptanceCriteria: intent.acceptanceCriteria ?? [intent.expectedBehavior], dependencies: [], requiredCapability: ["specification"], risk, novelty: 0, requiredWorkerType: "hybrid", requiredReviewerType, completionConditions: ["Acceptance criteria are explicit", "Non-goals are recorded"] };
  const buildTask: TaskContract = { taskId: factoryId("task"), intentId: intent.intentId, acceptanceCriteria: intent.acceptanceCriteria ?? [intent.expectedBehavior], dependencies: [specTask.taskId], requiredCapability: ["implementation"], risk, novelty: 0, requiredWorkerType: risk === "high" || risk === "critical" ? "human" : "agent", requiredReviewerType, completionConditions: ["Worker receipt is complete", "Change is verified"], rollbackPlan: "Revert the isolated change set" };
  const verifyTask: TaskContract = { taskId: factoryId("task"), intentId: intent.intentId, acceptanceCriteria: ["Deterministic verification has a verdict"], dependencies: [buildTask.taskId], requiredCapability: ["deterministic_verification"], risk, novelty: 0, requiredWorkerType: "hybrid", requiredReviewerType, completionConditions: ["Verification verdict is PASS", "Independent review requirement is met"] };
  const tasks = [specTask, buildTask, verifyTask];
  return { dagId: factoryId("dag"), intentId: intent.intentId, version, tasks, dependencies: tasks.flatMap((task) => task.dependencies.map((dependsOnTaskId) => ({ taskId: task.taskId, dependsOnTaskId }))) };
}

export function explainPriority(input: PriorityInputs): PriorityDecision {
  const positive = input.expectedOutcomeValue * 0.24 + input.strategicImportance * 0.18 + input.urgency * 0.14 + input.customerImpact * 0.16 + input.confidence * 0.12 + input.historicalOutcome * 0.08 + input.availableCapacity * 0.08;
  const penalty = input.risk * 0.12 + input.novelty * 0.1 + input.estimatedCost * 0.08 + input.dependencyCount * 0.06;
  const score = Math.round((positive - penalty) * 100) / 100;
  return { score, inputs: input, explanation: [`value=${positive.toFixed(2)}`, `risk_cost_dependency_penalty=${penalty.toFixed(2)}`, `score=${score.toFixed(2)}`, input.availableCapacity < 0.3 ? "Capacity is constrained; preserve protected attention." : "Capacity is available for routing."] };
}

export function routeFactoryTask(input: RoutingInputs): RoutingDecision {
  const highRisk = input.risk === "high" || input.risk === "critical" || input.blastRadius >= 0.7 || input.reversibility <= 0.3;
  const coldStart = input.novelty >= 0.5 || input.workerReliability < 0.65;
  const constrained = input.reviewCapacity === "OVERLOADED" || input.reviewCapacity === "UNAVAILABLE" || input.integrationCapacity === "OVERLOADED" || input.protectedCapacity || input.workerConcurrency.active >= input.workerConcurrency.limit;
  const controls = coldStart ? ["sandboxed_execution", "smaller_task_boundary", "extra_evidence", "independent_review", "no_autonomous_release", "rollback_plan"] : [];
  if (highRisk || input.ambiguity >= 0.6 || coldStart) return { mode: "human_default", requiredReview: "human", autonomy: "HUMAN_CONTROLLED", controls, explanation: ["Risk, ambiguity, irreversibility, or novelty requires a human-default route.", constrained ? "Capacity is constrained; queue without consuming protected review capacity." : "Human review capacity must be reserved."] };
  if (input.risk === "low" && input.novelty < 0.25 && input.reversibility >= 0.7 && !constrained) return { mode: "agent_default", requiredReview: "self", autonomy: "EXECUTE", controls, explanation: ["Well-specified low-risk reversible work has fast feedback."] };
  return { mode: "hybrid", requiredReview: "independent_agent", autonomy: "ASSIST", controls, explanation: ["Moderate risk or capacity constraints require a hybrid route and independent review."] };
}
