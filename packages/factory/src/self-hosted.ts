import crypto from "node:crypto";

/** Versioned, credential-free protocol between the hosted control plane and a customer worker. */
export const SELF_HOSTED_PROTOCOL_VERSION = 1 as const;
export const SELF_HOSTED_SECRET_MIN_BYTES = 32;

/** Production workers need an independently rotatable, non-placeholder HMAC key. */
export function selfHostedSecretReady(value: unknown): value is string {
  return typeof value === "string"
    && new TextEncoder().encode(value).byteLength >= SELF_HOSTED_SECRET_MIN_BYTES
    && !/(?:replace|placeholder|change[_ -]?me)/i.test(value);
}

export interface SelfHostedAuthority {
  mayMerge: false;
  mayRelease: false;
  mayWriteVerificationVerdict: false;
}

export interface SelfHostedDispatchPayload {
  protocolVersion: typeof SELF_HOSTED_PROTOCOL_VERSION;
  dispatchId: string;
  executionBoundary: "self_hosted";
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  runId: string;
  repository: string;
  sourceType: string;
  sourceId: string;
  definitionDigest: string;
  harness: string;
  /** Optional named worker target; when present the consumer must match it exactly. */
  workerHost?: string;
  model?: string;
  prompt: string;
  issuedAt: string;
  expiresAt: string;
  authority: SelfHostedAuthority;
}

export interface SelfHostedCompletionPayload {
  protocolVersion: typeof SELF_HOSTED_PROTOCOL_VERSION;
  dispatchId: string;
  executionBoundary: "self_hosted";
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  runId: string;
  repository: string;
  /** Required binding to the exact factory tree the worker executed. */
  definitionDigest: string;
  status: "completed" | "failed";
  branch?: string;
  headSha?: string;
  pullRequestNumber?: number;
  summary?: string;
  completedAt: string;
  authority: SelfHostedAuthority;
}

export interface SelfHostedIntegrity {
  algorithm: "hmac-sha256";
  digest: string;
  signed: true;
  signedAt: string;
  keyId: string;
}

