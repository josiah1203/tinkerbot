export const INFERENCE_COST_CATALOG = "2026-08-18.seat-v1" as const;
export const LOCAL_ORGANIZATION_ID = "local";
const SELF_HOSTED_WORKER_PATTERN = /^self_hosted(?::[a-z0-9._-]{1,64})?$/;
const RUNNER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/@:-]{0,255}$/;

export type CollaborationMode = "solo" | "team";
export type ControlPlaneMode = "local" | "hosted";
export type PipelineMode = "single_agent" | "adaptive" | "multi_agent";
export type RunnerKind = "process" | "docker" | "cloudflare_sandbox" | "github_actions" | "self_hosted";
export type InferenceMode = "local" | "byok" | "managed";
export type ApprovalMode = "inline_self_review" | "human_async";
export type SyncMode = "offline" | "manual" | "hosted";
export type RuntimeOrigin = "local" | "hosted";
export type Uncertainty = "known" | "unknown";

export type RuntimeCapabilityCode =
  | "invalid_runner"
  | "invalid_provider"
  | "invalid_inference_mode"
  | "invalid_worker_host"
  | "hosted_runner_unsupported"
  | "hosted_self_hosted_worker_missing"
  | "hosted_byok_boundary_missing"
  | "hosted_local_inference_boundary_missing"
  | "local_worker_host_mismatch"
  | "cloudflare_sandbox_unsupported";

export class RuntimeCapabilityError extends Error {
  constructor(readonly code: RuntimeCapabilityCode, message: string) {
    super(message);
    this.name = "RuntimeCapabilityError";
  }
}

const RUNNER_ALIASES: Record<string, RunnerKind> = {
  "cloudflare-sandbox": "cloudflare_sandbox",
  "cloudflare_sandbox": "cloudflare_sandbox",
  "github": "github_actions",
  "github-action": "github_actions",
  "github-actions": "github_actions",
  "github_action": "github_actions",
  "github_actions": "github_actions",
  "local-docker": "docker",
  "local-process": "process",
  sandbox: "cloudflare_sandbox",
  selfhosted: "self_hosted",
  "self-hosted": "self_hosted",
  "self_hosted": "self_hosted",
  "tinkerbot-sandbox": "cloudflare_sandbox",
};

const INFERENCE_PROVIDER_ALIASES: Record<string, string> = {
  anthropic_api: "anthropic",
  "anthropic-api": "anthropic",
  claude: "anthropic",
  cloudflare_workers_ai: "workers-ai",
  "cloudflare-workers-ai": "workers-ai",
  "cloudflare/workers-ai": "workers-ai",
  gemini: "google",
  google_gemini: "google",
  "google-gemini": "google",
  managed: "workers-ai",
  "open-ai": "openai",
  open_ai: "openai",
  tinkerbot: "workers-ai",
  "tinkerbot-hosted": "workers-ai",
  vertex_ai: "google",
  "vertex-ai": "google",
  workers_ai: "workers-ai",
  workersai: "workers-ai",
};

const VALID_RUNNERS = new Set<RunnerKind>(["process", "docker", "cloudflare_sandbox", "github_actions", "self_hosted"]);
const INFERENCE_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export function normalizeRunnerKind(value: unknown, fallback: RunnerKind): RunnerKind {
  const candidate = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : fallback;
  const normalized = RUNNER_ALIASES[candidate] ?? candidate;
  if (!VALID_RUNNERS.has(normalized as RunnerKind)) throw new RuntimeCapabilityError("invalid_runner", "runtime.runner.type is invalid.");
  return normalized as RunnerKind;
}

export function normalizeInferenceProvider(value: unknown, fallback?: string): string | undefined {
  const raw = typeof value === "string" && value.trim() ? value.trim().toLowerCase().replace(/\s+/g, "-") : typeof fallback === "string" && fallback.trim() ? fallback.trim().toLowerCase().replace(/\s+/g, "-") : undefined;
  if (!raw) return undefined;
  const normalized = INFERENCE_PROVIDER_ALIASES[raw] ?? raw;
  if (!INFERENCE_PROVIDER_PATTERN.test(normalized)) throw new RuntimeCapabilityError("invalid_provider", "runtime.inference.provider must be a lowercase provider identifier.");
  return normalized;
}

