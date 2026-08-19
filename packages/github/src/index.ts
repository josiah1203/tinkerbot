import crypto from "node:crypto";

export const TINKERBOT_CHECK_NAME = "Tinkerbot Verify" as const;
export const LEGACY_CHECK_NAMES = ["PR Proof"] as const;
export const TINKERBOT_COMMENT_MARKER = "<!-- tinkerbot:verify -->" as const;
export const LEGACY_COMMENT_MARKERS = ["<!-- pr-proof:sticky -->"] as const;
export const SAFE_PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;
export const SAFE_ISSUE_ACTIONS = ["opened", "reopened", "edited"] as const;
export const SAFE_INSTALLATION_ACTIONS = ["created", "deleted", "suspend", "unsuspend", "added", "removed"] as const;
export const SAFE_SECURITY_EVENTS = ["dependabot_alert", "code_scanning_alert", "secret_scanning_alert"] as const;
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
  const safeIssue = eventName === "issues" && SAFE_ISSUE_ACTIONS.includes(action as (typeof SAFE_ISSUE_ACTIONS)[number]);
  const safeInstallation = (eventName === "installation" || eventName === "installation_repositories") && (!action || SAFE_INSTALLATION_ACTIONS.includes(action as (typeof SAFE_INSTALLATION_ACTIONS)[number]));
  const safeSecurity = Boolean(eventName && (SAFE_SECURITY_EVENTS as readonly string[]).includes(eventName));
  if (eventName === "pull_request_target" || (!safePullRequest && !safeIssue && !safeInstallation && !safeSecurity)) {
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

export interface InlineReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  commit_id: string;
}

export function sanitizePublicationBody(value: string, secrets: readonly string[] = [], limit = 8_000): string {
  return redactGitHubSecrets(oneLine(value, "Tinkerbot factory update."), secrets).slice(0, limit);
}

export function inlineReviewComments(findings: readonly GitHubFindingAnnotation[], commitSha: string, dashboardUrl: string, cap = 20): InlineReviewComment[] {
  if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) return [];
  return mapCheckAnnotations(findings, cap).map((annotation) => ({
    path: annotation.path,
    line: annotation.start_line,
    side: "RIGHT" as const,
    commit_id: commitSha,
    body: sanitizePublicationBody(`${annotation.title}: ${annotation.message}\n\n[Open in Tinkerbot](${dashboardUrl})`),
  }));
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 600, iss: appId })).toString("base64url");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem, "base64url")}`;
}

export async function mintInstallationToken(options: { appId: string; privateKeyPem: string; installationId: number; apiBaseUrl?: string; fetcher?: typeof fetch; now?: number }): Promise<string> {
  const jwt = createGitHubAppJwt(options.appId, options.privateKeyPem, options.now);
  const base = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${base}/app/installations/${options.installationId}/access_tokens`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub installation token mint failed (${response.status}).`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error("GitHub installation token mint returned no token.");
  return body.token;
}

export interface GitHubPublisherRequest {
  token: string;
  repository: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}

async function githubApi(request: GitHubPublisherRequest, method: string, pathname: string, body?: unknown): Promise<Response> {
  const base = (request.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetcher = request.fetcher ?? fetch;
  return fetcher(`${base}${pathname}`, { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${request.token}`, "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

export async function publishCheckRun(request: GitHubPublisherRequest, input: { headSha: string; verdict: string; summary: string; annotations: GitHubCheckAnnotation[]; detailsUrl?: string }): Promise<number | undefined> {
  const response = await githubApi(request, "POST", `/repos/${request.repository}/check-runs`, {
    name: TINKERBOT_CHECK_NAME,
    head_sha: input.headSha,
    status: "completed",
    conclusion: checkConclusion(input.verdict),
    details_url: input.detailsUrl,
    output: { title: TINKERBOT_CHECK_NAME, summary: sanitizePublicationBody(input.summary, [], 64_000), annotations: input.annotations.slice(0, MAX_CHECK_ANNOTATIONS) },
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { id?: number };
  return payload.id;
}

export async function publishInlineComments(request: GitHubPublisherRequest, pullNumber: number, comments: InlineReviewComment[], event: "COMMENT" | "REQUEST_CHANGES" = "COMMENT"): Promise<boolean> {
  if (!comments.length) return true;
  const response = await githubApi(request, "POST", `/repos/${request.repository}/pulls/${pullNumber}/reviews`, { commit_id: comments[0]?.commit_id, event, comments: comments.slice(0, 20) });
  return response.ok;
}

export async function dispatchGitHubEnvironmentWorkflow(request: GitHubPublisherRequest, input: { workflow: string; ref: string; environment?: string }): Promise<boolean> {
  const response = await githubApi(request, "POST", `/repos/${request.repository}/actions/workflows/${input.workflow}/dispatches`, { ref: input.ref, inputs: input.environment ? { environment: input.environment } : {} });
  return response.ok;
}

export async function createImplementPullRequest(request: GitHubPublisherRequest, input: { title: string; head: string; base?: string; body: string }): Promise<number | undefined> {
  if (input.head === "main" || input.head === "master" || input.head === "production") return undefined;
  const response = await githubApi(request, "POST", `/repos/${request.repository}/pulls`, { title: input.title, head: input.head, base: input.base ?? "main", body: sanitizePublicationBody(input.body) });
  if (!response.ok) return undefined;
  const payload = await response.json() as { number?: number };
  return typeof payload.number === "number" ? payload.number : undefined;
}

export function githubEventKind(eventName: string | undefined): "installation" | "pull_request" | "issue" | "dependabot" | "code_scanning" | "secret_scanning" | "deployment" | "check_run" | "other" {
  if (eventName === "installation" || eventName === "installation_repositories") return "installation";
  if (eventName === "pull_request") return "pull_request";
  if (eventName === "issues") return "issue";
  if (eventName === "dependabot_alert") return "dependabot";
  if (eventName === "code_scanning_alert") return "code_scanning";
  if (eventName === "secret_scanning_alert") return "secret_scanning";
  if (eventName === "deployment" || eventName === "deployment_status") return "deployment";
  if (eventName === "check_run" || eventName === "workflow_run") return "check_run";
  return "other";
}

export function githubInstallationAccount(payload: Record<string, unknown>): { id?: number; login?: string } {
  const installation = payload.installation && typeof payload.installation === "object" ? payload.installation as Record<string, unknown> : {};
  const account = (installation.account && typeof installation.account === "object" ? installation.account : payload.account && typeof payload.account === "object" ? payload.account : {}) as Record<string, unknown>;
  return { id: typeof account.id === "number" ? account.id : undefined, login: typeof account.login === "string" ? account.login : undefined };
}