export type SelfHostedDispatchEnvelope = SelfHostedDispatchPayload & { integrity: SelfHostedIntegrity };
export type SelfHostedCompletionEnvelope = SelfHostedCompletionPayload & { integrity: SelfHostedIntegrity };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[A-Fa-f0-9]{7,128}$/;
// A self-hosted worker may propose only the factory-owned scratch namespace;
// protected/default/release refs must never be smuggled in as a completion.
const BRANCH_PATTERN = /^tinkerbot\/[A-Za-z0-9_-]{1,64}$/;
const SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._/@:-]{0,255}$/;
const WORKER_HOST_PATTERN = /^self_hosted(?::[a-z0-9._-]{1,64})?$/;
const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|(?:xai|pplx)-[A-Za-z0-9_-]{8,}|(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|signing[_-]?secret|webhook[_-]?secret)\s*[:=])/i;
const AUTHORITY: SelfHostedAuthority = Object.freeze({ mayMerge: false, mayRelease: false, mayWriteVerificationVerdict: false });
const DISPATCH_FIELDS = new Set([
  "protocolVersion", "dispatchId", "executionBoundary", "organizationId", "factoryId", "workOrderId", "runId",
  "repository", "sourceType", "sourceId", "definitionDigest", "harness", "workerHost", "model", "prompt", "issuedAt", "expiresAt", "authority",
]);
const COMPLETION_FIELDS = new Set([
  "protocolVersion", "dispatchId", "executionBoundary", "organizationId", "factoryId", "workOrderId", "runId",
  "repository", "definitionDigest", "status", "branch", "headSha", "pullRequestNumber", "summary", "completedAt", "authority",
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  return value;
}

function digest(payload: unknown, secret: string): string {
  return `sha256:${crypto.createHmac("sha256", secret).update(JSON.stringify(canonicalize(payload))).digest("hex")}`;
}

function integrityFor(payload: unknown, secret: string, now: string, keyId: string): SelfHostedIntegrity {
  return { algorithm: "hmac-sha256", digest: digest(payload, secret), signed: true, signedAt: now, keyId };
}

function validString(value: unknown, pattern: RegExp, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validAuthority(value: unknown): value is SelfHostedAuthority {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 3
    && (value as Record<string, unknown>).mayMerge === false
    && (value as Record<string, unknown>).mayRelease === false
    && (value as Record<string, unknown>).mayWriteVerificationVerdict === false);
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validIntegrity(value: unknown): value is SelfHostedIntegrity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const integrity = value as Record<string, unknown>;
  return Object.keys(integrity).length === 5 && integrity.algorithm === "hmac-sha256" && integrity.signed === true && typeof integrity.digest === "string" && DIGEST_PATTERN.test(integrity.digest) && validTime(integrity.signedAt) && validString(integrity.keyId, /^[A-Za-z0-9._:-]{1,128}$/, 128);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyEnvelope(value: unknown, secret: string, now = new Date().toISOString()): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  if (!secret || !value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_envelope" };
  const envelope = value as Record<string, unknown>;
  const integrity = envelope.integrity;
  if (!validIntegrity(integrity)) return { ok: false, reason: "invalid_integrity" };
  const { integrity: ignored, ...payload } = envelope;
  void ignored;
  if (!hasOnlyFields(payload, DISPATCH_FIELDS) && !hasOnlyFields(payload, COMPLETION_FIELDS)) return { ok: false, reason: "unknown_payload_fields" };
  if (!constantTimeEqual(integrity.digest, digest(payload, secret))) return { ok: false, reason: "signature_mismatch" };
  const issuedAt = typeof payload.issuedAt === "string" ? Date.parse(payload.issuedAt) : NaN;
  const expiresAt = typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : NaN;
  const current = Date.parse(now);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(current) || issuedAt > current + 60_000 || expiresAt <= current || expiresAt <= issuedAt || expiresAt - issuedAt > 86_400_000) return { ok: false, reason: "expired_or_invalid_window" };
  return { ok: true, payload };
}

export function createSelfHostedDispatch(input: Omit<SelfHostedDispatchPayload, "protocolVersion" | "issuedAt" | "expiresAt" | "authority"> & { secret: string; now?: string; ttlSeconds?: number; keyId?: string }): SelfHostedDispatchEnvelope {
  const { secret, now: requestedNow, ttlSeconds, keyId, ...fields } = input;
  const issuedAt = requestedNow ?? new Date().toISOString();
  if (!validTime(issuedAt) || (ttlSeconds != null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0))) throw new Error("Self-hosted dispatch timestamp or TTL is invalid.");
  const expiresAt = new Date(Date.parse(issuedAt) + Math.min(Math.max(ttlSeconds ?? 900, 60), 86_400) * 1_000).toISOString();
  const payload: SelfHostedDispatchPayload = { ...fields, protocolVersion: SELF_HOSTED_PROTOCOL_VERSION, issuedAt, expiresAt, authority: AUTHORITY };
  if (!validString(payload.dispatchId, ID_PATTERN) || !validString(payload.workOrderId, ID_PATTERN) || !validString(payload.runId, ID_PATTERN) || !validString(payload.organizationId, ID_PATTERN) || !validString(payload.factoryId, ID_PATTERN) || !validString(payload.sourceType, SOURCE_TYPE_PATTERN) || !validString(payload.sourceId, ID_PATTERN) || !REPOSITORY_PATTERN.test(payload.repository) || !validString(payload.definitionDigest, DIGEST_PATTERN) || !validString(payload.harness, /^[a-z][a-z0-9._-]{0,63}$/) || (payload.workerHost != null && !validString(payload.workerHost, WORKER_HOST_PATTERN, 80)) || (payload.model != null && (!validString(payload.model, MODEL_PATTERN) || SECRET_PATTERN.test(payload.model))) || !validString(payload.prompt, /^[\s\S]+$/, 16_000) || SECRET_PATTERN.test(payload.prompt)) throw new Error("Self-hosted dispatch payload is invalid or contains a credential.");
  if (!secret) throw new Error("Self-hosted dispatch signing secret is required.");
  return { ...payload, integrity: integrityFor(payload, secret, issuedAt, keyId ?? "self-hosted-dispatch-v1") };
}

export function verifySelfHostedDispatch(value: unknown, secret: string, now?: string): { ok: true; payload: SelfHostedDispatchPayload } | { ok: false; reason: string } {
  const verified = verifyEnvelope(value, secret, now);
  if (!verified.ok) return verified;
  const payload = verified.payload;
  const integrity = (value as Record<string, unknown>).integrity as SelfHostedIntegrity;
  if (integrity.signedAt !== payload.issuedAt) return { ok: false, reason: "integrity_timestamp_mismatch" };
  if (payload.protocolVersion !== SELF_HOSTED_PROTOCOL_VERSION || payload.executionBoundary !== "self_hosted" || !validAuthority(payload.authority)
    || !validString(payload.dispatchId, ID_PATTERN) || !validString(payload.workOrderId, ID_PATTERN) || !validString(payload.runId, ID_PATTERN)
    || !validString(payload.organizationId, ID_PATTERN) || !validString(payload.factoryId, ID_PATTERN) || !validString(payload.sourceType, SOURCE_TYPE_PATTERN) || !validString(payload.sourceId, ID_PATTERN)
    || !REPOSITORY_PATTERN.test(String(payload.repository)) || !validString(payload.definitionDigest, DIGEST_PATTERN) || (payload.workerHost != null && !validString(payload.workerHost, WORKER_HOST_PATTERN, 80))
    || !validString(payload.harness, /^[a-z][a-z0-9._-]{0,63}$/) || (payload.model != null && (!validString(payload.model, MODEL_PATTERN) || SECRET_PATTERN.test(String(payload.model)))) || typeof payload.prompt !== "string" || payload.prompt.length > 16_000 || SECRET_PATTERN.test(payload.prompt)) return { ok: false, reason: "invalid_dispatch_payload" };
  return { ok: true, payload: payload as unknown as SelfHostedDispatchPayload };
}

