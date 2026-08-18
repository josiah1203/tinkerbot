import crypto from "node:crypto";

export const TINKERBOT_CHECK_NAME = "Tinkerbot Verify" as const;
export const LEGACY_CHECK_NAMES = ["PR Proof"] as const;
export const TINKERBOT_COMMENT_MARKER = "<!-- tinkerbot:verify -->" as const;
export const LEGACY_COMMENT_MARKERS = ["<!-- pr-proof:sticky -->"] as const;
export const SAFE_PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;
export const SAFE_INSTALLATION_ACTIONS = ["created", "deleted", "suspend", "unsuspend", "added", "removed"] as const;
export const MAX_CHECK_ANNOTATIONS = 50;

export type GitHubPermission = "none" | "read" | "write" | undefined;
export type GitHubPublishOperation = "check" | "comment" | "annotation";

export interface PullRequestEventShape {
  action?: string;
  number?: number;
  pull_request?: {
    head?: { sha?: string; ref?: string; repo?: { fork?: boolean; full_name?: string } };
    base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
  };
}

export interface InstallationRepositoryRecord {
  installationId: number;
  repositoryId: number;
  fullName: string;
  permissions?: Record<string, GitHubPermission>;
  suspended?: boolean;
}

export type InstallationRepositoryAccessState = "authorized" | "missing" | "suspended" | "mismatch";

export interface GitHubAuditEvent {
  eventId: string;
  action: string;
  installationId?: number;
  repositoryId?: number;
  repository?: string;
  deliveryId?: string;
  outcome: "accepted" | "degraded" | "rejected" | "duplicate";
  observedAt: string;
}

export interface WebhookAdmissionOptions {
  payload: string | Uint8Array;
  signature?: string;
  secret?: string;
  eventName?: string;
  deliveryId?: string;
}

export interface WebhookAdmissionResult {
  accepted: boolean;
  reason?: "invalid_signature" | "missing_delivery" | "malformed_payload" | "unsafe_event" | "unsafe_action";
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  audit: GitHubAuditEvent;
}

export interface GitHubFindingAnnotation {
  id?: string;
  fingerprint?: string;
  ruleId?: string;
  severity?: string;
  file?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  message?: string;
  title?: string;
}

export interface GitHubCheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string;
}

export function verifyWebhookSignature(payload: string | Uint8Array, signature: string | undefined, secret: string | undefined): boolean {
  if (!signature || !secret || !signature.startsWith("sha256=") || !/^[0-9a-f]{64}$/i.test(signature.slice(7))) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature.slice(7), "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function isSafePullRequestEvent(eventName: string | undefined, action: string | undefined): boolean {
  if (eventName === "workflow_dispatch") return true;
  return eventName === "pull_request" && SAFE_PULL_REQUEST_ACTIONS.includes(action as (typeof SAFE_PULL_REQUEST_ACTIONS)[number]);
}

function eventAction(payload: Record<string, unknown>): string | undefined {
  return typeof payload.action === "string" ? payload.action : undefined;
}

function eventRepository(payload: Record<string, unknown>): string | undefined {
  const repository = payload.repository;
  return repository && typeof repository === "object" && typeof (repository as { full_name?: unknown }).full_name === "string" ? (repository as { full_name: string }).full_name : undefined;
}

function eventNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return Number.isSafeInteger(value) ? value as number : undefined;
}