export interface RuntimeCapabilityDecision {
  ok: boolean;
  code: "supported" | RuntimeCapabilityCode;
  boundary: RunnerKind;
}

/** Resolve the executable boundary without allowing provider choice to become
 * an implicit authority decision. A Sandbox binding is an explicit capability
 * input; absent that binding, the hosted Sandbox path remains fail-closed. */
export function runtimeCapabilityDecision(profile: RuntimeProfile, options: { sandboxAvailable?: boolean } = {}): RuntimeCapabilityDecision {
  const sandboxAvailable = options.sandboxAvailable === true;
  if (profile.controlPlane === "hosted" && (profile.runner.type === "process" || profile.runner.type === "docker")) return { ok: false, code: "hosted_runner_unsupported", boundary: profile.runner.type };
  if (profile.controlPlane === "hosted" && profile.runner.type === "cloudflare_sandbox" && !sandboxAvailable) return { ok: false, code: "cloudflare_sandbox_unsupported", boundary: profile.runner.type };
  if (profile.controlPlane === "hosted" && profile.runner.type === "self_hosted" && !profile.workerHost?.match(SELF_HOSTED_WORKER_PATTERN)) return { ok: false, code: "hosted_self_hosted_worker_missing", boundary: profile.runner.type };
  if (profile.controlPlane === "hosted" && profile.inference.mode === "byok" && !(profile.runner.type === "self_hosted" && profile.workerHost?.match(SELF_HOSTED_WORKER_PATTERN))) return { ok: false, code: "hosted_byok_boundary_missing", boundary: profile.runner.type };
  if (profile.controlPlane === "hosted" && profile.inference.mode === "local" && !(profile.runner.type === "self_hosted" && profile.workerHost?.match(SELF_HOSTED_WORKER_PATTERN))) return { ok: false, code: "hosted_local_inference_boundary_missing", boundary: profile.runner.type };
  if (profile.controlPlane === "local" && profile.workerHost === "local" && profile.runner.type === "self_hosted") return { ok: false, code: "local_worker_host_mismatch", boundary: profile.runner.type };
  return { ok: true, code: "supported", boundary: profile.runner.type };
}

export interface InferenceRef {
  mode: InferenceMode;
  provider?: string;
  model?: string;
  credentialRef?: string;
}

export interface RuntimeProfile {
  collaboration: CollaborationMode;
  controlPlane: ControlPlaneMode;
  pipeline: PipelineMode;
  runner: { type: RunnerKind; image?: string; allowProcess?: boolean };
  /** Optional local/self-hosted worker identity. Never a secret or endpoint credential. */
  workerHost?: string;
  inference: InferenceRef;
  approval: ApprovalMode;
  sync: SyncMode;
}

export interface PlannedStage {
  id: string;
  include: boolean;
  reason: string;
}

export interface CostEstimate {
  catalogVersion: string;
  provider?: string;
  model?: string;
  plannedStages: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedDurationSeconds: number;
  managedCogsCents: number;
  byokSpendCents: number;
  platformInvoice: "seats_only";
  confidence: "low" | "medium" | "high";
  rangeCents: { low: number; high: number };
}

export interface CustomerCostView {
  platformInvoice: "seats_only";
  plannedStages: string[];
  estimatedDurationSeconds: number;
  provider?: string;
  model?: string;
  skipReasons?: string[];
  byokSpendCents?: number;
  byokNote?: string;
}

export function customerProviderLabel(provider?: string): string | undefined {
  if (!provider) return undefined;
  const value = provider.toLowerCase();
  if (value.includes("workers") || value.includes("cloudflare") || value === "managed") return "Tinkerbot hosted inference";
  return provider;
}

