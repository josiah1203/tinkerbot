import type { OutcomeMaturity, OutcomeStatus } from "./graph";

export interface MeasurementInput { baseline: number; target: number; observed?: number; windowStartsAt: string; windowEndsAt: string; now: string; sampleSize?: number; minimumSampleSize?: number; confidence?: number; minimumConfidence?: number; confounders?: string[]; }
export interface OutcomeEvaluation { status: OutcomeStatus; maturity: OutcomeMaturity; explanation: string[]; }
export interface FactoryEffectivenessInputs { productiveCapacityHours: number; availableCapacityHours: number; actualThroughput: number; achievableThroughput: number; acceptedFirstPass: number; completed: number; }

export function evaluateOutcome(input: MeasurementInput): OutcomeEvaluation {
  const now = Date.parse(input.now); const end = Date.parse(input.windowEndsAt);
  if (!input.observed && input.observed !== 0) return { status: "PENDING", maturity: "IMMATURE", explanation: ["No observation has been recorded."] };
  if (!Number.isFinite(end) || now < end) return { status: "PENDING", maturity: "IMMATURE", explanation: ["Measurement window has not matured."] };
  if ((input.sampleSize ?? 0) < (input.minimumSampleSize ?? 1)) return { status: "UNKNOWN", maturity: "MATURE", explanation: ["Measurement window ended without sufficient sample size."] };
  if ((input.confidence ?? 0) < (input.minimumConfidence ?? 0)) return { status: "UNKNOWN", maturity: "MATURE", explanation: ["Measurement confidence is below the required threshold."] };
  const positive = input.target >= input.baseline ? input.observed >= input.target : input.observed <= input.target;
  const status: OutcomeStatus = positive ? "POSITIVE" : "NEGATIVE";
  return { status, maturity: "MATURE", explanation: [`Observed ${input.observed}; baseline ${input.baseline}; target ${input.target}.`, ...(input.confounders?.length ? [`Confounders recorded: ${input.confounders.join(", ")}`] : [])] };
}

export function factoryEffectiveness(input: FactoryEffectivenessInputs): { availability: number; performance: number; quality: number; oee: number } {
  const ratio = (a: number, b: number) => b > 0 ? Math.max(0, Math.min(1, a / b)) : 0;
  const availability = ratio(input.productiveCapacityHours, input.availableCapacityHours);
  const performance = ratio(input.actualThroughput, input.achievableThroughput);
  const quality = ratio(input.acceptedFirstPass, input.completed);
  return { availability, performance, quality, oee: Math.round(availability * performance * quality * 1_000_000) / 1_000_000 };
}
