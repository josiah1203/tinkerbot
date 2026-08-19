import type { InferenceProvider, InferenceRequest, InferenceResponse } from "../../factory/src/inference";
import { usageFromResponse } from "../../factory/src/inference";
import { resolveCredentialRef } from "./credentials";

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Provider ${url} returned HTTP ${response.status}`);
  return parsed;
}

function textFromOpenAi(parsed: Record<string, unknown>): string {
  const choices = parsed.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? (typeof parsed.response === "string" ? parsed.response : "");
}

export function anthropicProvider(credentialRef: string, env?: NodeJS.ProcessEnv): InferenceProvider {
  const provider: InferenceProvider = {
    id: "anthropic",
    mode: "byok",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const key = resolveCredentialRef(credentialRef, env);
      if (!key) throw new Error("Anthropic credentialRef did not resolve.");
      const parsed = await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
        model: input.model,
        max_tokens: 1024,
        messages: input.messages.filter((message) => message.role !== "system"),
        system: input.messages.find((message) => message.role === "system")?.content,
      });
      const content = parsed.content as Array<{ text?: string }> | undefined;
      return { text: content?.[0]?.text ?? "", raw: { usage: parsed.usage } };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, "local"),
  };
  return provider;
}

export function openaiProvider(credentialRef: string, baseUrl = "https://api.openai.com/v1", env?: NodeJS.ProcessEnv): InferenceProvider {
  const provider: InferenceProvider = {
    id: "openai",
    mode: "byok",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const key = resolveCredentialRef(credentialRef, env);
      if (!key) throw new Error("OpenAI credentialRef did not resolve.");
      const parsed = await postJson(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${key}` }, { model: input.model, messages: input.messages });
      return { text: textFromOpenAi(parsed), raw: parsed };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, "local"),
  };
  return provider;
}

export function ollamaProvider(baseUrl = "http://127.0.0.1:11434"): InferenceProvider {
  const provider: InferenceProvider = {
    id: "ollama",
    mode: "local",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const parsed = await postJson(`${baseUrl.replace(/\/$/, "")}/api/chat`, {}, { model: input.model, messages: input.messages, stream: false });
      const message = parsed.message as { content?: string } | undefined;
      return { text: message?.content ?? "", raw: parsed };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, "local"),
  };
  return provider;
}

export function stubInferenceProvider(text = "{\"triage\":\"ok\",\"implementation\":\"notes\",\"review\":\"advisory\"}"): InferenceProvider {
  const provider: InferenceProvider = {
    id: "stub",
    mode: "local",
    run: async () => ({ text }),
    usage: (response) => usageFromResponse(provider, response, { model: "stub", messages: [] }, "local"),
  };
  return provider;
}

export function providerForProfile(input: { mode: string; provider?: string; credentialRef?: string; env?: NodeJS.ProcessEnv }): InferenceProvider {
  if (input.mode === "local" || input.provider === "ollama") return ollamaProvider();
  if (input.provider === "anthropic") return anthropicProvider(input.credentialRef ?? "env:ANTHROPIC_API_KEY", input.env);
  if (input.provider === "openai") return openaiProvider(input.credentialRef ?? "env:OPENAI_API_KEY", undefined, input.env);
  return stubInferenceProvider();
}