export function customerCostView(estimate: CostEstimate, skip: string[] = []): CustomerCostView {
  const provider = customerProviderLabel(estimate.provider);
  const byok = (estimate.byokSpendCents ?? 0) > 0;
  const billedBy = estimate.provider && !customerProviderLabel(estimate.provider)?.startsWith("Tinkerbot") ? estimate.provider : provider;
  return {
    platformInvoice: "seats_only",
    plannedStages: estimate.plannedStages,
    estimatedDurationSeconds: estimate.estimatedDurationSeconds,
    provider,
    model: estimate.model,
    skipReasons: skip.length ? skip : undefined,
    ...(byok ? { byokSpendCents: estimate.byokSpendCents, byokNote: `Billed by ${billedBy}; not on your Tinkerbot invoice.` } : {}),
  };
}

export interface ProviderUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  retries: number;
  latencyMs: number;
  managed: boolean;
  stage?: string;
  catalogVersion: string;
  runnerOrigin: RuntimeOrigin;
}

export interface ExecutionPlan {
  planId: string;
  workOrderId?: string;
  origin: RuntimeOrigin;
  profile: RuntimeProfile;
  selectedPipeline: PipelineMode;
  stages: PlannedStage[];
  skip: string[];
  model?: string;
  provider?: string;
  runner: RuntimeProfile["runner"];
  estimatedDurationSeconds: number;
  cost: CostEstimate;
  escalationEligible: boolean;
  escalated?: boolean;
  escalationReason?: string;
  createdAt: string;
}

// Credential references are identifiers, not paths. Reject dot segments and
// empty keychain components so a local resolver cannot be steered toward an
// unintended service/account namespace.
export const CREDENTIAL_REF_PATTERN = /^(env:[A-Z][A-Z0-9_]{0,127}|keychain:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?)$/;

export function hostedRuntimeDefaults(runnerType: "github_actions" | "tinkerbot-sandbox" | "self_hosted" = "github_actions"): RuntimeProfile {
  return {
    collaboration: "team",
    controlPlane: "hosted",
    pipeline: "multi_agent",
    runner: { type: runnerType === "tinkerbot-sandbox" ? "cloudflare_sandbox" : runnerType === "self_hosted" ? "self_hosted" : "github_actions" },
    inference: { mode: "managed", provider: "workers-ai" },
    approval: "human_async",
    sync: "hosted",
  };
}

export function soloRuntimeOverlay(): Partial<RuntimeProfile> {
  return {
    collaboration: "solo",
    controlPlane: "local",
    pipeline: "adaptive",
    runner: { type: "docker" },
    inference: { mode: "byok" },
    approval: "inline_self_review",
    sync: "offline",
  };
}

export function mergeRuntimeProfile(base: RuntimeProfile, overlay?: Partial<RuntimeProfile>): RuntimeProfile {
  if (!overlay) return base;
  return {
    collaboration: overlay.collaboration ?? base.collaboration,
    controlPlane: overlay.controlPlane ?? base.controlPlane,
    pipeline: overlay.pipeline ?? base.pipeline,
    runner: overlay.runner ?? base.runner,
    workerHost: overlay.workerHost ?? base.workerHost,
    inference: overlay.inference ? { ...base.inference, ...overlay.inference } : base.inference,
    approval: overlay.approval ?? base.approval,
    sync: overlay.sync ?? base.sync,
  };
}

export function assertCredentialRef(value: string | undefined, context: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (!CREDENTIAL_REF_PATTERN.test(value)) throw new Error(`${context} credentialRef must be env:VAR or keychain://…; raw secrets are forbidden.`);
  return value;
}

