import type { InferenceProvider, InferenceRequest, InferenceResponse } from "../../factory/src/inference";
import { usageFromResponse } from "../../factory/src/inference";
import { resolveCredentialRef } from "./credentials";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function postJson(url: string, headers: Record<string, string>, body: unknown, fetchImpl: FetchLike = fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Provider ${url} returned HTTP ${response.status}`);
  return parsed;
}

function textFromOpenAi(parsed: Record<string, unknown>): string {
  const choices = parsed.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? (typeof parsed.response === "string" ? parsed.response : "");
}

export function anthropicProvider(credentialRef: string, env?: NodeJS.ProcessEnv, fetchImpl?: FetchLike): InferenceProvider {
  const provider: InferenceProvider = {
    id: "anthropic",
    mode: "byok",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const key = resolveCredentialRef(credentialRef, env);
      if (!key) throw new Error("Anthropic credentialRef did not resolve.");
      const parsed = await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
        model: input.model || "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: input.messages.filter((message) => message.role !== "system"),
        system: input.messages.find((message) => message.role === "system")?.content,
      }, fetchImpl);
      const content = parsed.content as Array<{ text?: string }> | undefined;
      const usage = parsed.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return { text: content?.[0]?.text ?? "", raw: parsed, usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens } };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, "local"),
  };
  return provider;
}

export function openaiProvider(credentialRef: string, baseUrl = "https://api.openai.com/v1", env?: NodeJS.ProcessEnv, fetchImpl?: FetchLike): InferenceProvider {
  const provider: InferenceProvider = {
    id: "openai",
    mode: "byok",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const key = resolveCredentialRef(credentialRef, env);
      if (!key) throw new Error("OpenAI credentialRef did not resolve.");
      const parsed = await postJson(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${key}` }, { model: input.model || "gpt-4.1-mini", messages: input.messages }, fetchImpl);
      const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return { text: textFromOpenAi(parsed), raw: parsed, usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens } };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "", messages: [] }, "local"),
  };
  return provider;
}

export function ollamaProvider(baseUrl = "http://127.0.0.1:11434", fetchImpl?: FetchLike): InferenceProvider {
  const provider: InferenceProvider = {
    id: "ollama",
    mode: "local",
    run: async (input: InferenceRequest): Promise<InferenceResponse> => {
      const parsed = await postJson(`${baseUrl.replace(/\/$/, "")}/api/chat`, {}, { model: input.model || "llama3.2", messages: input.messages, stream: false }, fetchImpl);
      const message = parsed.message as { content?: string } | undefined;
      return { text: message?.content ?? "", raw: parsed };
    },
    usage: (response) => usageFromResponse(provider, response, { model: "stub", messages: [] }, "local"),
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

export function credentialsResolve(credentialRef: string | undefined, env?: NodeJS.ProcessEnv): boolean {
  try {
    return Boolean(resolveCredentialRef(credentialRef, env));
  } catch {
    return false;
  }
}

export function selectInferenceProvider(input: {
  mode: string;
  provider?: string;
  credentialRef?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): InferenceProvider {
  const env = input.env ?? process.env;
  const stubForced = env.TINKERBOT_STUB_INFERENCE === "1" || (Boolean(env.VITEST) && env.TINKERBOT_STUB_INFERENCE !== "0");
  if (stubForced) return stubInferenceProvider();
  const liveRequested = env.TINKERBOT_STUB_INFERENCE === "0" || credentialsResolve(input.credentialRef, env) || input.mode === "local" || input.provider === "ollama";
  if (!liveRequested) return stubInferenceProvider();
  if (input.mode === "local" || input.provider === "ollama") return ollamaProvider(undefined, input.fetchImpl);
  if (input.provider === "anthropic") return anthropicProvider(input.credentialRef ?? "env:ANTHROPIC_API_KEY", env, input.fetchImpl);
  const openAiBase = env.OPENROUTER_API_BASE ?? env.OPENAI_BASE_URL ?? (input.provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined);
  if (input.provider === "openai" || input.provider === "openrouter") {
    return openaiProvider(input.credentialRef ?? (input.provider === "openrouter" ? "env:OPENROUTER_API_KEY" : "env:OPENAI_API_KEY"), openAiBase, env, input.fetchImpl);
  }
  if (env.TINKERBOT_STUB_INFERENCE === "0") throw new Error("Live inference was requested but no BYOK credentialRef resolved. Use env:VAR or keychain://…");
  return stubInferenceProvider();
}

export function providerForProfile(input: { mode: string; provider?: string; credentialRef?: string; env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike }): InferenceProvider {
  return selectInferenceProvider(input);
}
