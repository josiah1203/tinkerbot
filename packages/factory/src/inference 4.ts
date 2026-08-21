import type { InferenceMode, ProviderUsage } from "./runtime";
import { INFERENCE_COST_CATALOG } from "./runtime";

export type AiPurpose = "internal_factory_intelligence" | "customer_production" | "customer_review" | "external_judging" | "explanation_only";
export type ProviderOwnership = "tinkerbot" | "customer" | "third_party";
export type BillingOwner = "tinkerbot" | "customer";

export const INTELLIGENCE_STAGES = new Set(["foreman", "triage", "specification", "architecture", "review", "steward", "single_agent", "eval"]);
export const PRODUCTION_STAGES = new Set(["implementation", "test", "sandbox"]);

export function classifyAiInvocation(input: { stage?: string; providerId: string; mode?: InferenceMode | string }): {
  aiPurpose: AiPurpose;
  providerOwnership: ProviderOwnership;
  billingOwner: BillingOwner;
} {
  const stage = input.stage ?? "";
  const tinkerbotOwned = input.providerId === "workers-ai" || input.mode === "managed";
  if (PRODUCTION_STAGES.has(stage) && tinkerbotOwned) {
    throw new Error("customer_production_cannot_use_tinkerbot_provider");
  }
  if (PRODUCTION_STAGES.has(stage)) {
    return { aiPurpose: "customer_production", providerOwnership: "customer", billingOwner: "customer" };
  }
  if (stage === "review" && !tinkerbotOwned) {
    return { aiPurpose: "customer_review", providerOwnership: "customer", billingOwner: "customer" };
  }
  return {
    aiPurpose: "internal_factory_intelligence",
    providerOwnership: tinkerbotOwned ? "tinkerbot" : "customer",
    billingOwner: tinkerbotOwned ? "tinkerbot" : "customer",
  };
}

export interface FactoryAiLike {
  run(model: string, input: { messages: Array<{ role: string; content: string }> }, options?: { gateway?: { id: string; collectLog?: boolean; metadata?: Record<string, string> } }): Promise<{ response?: string }>;
}

export interface InferenceRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stage?: string;
  metadata?: Record<string, string>;
}

export interface InferenceResponse {
  text: string;
  usage?: Partial<ProviderUsage>;
  raw?: unknown;
}

export interface InferenceProvider {
  id: string;
  mode: InferenceMode;
  run(input: InferenceRequest): Promise<InferenceResponse>;
  usage(response: InferenceResponse): ProviderUsage;
}

export function usageFromResponse(provider: InferenceProvider, response: InferenceResponse, input: InferenceRequest, origin: "local" | "hosted" = "hosted"): ProviderUsage {
  const tokens = Math.ceil((response.text || "").length / 4);
  return {
    provider: provider.id,
    model: input.model,
    inputTokens: response.usage?.inputTokens ?? Math.ceil(tokens * 0.6),
    outputTokens: response.usage?.outputTokens ?? Math.ceil(tokens * 0.4),
    cachedTokens: response.usage?.cachedTokens ?? 0,
    retries: response.usage?.retries ?? 0,
    latencyMs: response.usage?.latencyMs ?? 0,
    managed: provider.mode === "managed",
    stage: input.stage,
    catalogVersion: INFERENCE_COST_CATALOG,
    runnerOrigin: origin,
  };
}

export function workersAiInferenceProvider(ai: FactoryAiLike, origin: "local" | "hosted" = "hosted"): InferenceProvider {
  const provider: InferenceProvider = {
    id: "workers-ai",
    mode: "managed",
    run: async (input) => {
      classifyAiInvocation({ stage: input.stage, providerId: "workers-ai", mode: "managed" });
      const result = await ai.run(input.model, { messages: input.messages });
      const text = typeof result.response === "string" ? result.response : "";
      return { text, raw: result };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, origin),
  };
  provider.usage = (response) => usageFromResponse(provider, response, { model: response.usage?.model ?? "", messages: [] }, origin);
  return provider;
}

export function factoryAiFromProvider(provider: InferenceProvider): FactoryAiLike {
  return {
    run: async (model, input, options) => {
      const stage = options?.gateway?.metadata?.stage;
      const result = await provider.run({ model, messages: input.messages, stage });
      return { response: result.text };
    },
  };
}
