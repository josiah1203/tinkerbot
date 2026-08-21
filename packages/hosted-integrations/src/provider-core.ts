import type { ProviderName } from "./index";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly status?: number;
  readonly code?: string;

  constructor(provider: ProviderName, message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = options.status;
    this.code = options.code;
  }
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requiredSecret(value: string | undefined, name: string, provider: ProviderName): string {
  if (!value) throw new ProviderError(provider, `${name} is not configured.`, { code: "provider_not_configured" });
  return value;
}

export async function jsonRequest(provider: ProviderName, fetcher: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new ProviderError(provider, "Provider request could not be completed.", { code: "provider_unreachable" });
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new ProviderError(provider, `Provider request failed with HTTP ${response.status}.`, { status: response.status, code: "provider_request_failed" });
  }
  try {
    return recordValue(JSON.parse(raw));
  } catch {
    throw new ProviderError(provider, "Provider returned an invalid JSON response.", { status: response.status, code: "provider_invalid_response" });
  }
}