export function admitWebhook(options: WebhookAdmissionOptions): WebhookAdmissionResult {
  const deliveryId = deliveryIdempotencyKey(options.deliveryId, options.eventName);
  const baseAudit = { action: "webhook_received", deliveryId: options.deliveryId, repository: undefined, outcome: "rejected" as const };
  if (!deliveryId) return { accepted: false, reason: "missing_delivery", audit: createGitHubAuditEvent(baseAudit) };
  if (!verifyWebhookSignature(options.payload, options.signature, options.secret)) return { accepted: false, reason: "invalid_signature", idempotencyKey: deliveryId, audit: createGitHubAuditEvent({ ...baseAudit, deliveryId: options.deliveryId }) };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(typeof options.payload === "string" ? options.payload : new TextDecoder().decode(options.payload)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return { accepted: false, reason: "malformed_payload", idempotencyKey: deliveryId, audit: createGitHubAuditEvent({ ...baseAudit, deliveryId: options.deliveryId }) };
  }
  const eventName = options.eventName;
  const action = eventAction(payload);
  const safePullRequest = isSafePullRequestEvent(eventName, action);
  const safeInstallation = (eventName === "installation" || eventName === "installation_repositories") && (!action || SAFE_INSTALLATION_ACTIONS.includes(action as (typeof SAFE_INSTALLATION_ACTIONS)[number]));
  if (eventName === "pull_request_target" || (!safePullRequest && !safeInstallation)) {
    return { accepted: false, reason: eventName === "pull_request" || eventName === "installation" || eventName === "installation_repositories" ? "unsafe_action" : "unsafe_event", idempotencyKey: deliveryId, audit: createGitHubAuditEvent({ action: action ?? "webhook_rejected", deliveryId: options.deliveryId, repository: eventRepository(payload), installationId: eventNumber(payload, "installation_id"), repositoryId: eventNumber(payload, "repository_id"), outcome: "rejected" }) };
  }
  return {
    accepted: true,
    idempotencyKey: deliveryId,
    payload,
    audit: createGitHubAuditEvent({ action: action ?? "webhook_accepted", deliveryId: options.deliveryId, repository: eventRepository(payload), installationId: eventNumber(payload, "installation_id"), repositoryId: eventNumber(payload, "repository_id"), outcome: "accepted" }),
  };
}

export function isForkPullRequest(event: PullRequestEventShape): boolean {
  const forkFlag = event.pull_request?.head?.repo?.fork;
  const headRepository = event.pull_request?.head?.repo?.full_name;
  const baseRepository = event.pull_request?.base?.repo?.full_name;
  return forkFlag === true || Boolean(headRepository && baseRepository && headRepository !== baseRepository);
}

export function deliveryIdempotencyKey(deliveryId: string | undefined, eventName: string | undefined): string | undefined {
  if (!deliveryId || !/^[A-Za-z0-9._:-]{1,200}$/.test(deliveryId)) return undefined;
  return `github:${eventName && /^[A-Za-z0-9._:-]{1,80}$/.test(eventName) ? eventName : "unknown"}:${deliveryId}`;
}

function normalizedRepositoryName(value: string | undefined): string | undefined {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\.git$/, "").toLowerCase();
  if (!normalized || normalized.startsWith("/") || normalized.split("/").length !== 2 || normalized.split("/").some((part) => !/^[a-z0-9._-]+$/.test(part))) return undefined;
  return normalized;
}

export function installationRepositoryAccessState(records: readonly InstallationRepositoryRecord[], installationId: number | undefined, repositoryId: number | undefined, fullName: string | undefined): InstallationRepositoryAccessState {
  if (!Number.isSafeInteger(installationId) || !Number.isSafeInteger(repositoryId)) return "mismatch";
  const record = records.find((candidate) => candidate.installationId === installationId && candidate.repositoryId === repositoryId);
  if (!record) return "missing";
  if (record.suspended) return "suspended";
  return normalizedRepositoryName(record.fullName) === normalizedRepositoryName(fullName) ? "authorized" : "mismatch";
}

export function canAccessInstallationRepository(records: readonly InstallationRepositoryRecord[], installationId: number | undefined, repositoryId: number | undefined, fullName: string | undefined): boolean {
  return installationRepositoryAccessState(records, installationId, repositoryId, fullName) === "authorized";
}

