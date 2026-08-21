import { expect, test } from "vitest";
import { createMicroIntent, decomposeIntent, explainPriority, routeFactoryTask } from "../packages/factory/src";

test("orchestration creates a versioned dependency graph and explains priority", () => {
  const dag = decomposeIntent(createMicroIntent("Fix invoice timezone formatting"));
  expect(dag.tasks).toHaveLength(3);
  expect(dag.dependencies).toHaveLength(2);
  const priority = explainPriority({ expectedOutcomeValue: 1, strategicImportance: 0.8, urgency: 0.4, customerImpact: 0.9, confidence: 0.8, risk: 0.1, novelty: 0.1, estimatedCost: 0.2, dependencyCount: 2, availableCapacity: 0.9, historicalOutcome: 0.7 });
  expect(priority.explanation).toHaveLength(4);
  expect(priority.score).toBeGreaterThan(0);
});

test("routing lowers autonomy before failure when novelty or risk increases", () => {
  expect(routeFactoryTask({ risk: "low", novelty: 0.1, reversibility: 0.9, blastRadius: 0.1, ambiguity: 0.1, workerReliability: 0.9, workerConcurrency: { active: 0, limit: 2 }, reviewCapacity: "AVAILABLE", integrationCapacity: "AVAILABLE", queueAgeHours: 0, protectedCapacity: false })).toMatchObject({ mode: "agent_default", autonomy: "EXECUTE" });
  expect(routeFactoryTask({ risk: "high", novelty: 0.8, reversibility: 0.1, blastRadius: 0.9, ambiguity: 0.7, workerReliability: 0.4, workerConcurrency: { active: 1, limit: 1 }, reviewCapacity: "OVERLOADED", integrationCapacity: "AVAILABLE", queueAgeHours: 2, protectedCapacity: true })).toMatchObject({ mode: "human_default", autonomy: "HUMAN_CONTROLLED", requiredReview: "human" });
});
