import type { InferenceMode, ProviderUsage } from "./runtime";

export interface FactoryAiLike {
  run(model: string, input: { messages: Array<{ role: string; content: string }> }, options?: { gateway?: { id: string; collectLog?: boolean; metadata?: Record<string, string> } }): Promise<{ response?: string }>;
}
import { INFERENCE_COST_CATALOG } from "./runtime";

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
    run: async (model, input) => {
      const result = await provider.run({ model, messages: input.messages });
      return { response: result.text };
    },
  };
}