export function redactGitHubSecrets(value: string, secrets: readonly string[] = []): string {
  let output = value;
  for (const secret of secrets) if (secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  return output.replace(/(?:gh[ps]_|github_pat_)[A-Za-z0-9_]{8,}/g, "[REDACTED]");
}

export function createGitHubAuditEvent(input: Omit<GitHubAuditEvent, "eventId" | "observedAt"> & { eventId?: string; observedAt?: string }): GitHubAuditEvent {
  const eventId = input.eventId && /^[A-Za-z0-9._:-]{1,200}$/.test(input.eventId) ? input.eventId : crypto.randomUUID();
  return {
    eventId,
    action: input.action.slice(0, 120),
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    repository: normalizedRepositoryName(input.repository),
    deliveryId: input.deliveryId && /^[A-Za-z0-9._:-]{1,200}$/.test(input.deliveryId) ? input.deliveryId : undefined,
    outcome: input.outcome,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export function canPublish(operation: GitHubPublishOperation, permissions: Record<string, GitHubPermission>, fork = false): boolean {
  // Fork runs are intentionally degraded even when a caller accidentally
  // passes a write-capable token. The customer runner remains authoritative.
  if (fork) return false;
  if (operation === "check" || operation === "annotation") return permissions.checks === "write";
  return permissions.issues === "write" || permissions.pull_requests === "write";
}

export function normalizeAnnotationPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function annotationLevel(severity: string | undefined): GitHubCheckAnnotation["annotation_level"] {
  return severity === "critical" || severity === "high" ? "failure" : severity === "warning" || severity === "medium" ? "warning" : "notice";
}

function oneLine(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/[\u0000-\u001f\u007f\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 2_000) || fallback;
}

export function mapCheckAnnotations(findings: readonly GitHubFindingAnnotation[], cap = MAX_CHECK_ANNOTATIONS): GitHubCheckAnnotation[] {
  const boundedCap = Math.max(0, Math.min(MAX_CHECK_ANNOTATIONS, Math.floor(cap)));
  const unique = new Map<string, GitHubFindingAnnotation>();
  for (const finding of findings) {
    const path = normalizeAnnotationPath(finding.file);
    const startLine = finding.startLine ?? finding.line;
    const endLine = finding.endLine ?? startLine;
    if (!path || typeof startLine !== "number" || typeof endLine !== "number" || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) continue;
    const key = finding.fingerprint || finding.id || `${path}:${startLine}:${finding.ruleId || "finding"}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()]
    .sort((left, right) => {
      const leftLine = left.startLine ?? left.line ?? 0;
      const rightLine = right.startLine ?? right.line ?? 0;
      return `${normalizeAnnotationPath(left.file) ?? ""}:${leftLine}:${left.ruleId ?? ""}:${left.fingerprint ?? left.id ?? ""}`.localeCompare(`${normalizeAnnotationPath(right.file) ?? ""}:${rightLine}:${right.ruleId ?? ""}:${right.fingerprint ?? right.id ?? ""}`);
    })
    .slice(0, boundedCap)
    .map((finding) => {
      const path = normalizeAnnotationPath(finding.file)!;
      const startLine = finding.startLine ?? finding.line!;
      const endLine = finding.endLine ?? startLine;
      return {
        path,
        start_line: startLine,
        end_line: endLine,
        annotation_level: annotationLevel(finding.severity),
        message: oneLine(finding.message, "Deterministic verification finding."),
        title: oneLine(finding.title || finding.ruleId, "Tinkerbot Verify"),
      } satisfies GitHubCheckAnnotation;
    });
}

export function checkConclusion(verdict: string): "success" | "failure" | "neutral" {
  if (verdict === "PASS") return "success";
  if (verdict === "FAIL") return "failure";
  return "neutral";
}

export function hasLegacyCommentMarker(body: string | undefined): boolean {
  return Boolean(body && [TINKERBOT_COMMENT_MARKER, ...LEGACY_COMMENT_MARKERS].some((marker) => body.includes(marker)));
}

export function stableFindingFingerprint(finding: GitHubFindingAnnotation): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({ ruleId: finding.ruleId ?? "", file: normalizeAnnotationPath(finding.file) ?? "repository", line: finding.startLine ?? finding.line ?? 0, message: oneLine(finding.message, "") })).digest("hex")}`;
}
