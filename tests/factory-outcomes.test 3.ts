import { expect, test } from "vitest";
import { evaluateOutcome, factoryEffectiveness } from "../packages/factory/src";

test("outcomes cannot be positive before a mature, sufficiently confident window", () => {
  expect(evaluateOutcome({ baseline: 10, target: 20, observed: 30, windowStartsAt: "2026-01-01", windowEndsAt: "2026-02-01", now: "2026-01-15", sampleSize: 20, confidence: 0.9 }).status).toBe("PENDING");
  expect(evaluateOutcome({ baseline: 10, target: 20, observed: 25, windowStartsAt: "2026-01-01", windowEndsAt: "2026-02-01", now: "2026-02-02", sampleSize: 20, minimumSampleSize: 10, confidence: 0.9, minimumConfidence: 0.8 }).status).toBe("POSITIVE");
});

test("factory effectiveness derives availability, performance, and quality", () => {
  expect(factoryEffectiveness({ productiveCapacityHours: 8, availableCapacityHours: 10, actualThroughput: 6, achievableThroughput: 8, acceptedFirstPass: 9, completed: 10 })).toMatchObject({ availability: 0.8, performance: 0.75, quality: 0.9, oee: 0.54 });
});
