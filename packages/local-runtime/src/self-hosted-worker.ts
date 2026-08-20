import { createSelfHostedCompletion, isExternalHarness, isSelfHostedWorkerHost, verifySelfHostedDispatch, type FactoryHarnessDefinition, type SelfHostedCompletionEnvelope, type SelfHostedDispatchPayload } from "../../factory/src";
import { runExternalHarness } from "./harness";
import type { SandboxPort } from "./sandbox";

export interface SelfHostedWorkerInput {
  /** Signed dispatch envelope received from the queue or HTTPS bridge. */
  dispatch: unknown;
  secret: string;
  /** Customer-local repository checkout; provider credentials never enter the dispatch. */
  repositoryRoot: string;
  harnesses: Record<string, FactoryHarnessDefinition>;
  /** Worker identity from runtime.workerHost; used to prevent cross-worker execution. */
  workerHost?: string;
  /** Digest of the fully loaded local factory definition (including its tree). */
  definitionDigest: string;
  sandbox: SandboxPort;
  completionUrl: string;
  env?: NodeJS.ProcessEnv;
  pullRequestNumber?: number;
  fetchImpl?: typeof fetch;
}

export interface SelfHostedWorkerResult {
  accepted: boolean;
  dispatchId?: string;
  status: "completed" | "failed";
  completion?: SelfHostedCompletionEnvelope;
  reason?: string;
}

function localEndpoint(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function assertCompletionUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !localEndpoint(url)) throw new Error("Self-hosted completion URL must use HTTPS (HTTP is allowed only for localhost development).");
  if (url.username || url.password) throw new Error("Self-hosted completion URL must not embed credentials.");
  return url;
}

function safeCompletionSummary(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/(?:\/(?:Users|home|private\/var|tmp)\/|[A-Za-z]:\\)[^\s'"`]+/g, "[path]")
    .slice(0, 2_000);
}

async function postCompletion(url: URL, completion: SelfHostedCompletionEnvelope, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", "x-tinkerbot-self-hosted-protocol": "1" },
    body: JSON.stringify(completion),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Self-hosted completion endpoint returned HTTP ${response.status}.`);
}

function completionFields(payload: SelfHostedDispatchPayload): Pick<SelfHostedCompletionEnvelope, "dispatchId" | "executionBoundary" | "organizationId" | "factoryId" | "workOrderId" | "runId" | "repository" | "definitionDigest"> {
  return {
    dispatchId: payload.dispatchId,
    executionBoundary: payload.executionBoundary,
    organizationId: payload.organizationId,
    factoryId: payload.factoryId,
    workOrderId: payload.workOrderId,
    runId: payload.runId,
    repository: payload.repository,
    definitionDigest: payload.definitionDigest,
  };
}

/**
 * Execute one signed self-hosted dispatch and post a signed completion.
 * This is intentionally one-shot: queue consumers should ack only after this
 * function resolves, and retry delivery if the completion POST fails.
 */
export async function runSelfHostedDispatch(input: SelfHostedWorkerInput): Promise<SelfHostedWorkerResult> {
  const checked = verifySelfHostedDispatch(input.dispatch, input.secret);
  if (!checked.ok) return { accepted: false, status: "failed", reason: checked.reason };
  const payload = checked.payload;
  if (input.definitionDigest !== payload.definitionDigest) return { accepted: false, status: "failed", reason: "definition_digest_mismatch" };
  if (input.sandbox.kind !== "docker" && input.sandbox.kind !== "process") return { accepted: false, status: "failed", reason: "sandbox_isolation_required" };
  const completionUrl = assertCompletionUrl(input.completionUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const harness = input.harnesses[payload.harness];
  // A worker that is not configured for this dispatch must not report a
  // harness failure: doing so would let the wrong queue consumer fail a run
  // that should have been retried or routed to the correct worker.
  if (!harness || harness.id !== payload.harness || !isExternalHarness(harness.id)
    || (input.workerHost && !isSelfHostedWorkerHost(input.workerHost))
    || (payload.workerHost && input.workerHost !== payload.workerHost)
    || (input.workerHost && harness.workerHost && harness.workerHost !== input.workerHost)) {
    return { accepted: false, status: "failed", dispatchId: payload.dispatchId, reason: "harness_not_configured" };
  }
  const base = completionFields(payload);
  let status: "completed" | "failed" = "failed";
  let branch: string | undefined;
  let headSha: string | undefined;
  let summary = "Self-hosted worker could not execute the requested harness.";
  let lease: Awaited<ReturnType<SandboxPort["start"]>> | undefined;
  try {
    lease = await input.sandbox.start({ repositoryRoot: input.repositoryRoot, workOrderId: payload.workOrderId });
    const result = await runExternalHarness({
      harness,
      worktree: lease.worktree,
      executionWorktree: input.sandbox.kind === "docker" ? "/work" : lease.worktree,
      repository: payload.repository,
      workOrderId: payload.workOrderId,
      prompt: payload.prompt,
      model: payload.model,
      env: input.env,
      networkIsolation: input.sandbox.kind !== "process",
      exec: (argv, options) => input.sandbox!.exec(lease!.worktree, argv, options),
    });
    summary = safeCompletionSummary(result.summary);
    branch = lease.branch;
    if (result.status === "ok") {
      const head = await input.sandbox.exec(lease.worktree, ["git", "rev-parse", "HEAD"], { timeoutMs: 10_000, network: "none" });
      const candidate = head.stdout.trim();
      if (/^[A-Fa-f0-9]{7,128}$/.test(candidate)) headSha = candidate;
      status = "completed";
    }
  } catch {
    // Do not serialize provider errors, command output, or local paths into the
    // control plane. The signed completion carries only a bounded safe summary.
    summary = "The self-hosted harness execution failed.";
  } finally {
    try { await lease?.cleanup(); } catch { /* cleanup is best effort */ }
  }
  const completionInput = {
    ...base,
    status,
    ...(branch ? { branch } : {}),
    ...(headSha ? { headSha } : {}),
    ...(status === "completed" && input.pullRequestNumber != null ? { pullRequestNumber: input.pullRequestNumber } : {}),
    summary: safeCompletionSummary(summary),
    secret: input.secret,
  } as const;
  let completion: SelfHostedCompletionEnvelope;
  try {
    completion = createSelfHostedCompletion(completionInput);
  } catch {
    // Harness output is untrusted. Preserve the change reference but replace
    // any credential-like summary (or malformed optional PR number) with a
    // fixed safe message rather than retrying the same work forever.
    completion = createSelfHostedCompletion({ ...completionInput, summary: "Self-hosted harness completed; output omitted by credential policy.", pullRequestNumber: undefined });
  }
  await postCompletion(completionUrl, completion, fetchImpl);
  return { accepted: true, dispatchId: payload.dispatchId, status, completion };
}