export function parseRuntimeProfile(raw: unknown, defaults: RuntimeProfile): RuntimeProfile {
  if (raw == null) {
    if (defaults.controlPlane === "hosted" && defaults.runner.type === "self_hosted" && !defaults.workerHost?.match(SELF_HOSTED_WORKER_PATTERN)) {
      throw new Error("Hosted self_hosted runners require workerHost=self_hosted[:worker-id].");
    }
    return defaults;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("runtime must be a mapping.");
  const record = raw as Record<string, unknown>;
  const collaboration = record.collaboration ?? record.profile;
  if (collaboration != null && collaboration !== "solo" && collaboration !== "team") throw new Error("runtime.collaboration must be solo or team.");
  const controlPlane = record.controlPlane;
  if (controlPlane != null && controlPlane !== "local" && controlPlane !== "hosted") throw new Error("runtime.controlPlane must be local or hosted.");
  const pipeline = record.pipeline;
  if (pipeline != null && pipeline !== "single_agent" && pipeline !== "adaptive" && pipeline !== "multi_agent") throw new Error("runtime.pipeline must be single_agent, adaptive, or multi_agent.");
  const approval = record.approval ?? record.approvalMode;
  if (approval != null && approval !== "inline_self_review" && approval !== "human_async") throw new Error("runtime.approval must be inline_self_review or human_async.");
  const syncRaw = record.sync && typeof record.sync === "object" && !Array.isArray(record.sync) ? (record.sync as Record<string, unknown>).mode ?? (record.sync as Record<string, unknown>).type : record.sync;
  if (syncRaw != null && syncRaw !== "offline" && syncRaw !== "manual" && syncRaw !== "hosted") throw new Error("runtime.sync must be offline, manual, or hosted.");
  const runnerRaw = record.runner && typeof record.runner === "object" && !Array.isArray(record.runner) ? record.runner as Record<string, unknown> : {};
  const runnerType = normalizeRunnerKind(runnerRaw.type, defaults.runner.type);
  const inferenceRaw = record.inference && typeof record.inference === "object" && !Array.isArray(record.inference) ? record.inference as Record<string, unknown> : {};
  const inferenceMode = typeof inferenceRaw.mode === "string" ? inferenceRaw.mode : defaults.inference.mode;
  if (!["local", "byok", "managed"].includes(inferenceMode)) throw new RuntimeCapabilityError("invalid_inference_mode", "runtime.inference.mode is invalid.");
  const controlPlaneResolved = (controlPlane === "local" || controlPlane === "hosted" ? controlPlane : defaults.controlPlane) as ControlPlaneMode;
  const pipelineResolved = (pipeline === "single_agent" || pipeline === "adaptive" || pipeline === "multi_agent" ? pipeline : defaults.pipeline) as PipelineMode;
  const credentialRef = assertCredentialRef(typeof inferenceRaw.credentialRef === "string" ? inferenceRaw.credentialRef : undefined, "runtime.inference");
  const workerHostRaw = typeof record.workerHost === "string" ? record.workerHost : typeof runnerRaw.workerHost === "string" ? runnerRaw.workerHost : defaults.workerHost;
  const workerHost = workerHostRaw == null || workerHostRaw === "" ? undefined : workerHostRaw.trim().toLowerCase();
  if (workerHost && !/^(local|self_hosted(?::[a-z0-9._-]{1,64})?|warp|github_actions|tinkerbot-sandbox)$/.test(workerHost)) throw new RuntimeCapabilityError("invalid_worker_host", "runtime.workerHost is invalid.");
  const selfHostedWorker = Boolean(workerHost && SELF_HOSTED_WORKER_PATTERN.test(workerHost));
  if (workerHost === "local" && controlPlaneResolved === "hosted") throw new RuntimeCapabilityError("local_worker_host_mismatch", "runtime.workerHost=local requires controlPlane=local.");
  if (controlPlaneResolved === "hosted" && (runnerType === "process" || runnerType === "docker")) throw new RuntimeCapabilityError("hosted_runner_unsupported", "Hosted control planes cannot run process or Docker runners; use cloudflare_sandbox, github_actions, or a self_hosted worker.");
  if (runnerType === "self_hosted" && controlPlaneResolved === "hosted" && !selfHostedWorker) throw new RuntimeCapabilityError("hosted_self_hosted_worker_missing", "Hosted self_hosted runners require workerHost=self_hosted[:worker-id].");
  if (inferenceMode === "byok" && controlPlaneResolved === "hosted" && !(runnerType === "self_hosted" && selfHostedWorker)) throw new RuntimeCapabilityError("hosted_byok_boundary_missing", "BYOK inference on hosted control planes requires runner.type self_hosted and workerHost=self_hosted[:worker-id].");
  if (inferenceMode === "local" && controlPlaneResolved === "hosted" && !(runnerType === "self_hosted" && selfHostedWorker)) throw new RuntimeCapabilityError("hosted_local_inference_boundary_missing", "Local inference on hosted control planes requires a self_hosted worker boundary.");
  const image = typeof runnerRaw.image === "string" ? runnerRaw.image.trim() : defaults.runner.image;
  if (image && (!RUNNER_IMAGE_PATTERN.test(image) || image.includes(".."))) throw new Error("runtime.runner.image must be a safe container image or local runner identifier.");
  return {
    collaboration: (collaboration === "solo" || collaboration === "team" ? collaboration : defaults.collaboration) as CollaborationMode,
    controlPlane: controlPlaneResolved,
    pipeline: pipelineResolved,
    runner: {
      type: runnerType as RunnerKind,
      image,
      allowProcess: runnerRaw.allowProcess === true,
    },
    workerHost,
    inference: {
      mode: inferenceMode as InferenceMode,
      provider: normalizeInferenceProvider(inferenceRaw.provider, defaults.inference.provider),
      model: typeof inferenceRaw.model === "string" ? inferenceRaw.model : defaults.inference.model,
      credentialRef,
    },
    approval: (approval === "inline_self_review" || approval === "human_async" ? approval : defaults.approval) as ApprovalMode,
    sync: (syncRaw === "offline" || syncRaw === "manual" || syncRaw === "hosted" ? syncRaw : defaults.sync) as SyncMode,
  };
}

export function estimateCost(input: {
  profile: RuntimeProfile;
  plannedStages: string[];
  changedLines?: number;
}): CostEstimate {
  const stageCount = Math.max(1, input.plannedStages.length);
  const lines = Math.max(0, input.changedLines ?? 40);
  const estimatedInputTokens = stageCount * 800 + lines * 4;
  const estimatedOutputTokens = stageCount * 400;
  const tokens = estimatedInputTokens + estimatedOutputTokens;
  const managed = input.profile.inference.mode === "managed";
  const byok = input.profile.inference.mode === "byok";
  const cents = Math.ceil(tokens / 1000 * (managed ? 8 : byok ? 0 : 1));
  return {
    catalogVersion: INFERENCE_COST_CATALOG,
    provider: input.profile.inference.provider,
    model: input.profile.inference.model,
    plannedStages: input.plannedStages,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedDurationSeconds: stageCount * 45,
    managedCogsCents: managed ? cents : 0,
    byokSpendCents: byok ? Math.ceil(tokens / 1000 * 12) : 0,
    platformInvoice: "seats_only",
    confidence: input.changedLines == null ? "low" : "medium",
    rangeCents: { low: Math.max(0, cents - 4), high: cents + 12 },
  };
}

export function usageFromText(text: string, meta: { provider: string; model: string; managed: boolean; stage?: string; origin: RuntimeOrigin; retries?: number; latencyMs?: number }): ProviderUsage {
  const tokens = Math.ceil(text.length / 4);
  return {
    provider: meta.provider,
    model: meta.model,
    inputTokens: Math.ceil(tokens * 0.6),
    outputTokens: Math.ceil(tokens * 0.4),
    cachedTokens: 0,
    retries: meta.retries ?? 0,
    latencyMs: meta.latencyMs ?? 0,
    managed: meta.managed,
    stage: meta.stage,
    catalogVersion: INFERENCE_COST_CATALOG,
    runnerOrigin: meta.origin,
  };
}
