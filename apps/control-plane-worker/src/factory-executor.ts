import { createImplementPullRequest, mintInstallationToken } from "../../../packages/github/src";
import {
  createPullRequestBody,
  createSelfHostedDispatch,
  exhaustObjectKey,
  isExternalHarness,
  runImplementSandbox,
  sandboxImplementPlan,
  sanitizeUntrustedPromptInput,
  selfHostedSecretReady,
  type FactoryDefinition,
  type FactoryQueueMessage,
} from "../../../packages/factory/src";
import type { FactoryEnv } from "./factory-runtime";

interface SelfHostedDispatchInput {
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  runId: string;
  repository: string;
  sourceType: FactoryQueueMessage["sourceType"];
  sourceId: string;
  definitionDigest: string;
  prompt?: string;
  definition: FactoryDefinition;
}

/**
 * Hand off implementation to a customer-owned worker without putting a
 * credential, session token, or provider secret on the queue. The worker can
 * fetch the repository itself and must return through the existing verification
 * / OIDC path; this message is only a dispatch claim, never a merge authority.
 */
export async function dispatchSelfHostedWork(env: FactoryEnv, input: SelfHostedDispatchInput): Promise<{ ok: true; dispatchId: string } | { ok: false; dispatchId: string; reason: string }> {
  const dispatchId = `selfhost:${input.workOrderId}:${input.runId}`;
  if (!env.SELF_HOSTED_WORK && !env.SELF_HOSTED_WORK_ENDPOINT) return { ok: false, dispatchId, reason: "self_hosted_queue_not_configured" };
  // Do not reuse the session-encryption key in production. Development and
  // tests retain the fallback so the adapter stays easy to exercise, but a
  // deployed customer-worker boundary gets an independently rotatable HMAC
  // trust domain.
  const signingSecret = env.SELF_HOSTED_WORK_SECRET ?? (env.ENVIRONMENT === "production" ? undefined : env.SESSION_ENCRYPTION_KEY);
  if (!signingSecret || (env.ENVIRONMENT === "production" && !selfHostedSecretReady(signingSecret))) return { ok: false, dispatchId, reason: "self_hosted_signing_secret_not_configured" };
  const implementation = input.definition.agents.find((agent) => agent.agentType === "IMPLEMENT" || agent.id === "implement" || agent.id === "implementation");
  const externalHarness = implementation && isExternalHarness(implementation.harness) ? input.definition.harnesses[implementation.harness] : undefined;
  try {
    const envelope = createSelfHostedDispatch({
      dispatchId,
      executionBoundary: "self_hosted",
      organizationId: input.organizationId,
      factoryId: input.factoryId,
      workOrderId: input.workOrderId,
      runId: input.runId,
      repository: input.repository,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      definitionDigest: input.definitionDigest,
      harness: externalHarness?.id ?? implementation?.harness ?? "default",
      workerHost: input.definition.runtime.workerHost,
      model: implementation?.model,
      prompt: sanitizeUntrustedPromptInput(input.prompt ?? "Implement the approved change.", 16_000),
      secret: signingSecret,
    });
    if (env.SELF_HOSTED_WORK) {
      await env.SELF_HOSTED_WORK.send(envelope);
    } else {
      const endpoint = new URL(env.SELF_HOSTED_WORK_ENDPOINT!);
      const localEndpoint = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
      if (endpoint.protocol !== "https:" && !localEndpoint) throw new Error("Self-hosted worker endpoint must use HTTPS (HTTP is allowed only for localhost development).");
      if (endpoint.username || endpoint.password) throw new Error("Self-hosted worker endpoint must not embed credentials.");
      const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-tinkerbot-self-hosted-protocol": "1" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Self-hosted worker endpoint returned HTTP ${response.status}.`);
    }
    return { ok: true, dispatchId };
  } catch {
    return { ok: false, dispatchId, reason: "self_hosted_queue_send_failed" };
  }
}

export async function dispatchSandboxIfBound(env: FactoryEnv, input: { workOrderId: string; repository: string; intent?: string; installationId?: number; organizationId: string; runId: string }): Promise<{ complete: boolean; sha?: string }> {
  const plan = sandboxImplementPlan({ repository: input.repository, workOrderId: input.workOrderId, intent: input.intent });
  if (!env.Sandbox || typeof env.Sandbox !== "object") return { complete: false };
  try {
    const token = env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && input.installationId
      ? await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: input.installationId })
      : undefined;
    const sandbox = env.Sandbox as { exec?(argv: string[], options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<{ output(): Promise<{ stdout: string; exitCode: number }> }> };
    if (typeof sandbox.exec !== "function") return { complete: false };
    const result = await runImplementSandbox({
      exec: async (argv, options) => {
        const handle = await sandbox.exec!(Array.from(argv), { cwd: options?.cwd, env: token ? { GIT_ASKPASS: "echo", GITHUB_TOKEN: token, ...options?.env } : options?.env, timeout: options?.timeout });
        const output = await handle.output();
        return { stdout: output.stdout, exitCode: output.exitCode };
      },
    }, plan, token ? { GITHUB_TOKEN: token } : {});
    if (result.status !== "ok" || !token) return { complete: false };
    const number = await createImplementPullRequest({ token, repository: input.repository }, {
      title: `tinkerbot: ${input.workOrderId.slice(0, 8)}`,
      head: plan.branch,
      body: createPullRequestBody({ workOrderId: input.workOrderId, dashboardUrl: `${env.CONTROL_PLANE_URL ?? ""}/app/work/${input.workOrderId}` }),
    });
    if (env.EVIDENCE_BUCKET) await env.EVIDENCE_BUCKET.put(exhaustObjectKey(input.organizationId, input.workOrderId, "sandbox-log"), JSON.stringify({ logs: result.logs, pull: number, branch: result.branch }), { httpMetadata: { contentType: "application/json" } });
    return { complete: result.status === "ok", sha: undefined };
  } catch {
    return { complete: false };
  }
}

/** The hosted Sandbox remains an explicit, fail-closed capability gap. */
export class Sandbox {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: "Attach the Cloudflare Sandbox implementation in this account." }), { status: 501, headers: { "content-type": "application/json" } });
  }
}