export function createSelfHostedCompletion(input: Omit<SelfHostedCompletionPayload, "protocolVersion" | "completedAt" | "authority"> & { secret: string; completedAt?: string; keyId?: string }): SelfHostedCompletionEnvelope {
  const { secret, completedAt: requestedCompletedAt, keyId, ...fields } = input;
  const completedAt = requestedCompletedAt ?? new Date().toISOString();
  if (!validTime(completedAt)) throw new Error("Self-hosted completion timestamp is invalid.");
  const payload: SelfHostedCompletionPayload = { ...fields, protocolVersion: SELF_HOSTED_PROTOCOL_VERSION, completedAt, authority: AUTHORITY };
  if (!validString(payload.dispatchId, ID_PATTERN) || !validString(payload.workOrderId, ID_PATTERN) || !validString(payload.runId, ID_PATTERN) || !validString(payload.organizationId, ID_PATTERN) || !validString(payload.factoryId, ID_PATTERN) || !REPOSITORY_PATTERN.test(payload.repository) || !validString(payload.definitionDigest, DIGEST_PATTERN) || !["completed", "failed"].includes(payload.status) || (payload.branch != null && (!validString(payload.branch, BRANCH_PATTERN) || payload.branch.includes(".."))) || (payload.headSha != null && !COMMIT_PATTERN.test(payload.headSha)) || (payload.pullRequestNumber != null && (!Number.isInteger(payload.pullRequestNumber) || payload.pullRequestNumber < 1 || payload.pullRequestNumber > 1_000_000_000)) || (payload.summary != null && (typeof payload.summary !== "string" || payload.summary.length > 8_000 || SECRET_PATTERN.test(payload.summary))) || !validTime(payload.completedAt)) throw new Error("Self-hosted completion payload is invalid.");
  if (payload.status === "completed" && !payload.branch && !payload.headSha && payload.pullRequestNumber == null) throw new Error("A completed self-hosted run must identify a branch, commit, or pull request.");
  if (!secret) throw new Error("Self-hosted completion signing secret is required.");
  return { ...payload, integrity: integrityFor(payload, secret, completedAt, keyId ?? "self-hosted-completion-v1") };
}

export function verifySelfHostedCompletion(value: unknown, secret: string, now?: string): { ok: true; payload: SelfHostedCompletionPayload } | { ok: false; reason: string } {
  if (!secret || !value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_completion" };
  const envelope = value as Record<string, unknown>;
  const integrity = envelope.integrity;
  if (!validIntegrity(integrity)) return { ok: false, reason: "invalid_integrity" };
  const { integrity: ignored, ...payload } = envelope;
  void ignored;
  if (!hasOnlyFields(payload, COMPLETION_FIELDS)) return { ok: false, reason: "unknown_payload_fields" };
  if (!constantTimeEqual(integrity.digest, digest(payload, secret))) return { ok: false, reason: "signature_mismatch" };
  if (integrity.signedAt !== payload.completedAt) return { ok: false, reason: "integrity_timestamp_mismatch" };
  const current = Date.parse(now ?? new Date().toISOString());
  const completedAt = typeof payload.completedAt === "string" ? Date.parse(payload.completedAt) : NaN;
  if (!Number.isFinite(current) || !Number.isFinite(completedAt) || completedAt > current + 60_000 || completedAt < current - 86_400_000) return { ok: false, reason: "invalid_completion_time" };
  if (payload.protocolVersion !== SELF_HOSTED_PROTOCOL_VERSION || payload.executionBoundary !== "self_hosted" || !validAuthority(payload.authority)
    || !validString(payload.dispatchId, ID_PATTERN) || !validString(payload.workOrderId, ID_PATTERN) || !validString(payload.runId, ID_PATTERN)
    || !validString(payload.organizationId, ID_PATTERN) || !validString(payload.factoryId, ID_PATTERN) || !REPOSITORY_PATTERN.test(String(payload.repository)) || !validString(payload.definitionDigest, DIGEST_PATTERN)
    || !["completed", "failed"].includes(String(payload.status)) || (payload.branch != null && (!validString(payload.branch, BRANCH_PATTERN) || String(payload.branch).includes("..")))
    || (payload.headSha != null && !COMMIT_PATTERN.test(String(payload.headSha))) || (payload.pullRequestNumber != null && (!Number.isInteger(payload.pullRequestNumber) || Number(payload.pullRequestNumber) < 1 || Number(payload.pullRequestNumber) > 1_000_000_000))
    || (payload.summary != null && (typeof payload.summary !== "string" || payload.summary.length > 8_000 || SECRET_PATTERN.test(payload.summary)))) return { ok: false, reason: "invalid_completion_payload" };
  if (payload.status === "completed" && !payload.branch && !payload.headSha && payload.pullRequestNumber == null) return { ok: false, reason: "missing_change_reference" };
  return { ok: true, payload: payload as unknown as SelfHostedCompletionPayload };
}
