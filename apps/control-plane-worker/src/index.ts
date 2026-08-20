import {
  D1AuthSessionStore,
  D1BillingStore,
  D1DatabaseLike,
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  HostedSession,
  TenantEntitlement,
  TenantInvitation,
  TenantMembership,
  TenantRole,
  WorkOSWebhookEvent,
  normalizeWorkOSMembership,
  ProviderError,
  StripeBillingProvider,
  WorkOSAuthProvider,
  hostedProviderConfig,
  normalizeWorkOSInvitation,
  providerStatuses,
  evidenceStoreFromEnv,
} from "../../../packages/hosted-integrations/src";
import { admitWebhook, githubEventKind, githubInstallationAccount, inlineReviewComments, mintInstallationToken, publishCheckRun, publishInlineComments, mapCheckAnnotations } from "../../../packages/github/src";
import { admitGitlabWebhook } from "../../../packages/gitlab/src";
import { D1FactoryStore } from "./factory-store";
import { ForemanDurableObject, Sandbox, handleFactoryMcpRequest, intakeFromIntegration, runFactoryTurn, routeFactoryQueueMessage, classifyWorkOrderGroup, githubSecurityIntake, sweepFactoryOs } from "./factory-runtime";
import { assertCredentialRef, calculateFactoryEconomics, createWorkOrder, projectFactoryEvents, verifyOidcJwt, oidcReplayKey, containsRawCredentials, customerProviderLabel, dispatchTinkerGateway, githubTinkerMention, sameActorApprovalBlocked, selfHostedSecretReady, verifySelfHostedCompletion, canonicalize, implementBranchName } from "../../../packages/factory/src";
import { translateLegacyVerdict } from "../../../packages/core/src/verdict";
import { createChangeSet, assessChangeSet, assessReleaseSafety, createReleaseManifest } from "../../../packages/assurance/src";
import { calculateEntitlements, type EntitlementKey } from "../../../packages/control-plane/src";
import {
  applyStripeEvent,
  checkoutPlanAllowed,
  entitlementDenied,
  entitlementsForOrganization,
  expireTrials,
  productionCatalogUnavailable,
  publicCatalogResponse,
  recordBillingAudit,
  recordSeatTransition,
  snapshotEntitlements,
  startTeamTrial,
  syncStripeQuantity,
  type CheckoutMapping,
} from "./billing";
export { ForemanDurableObject, Sandbox };

interface Env extends Record<string, unknown> {
  ENVIRONMENT?: string;
  WORKER_NAME?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  WORKOS_WEBHOOK_SECRET?: string;
  WORKOS_EVENTS_SYNC_ENABLED?: string;
  WORKOS_EVENTS_RANGE_START?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PLANS_JSON?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITLAB_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  JIRA_WEBHOOK_SECRET?: string;
  INCIDENT_WEBHOOK_SECRET?: string;
  SUPPORT_WEBHOOK_SECRET?: string;
  INTEGRATION_ORGANIZATION_ID?: string;
  EVIDENCE_EXPORT_ENDPOINT?: string;
  EVIDENCE_EXPORT_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ACTION_OIDC_AUDIENCE?: string;
  SESSION_ENCRYPTION_KEY?: string;
  WORKOS_REDIRECT_URI?: string;
  CONTROL_PLANE_URL?: string;
  DB?: D1DatabaseLike;
  EVIDENCE_BUCKET?: { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; get(key: string): Promise<{ text(): Promise<string> } | null>; delete(key: string): Promise<void> };
  AI?: { run(model: string, input: { messages: Array<{ role: string; content: string }> }, options?: { gateway?: { id: string; collectLog?: boolean; metadata?: Record<string, string> } }): Promise<{ response?: string }> };
  FACTORY_EVENTS?: { send(body: unknown): Promise<void> };
  SELF_HOSTED_WORK?: { send(body: unknown): Promise<void> };
  SELF_HOSTED_WORK_ENDPOINT?: string;
  SELF_HOSTED_WORK_SECRET?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  FOREMAN?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: Request): Promise<Response> } };
  FACTORY_RUN?: { create(options: { id: string; params: unknown }): Promise<unknown> };
  AI_GATEWAY_ID?: string;
  BROWSER?: unknown;
  Sandbox?: unknown;
}

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...headers } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProviderError) return json({ error: error.message, code: error.code ?? "provider_error", provider: error.provider }, error.code === "provider_not_configured" ? 503 : 502);
  if (error instanceof RequestBodyTooLargeError) return json({ error: "The request body is too large.", code: "payload_too_large" }, 413);
  return json({ error: "The hosted control-plane request could not be completed.", code: "internal_error" }, 500);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const prefix = `${name}=`;
  const value = cookies.find((item) => item.trim().startsWith(prefix))?.trim().slice(prefix.length);
  try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
}

function expired(session: HostedSession): boolean {
  return Boolean(session.expiresAt && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) <= Date.now());
}

function sessionCookie(sessionId: string): string {
  return `tinkerbot_session=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function jsonWithCookies(value: unknown, status: number, cookies: string[]): Response {
  const headers = new Headers(jsonHeaders);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function publicSession(session: HostedSession): Record<string, unknown> {
  return { user: session.user, organizationId: session.organizationId, expiresAt: session.expiresAt, authenticationMethod: session.authenticationMethod };
}

function sessionStore(env: Env, config: Awaited<ReturnType<typeof hostedProviderConfig>>): D1AuthSessionStore | null {
  const keyReady = Boolean(config.sessionEncryptionKey) && (config.environment !== "production" || selfHostedSecretReady(config.sessionEncryptionKey));
  return env.DB && keyReady ? new D1AuthSessionStore(env.DB, config.sessionEncryptionKey!) : null;
}

async function currentSession(request: Request, store: D1AuthSessionStore, env?: Env): Promise<{ id: string; session: HostedSession } | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
  const id = bearer ?? cookieValue(request, "tinkerbot_session");
  if (!id) return null;
  const session = await store.get(id);
  if (session) return { id, session };
  if (!bearer || !env?.DB || !bearer.startsWith("tb_")) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
  const tokenHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const row = await env.DB.prepare("SELECT credential_id, organization_id, revoked_at FROM tinkerbot_service_credentials WHERE token_hash = ?1").bind(tokenHash).first<{ credential_id: string; organization_id: string; revoked_at?: string | null }>();
  if (!row || row.revoked_at) return null;
  await env.DB.prepare("UPDATE tinkerbot_service_credentials SET last_used_at = ?2 WHERE credential_id = ?1").bind(row.credential_id, new Date().toISOString()).run();
  return {
    id: bearer,
    session: {
      user: { id: row.credential_id, email: `${row.credential_id}@service.tinkerbot` },
      organizationId: row.organization_id,
      accessToken: bearer,
      refreshToken: "",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      authenticationMethod: "service_credential",
    },
  };
}

interface AuthorizedSession {
  ok: true;
  current: { id: string; session: HostedSession };
  membership: TenantMembership;
  entitlements: TenantEntitlement | null;
}

interface AuthorizationFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

const INVITATION_ROLES: TenantRole[] = ["maintainer", "reviewer", "viewer"];

type TenantCapability = "tenant:read" | "tenant:admin" | "factory:write" | "work:operate" | "ops:read" | "billing:read" | "billing:manage" | "invitations:read" | "invitations:create" | "assurance:read" | "assurance:write" | "assurance:delete";

const ROLE_CAPABILITIES: Record<TenantRole, readonly TenantCapability[]> = {
  owner: ["tenant:read", "tenant:admin", "factory:write", "work:operate", "ops:read", "billing:read", "billing:manage", "invitations:read", "invitations:create", "assurance:read", "assurance:write", "assurance:delete"],
  admin: ["tenant:read", "tenant:admin", "factory:write", "work:operate", "ops:read", "billing:read", "billing:manage", "invitations:read", "invitations:create", "assurance:read", "assurance:write", "assurance:delete"],
  billing_administrator: ["tenant:read", "billing:read", "billing:manage"],
  maintainer: ["tenant:read", "factory:write", "work:operate", "assurance:read", "assurance:write"],
  reviewer: ["tenant:read", "assurance:read"],
  viewer: ["tenant:read", "assurance:read"],
};

export function roleHasCapability(role: TenantRole, capability: TenantCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

async function authorizeTenantSession(current: { id: string; session: HostedSession } | null, tenants: D1TenantStore, requiredCapability?: TenantCapability): Promise<AuthorizedSession | AuthorizationFailure> {
  if (!current) return { ok: false, status: 401, code: "not_authenticated", error: "Authentication is required." };
  if (expired(current.session)) return { ok: false, status: 401, code: "session_expired", error: "The authenticated session has expired." };
  const organizationId = current.session.organizationId;
  if (!organizationId) return { ok: false, status: 403, code: "organization_not_selected", error: "The authenticated user is not associated with an organization." };
  const membership = await tenants.getMembership(current.session.user.id, organizationId);
  if (!membership || membership.status !== "active") return { ok: false, status: 403, code: "not_a_member", error: "The authenticated user is not an active member of this organization." };
  if (requiredCapability && !roleHasCapability(membership.role, requiredCapability)) return { ok: false, status: 403, code: "insufficient_role", error: "The authenticated user is not authorized for this action." };
  return { ok: true, current, membership, entitlements: await tenants.getEntitlements(organizationId) };
}

function publicAccess(access: AuthorizedSession): Record<string, unknown> {
  return { authorized: true, organizationId: access.membership.organizationId, role: access.membership.role, entitlements: access.entitlements };
}

function publicUsageKind(kind: string): string {
  if (kind === "workers-ai" || kind.startsWith("workers-ai") || kind.toLowerCase().includes("workers-ai")) return "Tinkerbot hosted inference";
  return customerProviderLabel(kind) ?? kind;
}

function publicUsage(rows: Array<{ kind: string; tokens: number; costCents: number; createdAt: string }>): Array<{ kind: string; tokens: number; createdAt: string }> {
  return rows.map((row) => ({ kind: publicUsageKind(row.kind), tokens: row.tokens, createdAt: row.createdAt }));
}

async function boundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* the bounded request is already being rejected */ }
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function jsonBody(request: Request, maxBytes = 1_500_000): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await boundedRequestText(request, maxBytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return null;
  }
}

async function calculatedAccess(env: Env, access: AuthorizedSession) {
  if (!env.DB) return calculateEntitlements({ planId: access.entitlements?.planId, billingStatus: access.entitlements?.billingStatus });
  return entitlementsForOrganization(env.DB, access.membership.organizationId, access.entitlements);
}

function entitledFailureFrom(calculated: Awaited<ReturnType<typeof entitlementsForOrganization>>, feature: EntitlementKey, mutation = true): Response | null {
  const denied = entitlementDenied(calculated, feature, mutation);
  return denied ? json(denied, 403) : null;
}

function invitationRole(value: unknown): TenantRole | null {
  return typeof value === "string" && INVITATION_ROLES.includes(value as TenantRole) ? value as TenantRole : null;
}

function invitationEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function publicInvitation(invitation: TenantInvitation): Record<string, unknown> {
  return {
    invitationId: invitation.invitationId,
    organizationId: invitation.organizationId,
    email: invitation.email,
    role: invitation.role,
    state: invitation.state,
    ...(invitation.expiresAt ? { expiresAt: invitation.expiresAt } : {}),
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

function assuranceRepository(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim();
}

function containsUntrustedSource(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsUntrustedSource(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (["sourcecode", "fulldiff", "patch", "diff", "diffcontent", "secret", "token", "apikey", "password", "credential", "privatekey"].includes(normalizedKey)) return true;
    if (containsUntrustedSource(child, depth + 1)) return true;
  }
  return false;
}

function validateHostedAssuranceBundle(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Assurance metadata must be an object." };
  const bundle = value as Record<string, unknown>;
  if (bundle.schemaVersion !== 1 || bundle.schemaId !== "https://tinkerbot.dev/schemas/assurance/v1") return { ok: false, error: "Unsupported assurance schema version." };
  for (const field of ["receipts", "graphs", "lifecycleEvents", "agentReceipts", "changeSets", "releaseManifests", "releaseAssessments", "outcomes", "decisions", "bindings", "calibrationEvents", "unknowns"]) if (!Array.isArray(bundle[field])) return { ok: false, error: `Assurance field ${field} must be an array.` };
  if (containsUntrustedSource(bundle)) return { ok: false, error: "Source, full diffs, secrets, and credentials are not accepted by hosted assurance ingestion." };
  if (JSON.stringify(bundle).length > 1_500_000) return { ok: false, error: "Assurance metadata is too large." };
  return { ok: true, value: bundle };
}

/**
 * The action bundle is untrusted input even after OIDC admission. Verify the
 * receipt's content hash and bind it to the repository/commit carried by the
 * short-lived run token before it can advance a hosted run. This mirrors the
 * provider-neutral receipt digest without importing the Node-only assurance
 * package into the Worker bundle.
 */
async function verifyHostedReceipt(value: unknown, expected: { repository: string; sha?: string }): Promise<{ ok: true; receipt: Record<string, unknown> } | { ok: false; error: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Assurance receipt must be an object." };
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== 1 || receipt.schemaId !== "https://tinkerbot.dev/schemas/assurance/v1" || receipt.kind !== "verification-receipt") return { ok: false, error: "Assurance receipt schema is unsupported." };
  const integrity = receipt.integrity && typeof receipt.integrity === "object" && !Array.isArray(receipt.integrity) ? receipt.integrity as Record<string, unknown> : undefined;
  if (!integrity || integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(integrity.digest)) return { ok: false, error: "Assurance receipt integrity is invalid." };
  const { integrity: _ignored, ...payload } = receipt;
  const digest = `sha256:${hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonicalize(payload)))))}`;
  if (!constantTimeTextEqual(integrity.digest, digest)) return { ok: false, error: "Assurance receipt integrity does not match its payload." };
  if (typeof receipt.repository !== "string" || receipt.repository.toLowerCase() !== expected.repository.toLowerCase()) return { ok: false, error: "Assurance receipt repository does not match the run token." };
  if (expected.sha && receipt.headSha !== expected.sha) return { ok: false, error: "Assurance receipt commit does not match the run token." };
  return { ok: true, receipt };
}

function assuranceMetadataKey(organizationId: string, repository: string): string {
  return `assurance:${encodeURIComponent(organizationId)}:${encodeURIComponent(repository)}`;
}

function githubNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function githubText(value: unknown, maximum = 300): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

async function persistGitHubRepository(database: D1DatabaseLike, installationId: number, value: unknown, status: "active" | "removed" | "suspended", updatedAt: string): Promise<void> {
  const repository = workerRecordValue(value);
  const repositoryId = githubNumber(repository.id);
  const fullName = githubText(repository.full_name);
  if (!repositoryId || !fullName) return;
  await database.prepare("INSERT INTO tinkerbot_github_repositories (repository_id, installation_id, full_name, visibility, status, permissions_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(repository_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, visibility = excluded.visibility, status = excluded.status, permissions_json = excluded.permissions_json, updated_at = excluded.updated_at")
    .bind(repositoryId, installationId, fullName.toLowerCase(), githubText(repository.visibility, 40) ?? null, status, JSON.stringify(workerRecordValue(repository.permissions)), updatedAt).run();
}

async function persistGitHubWebhook(database: D1DatabaseLike, payload: Record<string, unknown>, eventName: string | undefined): Promise<{ kind: ReturnType<typeof githubEventKind>; installationId?: number; repository?: string; sourceId?: string; sha?: string }> {
  const kind = githubEventKind(eventName);
  const installation = workerRecordValue(payload.installation);
  const installationId = githubNumber(installation.id) ?? githubNumber(payload.installation_id);
  const now = new Date().toISOString();
  if (kind === "installation" && installationId) {
    const action = githubText(payload.action, 80) ?? "";
    const account = githubInstallationAccount(payload);
    const status = action === "deleted" ? "deleted" : action === "suspend" ? "suspended" : "active";
    await database.prepare("INSERT INTO tinkerbot_github_installations (installation_id, account_id, account_login, status, installed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(installation_id) DO UPDATE SET account_id = COALESCE(excluded.account_id, tinkerbot_github_installations.account_id), account_login = COALESCE(excluded.account_login, tinkerbot_github_installations.account_login), status = excluded.status, updated_at = excluded.updated_at")
      .bind(installationId, account.id ?? null, account.login ?? null, status, now, now).run();
    const repositoryStatus = status === "suspended" ? "suspended" : action === "removed" ? "removed" : "active";
    for (const repository of [...(Array.isArray(payload.repositories) ? payload.repositories : []), ...(Array.isArray(payload.repositories_added) ? payload.repositories_added : []), payload.repository]) {
      await persistGitHubRepository(database, installationId, repository, repositoryStatus, now);
    }
    for (const repository of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
      await persistGitHubRepository(database, installationId, repository, "removed", now);
    }
  }
  const repository = workerRecordValue(payload.repository);
  const pull = workerRecordValue(payload.pull_request);
  const issue = workerRecordValue(payload.issue);
  const sha = githubText(workerRecordValue(pull.head).sha, 64) ?? githubText(workerRecordValue(payload.head).sha, 64);
  const sourceId = kind === "pull_request" ? String(githubNumber(payload.number) ?? githubNumber(pull.number) ?? "") : kind === "issue" ? String(githubNumber(issue.number) ?? "") : undefined;
  return { kind, installationId, repository: githubText(repository.full_name), sourceId, sha };
}

function applicationUrl(request: Request, env: Env, path: string): string {
  const configured = typeof env.CONTROL_PLANE_URL === "string" && env.CONTROL_PLANE_URL.startsWith("https://") ? env.CONTROL_PLANE_URL : request.url;
  return new URL(path, configured).toString();
}

function safeReturnUrl(value: unknown, request: Request, env: Env, path: string): string {
  const fallback = applicationUrl(request, env, path);
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = new URL(value, fallback);
    if (parsed.origin !== new URL(fallback).origin) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return origin === new URL(applicationUrl(request, env, "/")).origin; } catch { return false; }
}

function hexDigest(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value: string): Promise<string> {
  return hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/** Verify provider webhook signatures before parsing or dispatching untrusted intake. */
async function verifyIntegrationWebhook(request: Request, payload: string, kind: "slack" | "linear" | "jira" | "incident" | "support", secret: string): Promise<boolean> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 16) return false;
  const signatureHeader = kind === "slack" ? request.headers.get("x-slack-signature") : kind === "linear" ? request.headers.get("linear-signature") : request.headers.get("x-webhook-signature") ?? request.headers.get("x-hub-signature-256");
  if (!signatureHeader) return false;
  let signedPayload = payload;
  let expectedPrefix = "";
  if (kind === "slack") {
    const timestamp = Number(request.headers.get("x-slack-request-timestamp"));
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
    signedPayload = `v0:${timestamp}:${payload}`;
    expectedPrefix = "v0=";
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = `${expectedPrefix}${hexDigest(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)))}`;
  const candidate = signatureHeader.trim().split(",")[0]?.trim().replace(/^sha256=/i, "") ?? "";
  return constantTimeTextEqual(candidate, expected.replace(/^v0=/, "")) || constantTimeTextEqual(signatureHeader.trim(), expected);
}

/**
 * Notification destinations are eventually fetched by a server-side delivery
 * worker. Keep this control-plane write constrained to the two providers the
 * product actually supports; accepting arbitrary HTTPS URLs would turn a
 * future retry/delivery path into a tenant-controlled SSRF primitive.
 */
function notificationWebhookUrl(value: unknown, kind: "slack" | "teams"): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const slackHost = hostname === "hooks.slack.com" || hostname === "hooks.slack-gov.com";
    const teamsHost = hostname === "outlook.office.com" || hostname.endsWith(".webhook.office.com") || hostname.endsWith(".logic.azure.com");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port || (kind === "slack" ? !slackHost : !teamsHost)) return undefined;
    if (parsed.pathname === "/" || /[\u0000-\u001f\u007f]/.test(parsed.pathname) || parsed.pathname.length > 1_500) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

function workerRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function reconcileBilling(env: Env): Promise<void> {
  if (!env.DB) return;
  const now = new Date().toISOString();
  await expireTrials(env.DB, now);
  const metadata = new D1JsonMetadataStore(env.DB);
  await metadata.put("billing:reconcile:last", { at: now, catalogVersion: "2026-08-18.seat-v1" });
  const config = await hostedProviderConfig(env);
  if (!config.stripe.secretKey || config.stripe.plans.length === 0) return;
  const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, plans: config.stripe.plans });
  const statement = env.DB.prepare("SELECT organization_id FROM tinkerbot_billing_accounts WHERE stripe_subscription_id IS NOT NULL AND subscription_status NOT IN ('canceled', 'deleted', 'free')").bind();
  const rows = typeof statement.all === "function" ? ((await statement.all())?.results ?? []) as Array<{ organization_id: string }> : [];
  for (const row of rows) {
    const result = await syncStripeQuantity({ database: env.DB, provider, organizationId: row.organization_id });
    await env.DB.prepare("INSERT INTO tinkerbot_reconciliation_runs (run_id, organization_id, status, expected_quantity, actual_quantity, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(crypto.randomUUID(), row.organization_id, result.pending ? "pending" : "ok", result.expected, result.expected, result.pending ? "provider_update_pending" : "quantity_synced", now).run();
  }
}

async function publishVerificationToGitHub(env: Env, input: { repository: string; sha?: string; runId?: string; bundle: Record<string, unknown>; dashboardUrl: string }): Promise<void> {
  if (!env.DB || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !input.sha) return;
  const installation = await env.DB.prepare("SELECT i.installation_id, i.status FROM tinkerbot_github_installations i JOIN tinkerbot_github_repositories r ON r.installation_id = i.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(input.repository).first<{ installation_id: number; status: string }>();
  if (!installation || installation.status !== "active") return;
  const factories = new D1FactoryStore(env.DB);
  const receipts = Array.isArray(input.bundle.receipts) ? input.bundle.receipts as Array<Record<string, unknown>> : [];
  const verdict = typeof receipts[0]?.verdict === "string" ? receipts[0].verdict : "UNKNOWN";
  const findings = Array.isArray(input.bundle.findings) ? input.bundle.findings as Array<{ id?: string; file?: string; line?: number; startLine?: number; message?: string; ruleId?: string; severity?: string }> : [];
  try {
    const token = await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: installation.installation_id });
    const annotations = mapCheckAnnotations(findings as never);
    const runId = input.runId ?? "ingest";
    for (const finding of findings) {
      const fingerprint = typeof finding.id === "string" ? finding.id : `${finding.file}:${finding.line}:${finding.message}`;
      const created = await factories.putPublication({ runId, commitSha: input.sha, fingerprint, kind: "inline", now: new Date().toISOString() });
      if (created === "duplicate") return;
    }
    await publishCheckRun({ token, repository: input.repository }, { headSha: input.sha, verdict, summary: `Tinkerbot verification ${verdict}. ${input.dashboardUrl}`, annotations, detailsUrl: input.dashboardUrl });
    const pullNumber = Number(String(input.bundle.pullNumber ?? "").replace(/\D/g, ""));
    if (Number.isSafeInteger(pullNumber) && pullNumber > 0) {
      await publishInlineComments({ token, repository: input.repository }, pullNumber, inlineReviewComments(findings as never, input.sha, input.dashboardUrl));
    }
  } catch {
    // Publication failure stays UNKNOWN on the dashboard; it must not upgrade a verdict.
  }
}

export function workOSRoleToTenantRole(roleSlugs: readonly string[]): TenantRole {
  const roles = new Set(roleSlugs.map((role) => role.trim().toLowerCase()));
  if (roles.has("owner")) return "owner";
  if (roles.has("admin")) return "admin";
  if (roles.has("billing_administrator")) return "billing_administrator";
  if (roles.has("maintainer")) return "maintainer";
  if (roles.has("reviewer")) return "reviewer";
  return "viewer";
}

function workOSStatusToMembershipStatus(status: "active" | "inactive" | "pending", deleted: boolean): TenantMembership["status"] {
  if (deleted || status === "inactive") return "removed";
  if (status === "pending") return "invited";
  return "active";
}

async function afterSeatChange(env: Env | undefined, tenants: D1TenantStore, organizationId: string, userId: string, transition: string): Promise<void> {
  if (!env?.DB) return;
  const quantityAfter = await tenants.countSeatUsage(organizationId);
  await recordSeatTransition(env.DB, { organizationId, userId, transition, quantityAfter });
  if (!env.STRIPE_SECRET_KEY) return;
  const provider = new StripeBillingProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
  await syncStripeQuantity({ database: env.DB, provider, organizationId });
}

async function applyWorkOSEvent(event: WorkOSWebhookEvent, tenants: D1TenantStore, env?: Env): Promise<void> {
  const data = event.data;
  const updatedAt = typeof data.updated_at === "string" ? data.updated_at : event.createdAt ?? new Date().toISOString();
  if (["invitation.created", "invitation.accepted", "invitation.revoked", "invitation.resent"].includes(event.event)) {
    await applyWorkOSInvitationEvent(event, tenants);
    return;
  }
  if (event.event === "organization.created" || event.event === "organization.updated" || event.event === "organization.deleted") {
    const organizationId = typeof data.id === "string" ? data.id : undefined;
    if (!organizationId) return;
    await tenants.upsertOrganization({ organizationId, name: typeof data.name === "string" && data.name ? data.name : organizationId, status: event.event === "organization.deleted" ? "inactive" : "active", updatedAt });
    return;
  }
  if (!event.event.startsWith("organization_membership.") && !event.event.startsWith("dsync.user.") && event.event !== "dsync.group.user_added" && event.event !== "dsync.group.user_removed") return;
  if (event.event.startsWith("dsync.")) {
    const userId = typeof data.user_id === "string" ? data.user_id : typeof data.id === "string" ? data.id : undefined;
    const organizationId = typeof data.organization_id === "string" ? data.organization_id : undefined;
    if (!userId || !organizationId) return;
    if (env?.DB) {
      const calculated = await entitlementsForOrganization(env.DB, organizationId);
      if (entitlementDenied(calculated, "scim", true)) return;
    }
    const deleted = event.event.includes("deleted") || event.event.includes("removed");
    const roleSlugs: string[] = [];
    if (typeof data.role === "string") roleSlugs.push(data.role);
    if (typeof data.role_slug === "string") roleSlugs.push(data.role_slug);
    const nestedRole = data.role && typeof data.role === "object" && data.role !== null && "slug" in data.role ? String((data.role as { slug?: string }).slug ?? "") : "";
    if (nestedRole) roleSlugs.push(nestedRole);
    await tenants.upsertMembership({ organizationId, userId, role: workOSRoleToTenantRole(roleSlugs), status: deleted ? "removed" : "active", identityType: "human", accessState: deleted ? "disabled" : "enabled", updatedAt });
    await afterSeatChange(env, tenants, organizationId, userId, deleted ? "removed" : "joined");
    return;
  }
  const membership = normalizeWorkOSMembership(data);
  if (!membership) return;
  await applyWorkOSMembership(membership, tenants, workOSStatusToMembershipStatus(membership.status, event.event === "organization_membership.deleted"), updatedAt, env);
}

async function applyWorkOSMembership(membership: NonNullable<ReturnType<typeof normalizeWorkOSMembership>>, tenants: D1TenantStore, status: TenantMembership["status"] = workOSStatusToMembershipStatus(membership.status, false), fallbackUpdatedAt = new Date().toISOString(), env?: Env): Promise<void> {
  const updatedAt = membership.updatedAt ?? fallbackUpdatedAt;
  await tenants.upsertOrganization({ organizationId: membership.organizationId, name: membership.organizationName ?? membership.organizationId, status: "active", updatedAt });
  if (membership.user) await tenants.upsertUser({ userId: membership.user.id, email: membership.user.email, firstName: membership.user.firstName, lastName: membership.user.lastName, emailVerified: membership.user.emailVerified, updatedAt });
  await tenants.upsertMembership({ organizationId: membership.organizationId, userId: membership.userId, role: workOSRoleToTenantRole(membership.roleSlugs), status, identityType: "human", accessState: status === "active" ? "enabled" : "disabled", updatedAt });
  await afterSeatChange(env, tenants, membership.organizationId, membership.userId, status === "active" ? "joined" : "removed");
}

function workOSEventInvitation(event: WorkOSWebhookEvent): ReturnType<typeof normalizeWorkOSInvitation> {
  const data = workerRecordValue(event.data);
  const nested = workerRecordValue(data.invitation);
  const state = data.state ?? nested.state ?? (event.event === "invitation.accepted" ? "accepted" : event.event === "invitation.revoked" ? "revoked" : "pending");
  return normalizeWorkOSInvitation({ ...nested, ...data, state });
}

async function applyWorkOSInvitationEvent(event: WorkOSWebhookEvent, tenants: D1TenantStore): Promise<void> {
  const invitation = workOSEventInvitation(event);
  if (!invitation?.organizationId) return;
  const role = workOSRoleToTenantRole(invitation.roleSlug ? [invitation.roleSlug] : []);
  const updatedAt = invitation.updatedAt ?? event.createdAt ?? new Date().toISOString();
  await tenants.upsertInvitation({
    invitationId: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    role,
    state: invitation.state,
    providerInvitationId: invitation.id,
    inviterUserId: invitation.inviterUserId,
    acceptedUserId: invitation.acceptedUserId,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt ?? updatedAt,
    updatedAt,
  });
}

const WORKOS_SYNC_EVENT_TYPES = [
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "invitation.resent",
];

async function reconcileWorkOSEvents(env: Env): Promise<{ processed: number; cursor?: string }> {
  if (!env.DB) return { processed: 0 };
  const config = await hostedProviderConfig(env);
  const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
  const metadata = new D1JsonMetadataStore(env.DB);
  const tenants = new D1TenantStore(env.DB);
  const ledger = new D1WebhookLedger(env.DB, "workos-events");
  const storedCursor = await metadata.get<string>("workos:events:cursor");
  let cursor = storedCursor ?? undefined;
  let processed = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const pageCursor = cursor;
    const page = await provider.listEvents({ after: pageCursor, rangeStart: pageCursor ? undefined : env.WORKOS_EVENTS_RANGE_START, eventTypes: WORKOS_SYNC_EVENT_TYPES, limit: 100 });
    if (!page.events.length) break;
    for (const event of page.events) {
      if (ledger.claim && await ledger.claim(event.id)) {
        try {
          await applyWorkOSEvent(event, tenants, env);
          await ledger.record(event.id);
          processed += 1;
        } catch (error) {
          if (ledger.release) await ledger.release(event.id);
          throw error;
        }
      }
      cursor = event.id;
      await metadata.put("workos:events:cursor", cursor);
    }
    const nextCursor = page.after ?? cursor;
    if (!nextCursor || nextCursor === pageCursor) break;
    cursor = nextCursor;
    await metadata.put("workos:events:cursor", cursor);
    if (!page.after) break;
  }
  return { processed, cursor };
}

function safeRedirectUri(request: Request, env: Env): string {
  if (typeof env.WORKOS_REDIRECT_URI === "string" && env.WORKOS_REDIRECT_URI.startsWith("https://")) return env.WORKOS_REDIRECT_URI;
  return new URL("/auth/workos/callback", request.url).toString();
}

export async function handleFactoryQueueMessage(env: Env, message: { deliveryId: string; installationId?: number; repository?: string; sourceType: "github_issue" | "github_pull_request" | "manual" | "mcp" | "slack" | "linear" | "jira" | "github_dependabot" | "github_code_scanning" | "github_secret_scanning" | "incident" | "support" | "roadmap" | "scheduled" | "gitlab_issue" | "gitlab_merge_request"; sourceId: string; issueOrPullRequest?: string; sha?: string; actor: string; organizationId?: string; factoryId?: string; workOrderId?: string; specApproved?: boolean; sandboxComplete?: boolean; pullRequestSha?: string; verificationVerdict?: string; verificationIngested?: boolean }): Promise<Awaited<ReturnType<typeof runFactoryTurn>>> {
  return routeFactoryQueueMessage(env, message);
}

export class FactoryRunWorkflow {
  async run(event: { payload: Parameters<typeof handleFactoryQueueMessage>[1] }, env: Env): Promise<void> {
    await handleFactoryQueueMessage(env, event.payload);
  }
}

async function handleFactoryHttp(request: Request, env: Env, url: URL, config: Awaited<ReturnType<typeof hostedProviderConfig>>): Promise<Response | undefined> {
  const accept = request.headers.get("accept") ?? "";
  const isDocumentRequest = (request.method === "GET" || request.method === "HEAD") && accept.includes("text/html") && !accept.includes("application/json");
  if (isDocumentRequest && ["/factories", "/work-orders", "/runs", "/environments", "/integrations", "/secrets"].some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return undefined;
  if (!env.DB) return undefined;
  const factories = new D1FactoryStore(env.DB);
  if (url.pathname === "/actions/oidc/exchange" && request.method === "POST") {
    const body = await jsonBody(request);
    const token = typeof body?.token === "string" ? body.token : "";
    const repository = typeof body?.repository === "string" ? body.repository : "";
    const sha = typeof body?.sha === "string" ? body.sha : undefined;
    const audience = env.ACTION_OIDC_AUDIENCE ?? "tinkerbot";
    const verified = await verifyOidcJwt(token, { audience, repository, sha });
    if (!verified.ok) return json({ error: "OIDC token is invalid.", code: verified.reason }, 401);
    const replay = await factories.consumeOidcReplayKey(oidcReplayKey(token, verified.claims), new Date().toISOString());
    if (replay === "replay") return json({ error: "OIDC token was already used.", code: "replay" }, 401);
    const installation = await env.DB.prepare("SELECT organization_id FROM tinkerbot_github_repositories r JOIN tinkerbot_github_installations i ON i.installation_id = r.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(repository).first<{ organization_id: string }>();
    if (!installation?.organization_id) return json({ error: "GitHub App installation is required.", code: "installation_required" }, 401);
    const calculated = await entitlementsForOrganization(env.DB, installation.organization_id);
    const denied = entitlementDenied(calculated, "verification", true);
    if (denied) return json({ ...denied, checkRun: "unknown" }, 403);
    const requestedRunId = typeof body?.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/.test(body.runId) ? body.runId : undefined;
    let runId: string = crypto.randomUUID();
    if (requestedRunId) {
      const candidateRun = await factories.getRun(requestedRunId);
      const candidateOrder = candidateRun?.work_order_id ? await factories.getWorkOrder(candidateRun.work_order_id) : null;
      if (!candidateRun || !candidateOrder || candidateOrder.organizationId !== installation.organization_id || candidateOrder.repositoryId.toLowerCase() !== repository.toLowerCase()) return json({ error: "The requested run is not scoped to this repository and installation.", code: "run_scope_mismatch" }, 403);
      if (candidateRun.status !== "running" && !candidateRun.status.startsWith("waiting:")) return json({ error: "The requested run is no longer active.", code: "run_not_active" }, 409);
      runId = requestedRunId;
    }
    const runToken = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await factories.putRunToken(runToken, runId, repository, sha, expiresAt, new Date().toISOString());
    return json({ runToken, runId, expiresAt, repository });
  }
  if (url.pathname === "/self-hosted/complete" && request.method === "POST") {
    const secret = env.SELF_HOSTED_WORK_SECRET ?? (env.ENVIRONMENT === "production" ? undefined : env.SESSION_ENCRYPTION_KEY);
    if (!secret || (env.ENVIRONMENT === "production" && !selfHostedSecretReady(secret))) return json({ error: "Self-hosted completion is not configured.", code: "self_hosted_not_configured" }, 503);
    const body = await jsonBody(request);
    const checked = verifySelfHostedCompletion(body, secret);
    if (!checked.ok) return json({ error: "Self-hosted completion was rejected.", code: checked.reason }, 401);
    const completion = checked.payload;
    if (completion.dispatchId !== `selfhost:${completion.workOrderId}:${completion.runId}`) return json({ error: "Dispatch identity does not match the work order and run.", code: "dispatch_mismatch" }, 403);
    const order = await factories.getWorkOrder(completion.workOrderId);
    if (!order || order.organizationId !== completion.organizationId || order.factoryId !== completion.factoryId || order.repositoryId.toLowerCase() !== completion.repository.toLowerCase()) return json({ error: "Self-hosted completion does not match the persisted work order.", code: "completion_scope_mismatch" }, 403);
    const run = await factories.getRun(completion.runId);
    if (!run || run.work_order_id !== order.workOrderId || run.factory_id !== order.factoryId) return json({ error: "Self-hosted completion references an unknown run.", code: "run_not_found" }, 404);
    if (run.definition_digest !== completion.definitionDigest) return json({ error: "Self-hosted completion was produced from a different factory definition.", code: "definition_digest_mismatch" }, 409);
    // The local worker's leased cell has one deterministic branch per work
    // order. A signed customer worker is still untrusted, so do not accept a
    // valid-looking tinkerbot/* ref that belongs to another work order.
    if (completion.branch && completion.branch !== implementBranchName(order.workOrderId)) return json({ error: "Self-hosted completion reported the wrong work-order branch.", code: "branch_scope_mismatch" }, 409);
    // An event is the durable idempotency claim. If a prior request claimed
    // the dispatch but crashed before advancing the run, retry the resume while
    // the run is still live; only terminal/non-waiting runs are pure replays.
    const priorEvents = await factories.listFactoryEvents(order.workOrderId, order.organizationId);
    const priorCompletionEvent = priorEvents.find((event) => ["task.completed", "task.blocked"].includes(event.type) && (event.payload as Record<string, unknown>).dispatchId === completion.dispatchId);
    if (priorCompletionEvent && ((completion.status === "completed") !== (priorCompletionEvent.type === "task.completed"))) return json({ error: "Self-hosted completion conflicts with an earlier terminal report.", code: "completion_status_conflict" }, 409);
    const priorCompletion = Boolean(priorCompletionEvent);
    if (priorCompletion && run.status !== "running" && run.status !== "waiting:self_hosted_harness") return json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
    if (run.status !== "running" && run.status !== "waiting:self_hosted_harness") return json({ error: "Self-hosted completion references a run that is no longer awaiting implementation.", code: "run_not_waiting" }, 409);
    if (!["implementation", "review", "verification", "unknown"].includes(order.status)) return json({ error: "Self-hosted completion arrived outside the implementation boundary.", code: "invalid_work_order_state" }, 409);
    const now = new Date().toISOString();
    if (completion.status === "failed") {
      const claimed = priorCompletion || await factories.appendFactoryEventOnce({ eventId: `selfhost-failed:${completion.dispatchId}`, type: "task.blocked", aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId: order.factoryId, actorId: "self-hosted-worker", actorType: "agent", occurredAt: now, correlationId: completion.runId, policyVersion: order.policyVersion, schemaVersion: 1, provenance: "ATTESTED", payload: { dispatchId: completion.dispatchId, reason: completion.summary ?? "Self-hosted worker reported failure." } });
      if (!claimed) return json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
      const failed = await factories.applyTransition(order.workOrderId, "failed", `self-hosted-complete:${completion.dispatchId}`, "self-hosted-worker");
      if (!failed.ok && failed.code !== "idempotent") return json({ error: "The failed completion could not advance the work order.", code: failed.code }, 409);
      await factories.updateRun(completion.runId, "failed", now);
      return json({ accepted: true, terminal: "failed", workOrderId: order.workOrderId, runId: completion.runId });
    }
    const claimed = priorCompletion || await factories.appendFactoryEventOnce({ eventId: `selfhost-completed:${completion.dispatchId}`, type: "task.completed", aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId: order.factoryId, actorId: "self-hosted-worker", actorType: "agent", occurredAt: now, correlationId: completion.runId, policyVersion: order.policyVersion, schemaVersion: 1, provenance: "ATTESTED", payload: { dispatchId: completion.dispatchId, branch: completion.branch, headSha: completion.headSha, pullRequestNumber: completion.pullRequestNumber, summary: completion.summary } });
    if (!claimed) return json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
    const resumed = await handleFactoryQueueMessage(env, { deliveryId: `self-hosted-complete:${completion.dispatchId}`, organizationId: order.organizationId, factoryId: order.factoryId, repository: completion.repository, sourceType: order.sourceType, sourceId: order.sourceId, workOrderId: order.workOrderId, actor: "self-hosted-worker", sandboxComplete: true, pullRequestSha: completion.headSha, specApproved: true });
    return json({ accepted: true, workOrderId: resumed?.workOrderId ?? order.workOrderId, runId: resumed?.runId ?? completion.runId, terminal: resumed?.terminal ?? "unknown", wait: resumed?.wait });
  }
  const store = sessionStore(env, config);
  if (!store) return undefined;
  if (url.pathname === "/integrations/github" && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const statement = env.DB.prepare("SELECT installation_id, account_login, status, updated_at FROM tinkerbot_github_installations WHERE organization_id = ?1").bind(access.membership.organizationId);
    const rows = typeof statement.all === "function" ? (await statement.all<{ installation_id: number; account_login?: string; status: string; updated_at: string }>()).results ?? [] : [];
    return json({ authorized: true, installations: rows });
  }
  if (url.pathname === "/search" && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (query.length < 2) return json({ results: [] });
    const results: Array<{ kind: string; title: string; meta: string; href: string }> = [];
    const factoriesList = await factories.listFactories(access.membership.organizationId);
    for (const factory of factoriesList) if (`${factory.factoryId} ${factory.name}`.toLowerCase().includes(query)) results.push({ kind: "Factory", title: factory.name, meta: factory.factoryId, href: `/factories/${encodeURIComponent(factory.factoryId)}` });
    const workOrders = await factories.listWorkOrderViews(access.membership.organizationId);
    for (const order of workOrders) if (`${order.id} ${order.title} ${order.repository?.name ?? ""}`.toLowerCase().includes(query)) results.push({ kind: "Work order", title: order.title, meta: `${order.id} · ${order.repository?.name ?? "Unassigned repository"}`, href: `/factories/${encodeURIComponent(order.factoryId)}/work-orders/${encodeURIComponent(order.id)}` });
    const runs = (await Promise.all(factoriesList.map((factory) => factories.listFactoryRuns(factory.factoryId)))).flat();
    for (const run of runs) if (`${run.run_id} ${run.work_order_id}`.toLowerCase().includes(query)) results.push({ kind: "Run", title: run.run_id, meta: run.work_order_id, href: `/runs/${encodeURIComponent(run.run_id)}` });
    const integrations = await factories.listIntegrations(access.membership.organizationId);
    for (const integration of integrations) if (`${integration.id} ${integration.name}`.toLowerCase().includes(query)) results.push({ kind: "MCP or app", title: integration.name, meta: integration.status, href: `/integrations/${encodeURIComponent(integration.id)}` });
    const secrets = await factories.listSecretMetadata(access.membership.organizationId);
    for (const secret of secrets) if (`${secret.id} ${secret.name}`.toLowerCase().includes(query)) results.push({ kind: "Secret metadata", title: secret.name, meta: "Value hidden", href: `/secrets/${encodeURIComponent(secret.id)}` });
    return json({ results: results.slice(0, 20) });
  }
  const factoryMatch = url.pathname.match(/^\/factories(?:\/([^/]+))?$/);
  const factoryResourceMatch = url.pathname.match(/^\/factories\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  const workGraphMatch = url.pathname.match(/^\/work-orders\/([^/]+)\/graph$/);
  const workDecisionMatch = url.pathname.match(/^\/work-orders\/([^/]+)\/decisions$/);
  const workMatch = url.pathname.match(/^\/work-orders(?:\/([^/]+))?(?:\/(retry|approve|cancel|steer|take|return))?$/);
  const runMatch = url.pathname.match(/^\/runs\/([^/]+)(?:\/(events))?$/);
  if (url.pathname === "/usage" && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    return json({ authorized: true, billingUnit: "active_seat", billed: false, fairUse: true, usage: publicUsage(await factories.listUsage(access.membership.organizationId)) });
  }
  if (url.pathname === "/runtime/sync" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin runtime sync rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const body = await jsonBody(request) ?? {};
    if (containsRawCredentials(body)) return json({ error: "Secrets must not appear in synced local payloads.", code: "secret_rejected" }, 400);
    const kind = typeof body.kind === "string" ? body.kind : "factory-run";
    try {
      const ingested = await factories.ingestLocalRuntimePayload({ organizationId: access.membership.organizationId, kind, payload: body, now: new Date().toISOString() });
      return json({ ...ingested, origin: "local", identity: "hosted-session" });
    } catch {
      return json({ error: "The local runtime payload is not scoped to this organization or is invalid.", code: "invalid_runtime_payload" }, 400);
    }
  }
  if (workGraphMatch && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    let workOrderId: string;
    try { workOrderId = decodeURIComponent(workGraphMatch[1]); } catch { return json({ error: "Work-order identifier is malformed.", code: "invalid_request" }, 400); }
    const order = await factories.getWorkOrder(workOrderId);
    if (!order || order.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
    const events = await factories.listFactoryEvents(workOrderId, access.membership.organizationId);
    const view = await factories.getWorkOrderView(workOrderId, access.membership.organizationId);
    return json({
      workOrder: { ...order, ...view, group: view?.group ?? classifyWorkOrderGroup(order.status) },
      graph: projectFactoryEvents(events),
      economics: calculateFactoryEconomics(events),
      events,
      sourceOfTruth: "append_only_factory_graph",
    });
  }
  if (workDecisionMatch && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin work-order decision rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "work:operate");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const order = await factories.getWorkOrder(workDecisionMatch[1]);
    if (!order || order.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
    const view = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
    if (!view) return json({ error: "Work order not found.", code: "not_found" }, 404);
    const body = await jsonBody(request) ?? {};
    const type = body?.type === "review" ? "review" : body?.type === "release_authorization" ? "release" : undefined;
    const decision = body?.decision === "approved" || body?.decision === "rejected" || body?.decision === "changes_requested" ? body.decision : undefined;
    if (!type || !decision) return json({ error: "type and decision must be a supported typed decision.", code: "invalid_decision" }, 400);
    const actor = access.current.session.user.id;
    if (type === "review") {
      if (view.reviewDecision !== "awaiting_human") return json({ error: "This work order is not awaiting human review.", code: "review_not_available" }, 409);
      const independence = sameActorApprovalBlocked({ actorId: actor, cellHolderId: order.heldBy, lineId: order.lineId, autonomyMode: order.autonomyMode });
      if (independence.blocked) return json({ error: "The producer cannot approve this restricted work order.", code: independence.reason }, 403);
      await factories.recordTypedDecision({ workOrderId: order.workOrderId, organizationId: access.membership.organizationId, actor, type, decision, now: new Date().toISOString() });
      const updated = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      return json({ workOrder: updated, availableActions: updated?.availableActions ?? [] });
    }
    if (decision !== "approved") return json({ error: "Release authorization must be approved or omitted; use review for a rejected change.", code: "invalid_release_decision" }, 400);
    if (body?.evidenceAcknowledged !== true) return json({ error: "Evidence acknowledgement is required before release authorization.", code: "evidence_acknowledgement_required" }, 409);
    if (view.verificationVerdict !== "pass" || view.reviewDecision !== "approved" || view.releaseDecision !== "awaiting_authorization") return json({ error: "Release authorization requires a passing deterministic verdict, human review, and release policy eligibility.", code: "release_gate_blocked" }, 409);
    const transition = order.status === "ready" ? await factories.applyTransition(order.workOrderId, "merged", `release-merge:${crypto.randomUUID()}`, actor) : { ok: true as const, order };
    if (!transition.ok) return json({ error: "The release candidate could not be assembled.", code: transition.code }, 409);
    const released = transition.order.status === "merged" ? await factories.applyTransition(order.workOrderId, "released", `release:${crypto.randomUUID()}`, actor) : transition;
    if (!released.ok) return json({ error: "Release transition was rejected.", code: released.code }, 409);
    await factories.recordTypedDecision({ workOrderId: order.workOrderId, organizationId: access.membership.organizationId, actor, type, decision, now: new Date().toISOString() });
    const updated = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
    return json({ workOrder: updated, availableActions: updated?.availableActions ?? [] });
  }
  if (factoryMatch && (request.method === "GET" || request.method === "POST" || request.method === "PATCH")) {
    if (request.method !== "GET" && !originAllowed(request, env)) return json({ error: "Cross-origin factory mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "GET" ? "tenant:read" : "factory:write");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    if (request.method !== "GET") {
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "full_factory_pipeline", true);
      if (denied) return denied;
    }
    if (request.method === "GET" && !factoryMatch[1]) return json({ factories: await factories.listFactories(access.membership.organizationId) });
    if (request.method === "GET" && factoryMatch[1]) {
      const view = await factories.factoryOperatorView(factoryMatch[1], access.membership.organizationId);
      if (!view) return json({ error: "Factory not found.", code: "not_found" }, 404);
      return json(view);
    }
    if (factoryMatch[1] && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(factoryMatch[1])) return json({ error: "Factory identifier is malformed.", code: "invalid_request" }, 400);
    if (factoryMatch[1]) {
      const existing = await factories.getFactory(factoryMatch[1]);
      // Do not let an organization overwrite another tenant's definition by
      // guessing a factory UUID. The store repeats this check so non-HTTP
      // callers cannot bypass the boundary either.
      if (existing && existing.organizationId !== access.membership.organizationId) return json({ error: "Factory not found.", code: "not_found" }, 404);
    }
    const body = await jsonBody(request);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const yaml = typeof body?.yaml === "string" ? body.yaml : undefined;
    const files = Array.isArray(body?.files) ? body.files.filter((item): item is { path: string; contents: string } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && typeof (item as { contents?: unknown }).contents === "string")) : undefined;
    if (!name && request.method === "POST") return json({ error: "Factory name is required.", code: "invalid_request" }, 400);
    const factoryId = factoryMatch[1] ?? crypto.randomUUID();
    if (name && !/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,199}$/.test(name)) return json({ error: "Factory name is invalid.", code: "invalid_request" }, 400);
    try {
      const saved = await factories.putFactory({ factoryId, organizationId: access.membership.organizationId, name: name || factoryId, yaml, files });
      return json({ factory: saved }, request.method === "POST" ? 201 : 200);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid factory definition.", code: "invalid_request" }, 400);
    }
  }
  if (factoryResourceMatch && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const [, factoryId, resource, entityId] = factoryResourceMatch;
    const view = await factories.factoryOperatorView(factoryId, access.membership.organizationId);
    if (!view) return json({ error: "Factory not found.", code: "not_found" }, 404);
    let items: Array<Record<string, unknown>>;
    if (resource === "work-orders") items = view.workOrders as unknown as Array<Record<string, unknown>>;
    else if (resource === "activity") items = view.activity as unknown as Array<Record<string, unknown>>;
    else if (resource === "runs") items = view.runs as unknown as Array<Record<string, unknown>>;
    else if (resource === "evidence") items = await factories.listFactoryEvidence(factoryId, access.membership.organizationId);
    else if (resource === "agents") items = view.agents.map((agent) => ({ id: agent.id, name: agent.id, role: agent.agentType ?? agent.description ?? "Specialist", state: "active", health: "Healthy", lastRun: "—", cost: "—" }));
    else if (resource === "automations") items = view.automations.map((automation) => ({ id: `${factoryId}:${automation.name}`, name: automation.name, trigger: JSON.stringify(automation.triggers), enabled: automation.enabled, owner: automation.agent ?? "Factory", lastExecution: "—", nextExecution: "On event", result: "configured" }));
    else if (resource === "policies") items = [{ id: `policy:${factoryId}`, name: "Factory policy", status: "active", owner: "Factory", updatedAt: view.factory.status }];
    else if (resource === "repositories") items = [...new Set(view.workOrders.map((order) => order.repository?.name).filter((name): name is string => Boolean(name)))].map((name) => ({ id: name, name, status: "connected", owner: "Factory", updatedAt: view.factory.status }));
    else if (resource === "releases") items = (await factories.listReleaseCandidates(factoryId)) as Array<Record<string, unknown>>;
    else if (resource === "costs") items = [{ id: `cost:${factoryId}`, name: "Factory economics", status: "measured", owner: "Tinkerbot", updatedAt: view.factory.status, ...view.costs }];
    else return json({ error: "Factory resource not found.", code: "not_found" }, 404);
    if (entityId) {
      const item = items.find((candidate) => String(candidate.id ?? candidate.workOrderId ?? candidate.run_id ?? candidate.runId ?? candidate.evidenceId ?? candidate.release_id) === entityId);
      return item ? json({ item }) : json({ error: "Factory record not found.", code: "not_found" }, 404);
    }
    return json({ items });
  }
  if (["/runs", "/environments", "/integrations", "/secrets"].includes(url.pathname) && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    if (url.pathname === "/runs") {
      const listedFactories = await factories.listFactories(access.membership.organizationId);
      return json({ items: (await Promise.all(listedFactories.map((factory) => factories.listFactoryRuns(factory.factoryId)))).flat() });
    }
    if (url.pathname === "/environments") return json({ items: await factories.listEnvironments(access.membership.organizationId) });
    if (url.pathname === "/integrations") return json({ items: await factories.listIntegrations(access.membership.organizationId) });
    return json({ items: await factories.listSecretMetadata(access.membership.organizationId) });
  }
  const workspaceDetailMatch = url.pathname.match(/^\/(environments|integrations|secrets)\/([^/]+)$/);
  if (workspaceDetailMatch && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const [, resource, entityId] = workspaceDetailMatch;
    const items = resource === "environments" ? await factories.listEnvironments(access.membership.organizationId) : resource === "integrations" ? await factories.listIntegrations(access.membership.organizationId) : await factories.listSecretMetadata(access.membership.organizationId);
    const item = items.find((candidate) => candidate.id === entityId);
    return item ? json({ item }) : json({ error: `${resource} record not found.`, code: "not_found" }, 404);
  }
  if (url.pathname === "/integrations" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin integration mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const body = await jsonBody(request) ?? {};
    if (containsRawCredentials(body)) return json({ error: "Integration credentials must be stored through a secret reference, not in the integration payload.", code: "secret_rejected" }, 400);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    if (!name || !kind) return json({ error: "Integration name and kind are required.", code: "invalid_request" }, 400);
    const integration = await factories.createIntegrationMetadata({ organizationId: access.membership.organizationId, name, kind, now: new Date().toISOString() });
    return json({ integration }, 201);
  }
  if (url.pathname === "/secrets" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin secret mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const body = await jsonBody(request) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    // Hosted Workers deliberately never receive or persist customer secret
    // values. They record only the reference that a local/self-hosted worker
    // resolves from its own environment or keychain.
    if (Object.prototype.hasOwnProperty.call(body, "value")) return json({ error: "Raw secret values are not accepted by the hosted control plane; provide secretRef instead.", code: "secret_rejected" }, 400);
    const reference = typeof body.secretRef === "string" ? body.secretRef.trim() : "";
    if (!name || !reference) return json({ error: "Secret name and secretRef are required.", code: "invalid_request" }, 400);
    try { assertCredentialRef(reference, "secretRef"); } catch { return json({ error: "secretRef must be env:VAR or keychain://…; raw secrets are forbidden.", code: "secret_rejected" }, 400); }
    const secret = await factories.createSecretMetadata({ organizationId: access.membership.organizationId, name, reference, owner: access.membership.organizationId, now: new Date().toISOString() });
    return json({ secret, valueAccepted: false, referenceStored: true, storage: "reference_only" }, 201);
  }
  if (workMatch) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "GET" ? "tenant:read" : "work:operate");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    if (request.method === "GET" && !workMatch[1]) {
      const factoryId = url.searchParams.get("factoryId") ?? undefined;
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const group = url.searchParams.get("group") ?? undefined;
      const stage = url.searchParams.get("stage") ?? undefined;
      const risk = url.searchParams.get("risk") ?? undefined;
      const workOrders = (await factories.listWorkOrderViews(access.membership.organizationId, factoryId)).filter((order) => (!query || `${order.id} ${order.title} ${order.repository?.name ?? ""}`.toLowerCase().includes(query)) && (!group || order.group === group) && (!stage || order.stage === stage) && (!risk || order.risk === risk));
      // Keep the pre-read-model `group` values stable for existing API clients while
      // exposing the normalized control-plane value explicitly. The UI normalizer
      // understands both representations, so this is a backwards-compatible seam.
      return json({ workOrders: workOrders.map((order) => ({
        ...order,
        group: classifyWorkOrderGroup(order.status as Parameters<typeof classifyWorkOrderGroup>[0]),
        viewGroup: order.group,
        lane: order.stage,
      })) });
    }
    if (request.method === "GET" && workMatch[1]) {
      const order = await factories.getWorkOrder(workMatch[1]);
      if (!order || order.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
      const view = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      const run = await factories.getRunByWorkOrder(order.workOrderId);
      const stages = run ? await factories.listRunStages(run.run_id) : [];
      const events = await factories.listFactoryEvents(order.workOrderId, access.membership.organizationId);
      return json({ workOrder: { ...order, ...view, group: view?.group ?? classifyWorkOrderGroup(order.status) }, run, stages, events, availableActions: view?.availableActions ?? [] });
    }
    if (request.method === "POST" && !workMatch[1]) {
      if (!originAllowed(request, env)) return json({ error: "Cross-origin work-order mutation rejected.", code: "csrf_origin_rejected" }, 403);
      const body = await jsonBody(request);
      const factoryId = typeof body?.factoryId === "string" ? body.factoryId : "";
      const repositoryId = typeof body?.repositoryId === "string" ? body.repositoryId : "";
      if (!factoryId || !repositoryId) return json({ error: "factoryId and repositoryId are required.", code: "invalid_request" }, 400);
      const factory = await factories.getFactory(factoryId);
      if (!factory || factory.organizationId !== access.membership.organizationId) return json({ error: "Factory not found.", code: "not_found" }, 404);
      const order = createWorkOrder({ factoryId, organizationId: access.membership.organizationId, sourceType: "manual", sourceId: `manual:${crypto.randomUUID()}`, repositoryId, intent: typeof body?.intent === "string" ? body.intent : undefined, policyVersion: "default", definitionVersion: factory.definitionDigest ?? "unknown", definitionDigest: factory.definitionDigest ?? "unknown", actor: access.current.session.user.id });
      await factories.insertWorkOrder(order);
      await handleFactoryQueueMessage(env, { deliveryId: `manual:${order.workOrderId}`, organizationId: order.organizationId, factoryId, repository: repositoryId, sourceType: "manual", sourceId: order.sourceId, actor: order.actor });
      const view = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      return json({ workOrder: view ?? order, availableActions: view?.availableActions ?? [] }, 201);
    }
    if (request.method === "POST" && workMatch[1] && workMatch[2]) {
      if (!originAllowed(request, env)) return json({ error: "Cross-origin work-order mutation rejected.", code: "csrf_origin_rejected" }, 403);
      const scoped = await factories.getWorkOrder(workMatch[1]);
      if (!scoped || scoped.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
      if (workMatch[2] === "steer") {
        const body = await jsonBody(request);
        const note = typeof body?.note === "string" ? body.note : "";
        const order = await factories.getWorkOrder(workMatch[1]);
        if (!order || order.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
        await handleFactoryQueueMessage(env, { deliveryId: `steer:${crypto.randomUUID()}`, organizationId: order.organizationId, factoryId: order.factoryId, repository: order.repositoryId, sourceType: order.sourceType, sourceId: order.sourceId, workOrderId: order.workOrderId, issueOrPullRequest: note, actor: access.current.session.user.id });
        return json({ steered: true, workOrderId: order.workOrderId });
      }
      if (workMatch[2] === "take" || workMatch[2] === "return") {
        const current = await factories.getWorkOrder(workMatch[1]);
        if (!current || current.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
        const actor = access.current.session.user.id;
        const now = new Date().toISOString();
        await factories.patchWorkOrder(current.workOrderId, { heldBy: workMatch[2] === "take" ? actor : undefined, now });
        await env.DB.prepare("INSERT INTO tinkerbot_human_decisions (decision_id, work_order_id, subject_id, actor, role, decision, reason, created_at) VALUES (?1, ?2, ?3, ?4, 'operator', ?5, ?6, ?7)").bind(crypto.randomUUID(), current.workOrderId, current.cellId ?? current.workOrderId, actor, workMatch[2] === "take" ? "take_cell" : "return_cell", "Human/agent parity", now).run();
        return json({ workOrder: await factories.getWorkOrder(current.workOrderId), held: workMatch[2] === "take" });
      }
      if (workMatch[2] === "approve") {
        const current = await factories.getWorkOrder(workMatch[1]);
        if (!current || current.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
        const sod = sameActorApprovalBlocked({
          actorId: access.current.session.user.id,
          cellHolderId: current.heldBy,
          lineId: current.lineId,
          autonomyMode: current.autonomyMode,
        });
        if (sod.blocked) return json({ error: "The producer cannot approve this restricted work order.", code: sod.reason }, 403);
        const spec = current.status === "specification" || current.currentStage === "specification";
        await factories.insertApproval(current.workOrderId, access.current.session.user.id, "approved", "session", new Date().toISOString());
        if (spec) {
          await handleFactoryQueueMessage(env, { deliveryId: `spec-approve:${crypto.randomUUID()}`, organizationId: current.organizationId, factoryId: current.factoryId, repository: current.repositoryId, sourceType: current.sourceType, sourceId: current.sourceId, workOrderId: current.workOrderId, issueOrPullRequest: current.issueOrPullRequest, actor: access.current.session.user.id, specApproved: true });
          const updated = await factories.getWorkOrder(current.workOrderId);
          return json({ workOrder: updated, specApproved: true });
        }
      }
      const current = await factories.getWorkOrder(workMatch[1]);
      if (!current || current.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
      const toState = workMatch[2] === "approve" ? "ready" : workMatch[2] === "cancel" ? "cancelled" : "intake";
      const result = await factories.applyTransition(current.workOrderId, toState, `${workMatch[2]}:${crypto.randomUUID()}`, access.current.session.user.id);
      if (!result.ok) return json({ error: "Work-order transition was rejected.", code: result.code }, result.code === "not_found" ? 404 : 409);
      return json({ workOrder: result.order });
    }
  }
  if (runMatch && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const run = await factories.getRunForOrganization(runMatch[1], access.membership.organizationId);
    if (!run) return json({ error: "Run not found.", code: "not_found" }, 404);
    const stages = await factories.listRunStages(runMatch[1]);
    const events = await factories.listFactoryEvents(run.work_order_id, access.membership.organizationId);
    return json({ run, stages, events });
  }
  const osList = url.pathname.match(/^\/(products|cells|skills|evolution|releases|outcomes)(?:\/([^/]+))?(?:\/(approve))?$/);
  if (osList) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), osList[1] === "evolution" && osList[3] === "approve" ? "factory:write" : "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const listed = await factories.listFactories(access.membership.organizationId);
    const factoryId = listed[0]?.factoryId;
    if (osList[1] === "products" && request.method === "GET") return json({ products: await factories.listProducts(access.membership.organizationId) });
    if (osList[1] === "cells" && request.method === "GET") return json({ cells: factoryId ? await factories.listWorkCells(factoryId) : [] });
    if (osList[1] === "skills" && request.method === "GET") {
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "custom_factory_skills", false);
      if (denied) return denied;
      return json({ skills: factoryId ? await factories.listSkills(factoryId) : [] });
    }
    if (osList[1] === "evolution" && request.method === "GET") {
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "factory_improvement", false);
      if (denied) return denied;
      return json({ proposals: factoryId ? await factories.listProposals(factoryId) : [] });
    }
    if (osList[1] === "evolution" && osList[3] === "approve" && request.method === "POST") {
      if (!originAllowed(request, env)) return json({ error: "Cross-origin evolution mutation rejected.", code: "csrf_origin_rejected" }, 403);
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "factory_improvement", true);
      if (denied) return denied;
      const result = await factories.approveProposal(osList[2], access.current.session.user.id, new Date().toISOString(), access.membership.organizationId);
      if (!result.ok) return json({ error: "Improvement activation was rejected.", code: result.reason }, 409);
      return json({ approved: true, autoMerge: false });
    }
    if (osList[1] === "releases" && request.method === "GET") return json({ releases: factoryId ? await factories.listReleaseCandidates(factoryId) : [] });
    if (osList[1] === "outcomes" && request.method === "GET") return json({ outcomes: await factories.listOutcomes(access.membership.organizationId) });
  }
  if (url.pathname === "/sso" && (request.method === "GET" || request.method === "PUT")) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "GET" ? "tenant:read" : "billing:manage");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "sso", request.method !== "GET");
    if (denied) return denied;
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT connection_id, require_sso FROM tinkerbot_sso_connections WHERE organization_id = ?1").bind(access.membership.organizationId).first<{ connection_id: string; require_sso: number }>();
      return json({ connectionId: row?.connection_id ?? null, requireSso: row?.require_sso === 1 });
    }
    if (!originAllowed(request, env)) return json({ error: "Cross-origin SSO mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const body = await jsonBody(request);
    const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
    if (!connectionId) return json({ error: "connectionId is required.", code: "invalid_request" }, 400);
    await env.DB.prepare("INSERT INTO tinkerbot_sso_connections (organization_id, connection_id, require_sso, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(organization_id) DO UPDATE SET connection_id = excluded.connection_id, require_sso = excluded.require_sso, updated_at = excluded.updated_at").bind(access.membership.organizationId, connectionId, body?.requireSso ? 1 : 0, new Date().toISOString()).run();
    return json({ saved: true, connectionId });
  }
  if (url.pathname === "/credentials" && (request.method === "GET" || request.method === "POST")) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "billing:manage");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "service_credentials", true);
    if (denied) return denied;
    if (request.method === "GET") {
      const statement = env.DB.prepare("SELECT credential_id, label, created_at, revoked_at FROM tinkerbot_service_credentials WHERE organization_id = ?1").bind(access.membership.organizationId);
      const rows = typeof statement.all === "function" ? (await statement.all()).results ?? [] : [];
      return json({ credentials: rows });
    }
    if (!originAllowed(request, env)) return json({ error: "Cross-origin credential mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const token = `tb_${crypto.randomUUID().replace(/-/g, "")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const credentialId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO tinkerbot_service_credentials (credential_id, organization_id, token_hash, label, scopes_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(credentialId, access.membership.organizationId, tokenHash, "api", JSON.stringify(["hosted_api"]), access.current.session.user.id, new Date().toISOString()).run();
    await tenantsServiceUser(env.DB, access.membership.organizationId, credentialId);
    return json({ credentialId, token, tokenShownOnce: true });
  }
  if (url.pathname === "/change-sets" && (request.method === "GET" || request.method === "POST")) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "POST" ? "work:operate" : "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "change_sets", request.method !== "GET");
    if (denied) return denied;
    if (request.method === "GET") {
      const statement = env.DB.prepare("SELECT c.change_set_id, c.payload_json FROM tinkerbot_change_sets c JOIN tinkerbot_work_orders w ON w.work_order_id = c.work_order_id WHERE w.organization_id = ?1").bind(access.membership.organizationId);
      const rows = typeof statement.all === "function" ? (await statement.all<{ change_set_id: string; payload_json: string }>()).results ?? [] : [];
      return json({ changeSets: rows.map((row) => ({ changeSetId: row.change_set_id, payload: JSON.parse(row.payload_json) })) });
    }
    if (!originAllowed(request, env)) return json({ error: "Cross-origin change-set mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const body = await jsonBody(request);
    if (!body) return json({ error: "A JSON change-set body is required.", code: "invalid_request" }, 400);
    try {
      const name = typeof body?.name === "string" ? body.name : "change-set";
      const repositories = Array.isArray(body?.repositories) ? body.repositories as Parameters<typeof createChangeSet>[0]["repositories"] : [];
      const changeSet = createChangeSet({ name, repositories, now: new Date().toISOString() });
      const assessment = assessChangeSet(changeSet);
      const workOrderId = typeof body?.workOrderId === "string" ? body.workOrderId : undefined;
      if (workOrderId) {
        const linkedOrder = await factories.getWorkOrderForOrganization(workOrderId, access.membership.organizationId);
        if (!linkedOrder) return json({ error: "Work order not found.", code: "not_found" }, 404);
      }
      const changeSetId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO tinkerbot_change_sets (change_set_id, work_order_id, payload_json, updated_at) VALUES (?1, ?2, ?3, ?4)").bind(changeSetId, workOrderId ?? "unassigned", JSON.stringify({ changeSet, assessment }), new Date().toISOString()).run();
      return json({ changeSetId, changeSet, assessment }, 201);
    } catch {
      return json({ error: "Invalid change set payload.", code: "invalid_request" }, 400);
    }
  }
  if (url.pathname === "/release-assessments" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin release assessment rejected.", code: "csrf_origin_rejected" }, 403);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "work:operate");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "release_assessments", true);
    if (denied) return denied;
    const body = await jsonBody(request);
    if (!body) return json({ error: "A JSON release-assessment body is required.", code: "invalid_request" }, 400);
    try {
      const manifest = body?.manifest && typeof body.manifest === "object"
        ? body.manifest as Parameters<typeof assessReleaseSafety>[0]["manifest"]
        : createReleaseManifest({ releaseId: crypto.randomUUID(), includedRepositories: [] });
      return json({ assessment: assessReleaseSafety({ manifest, receipts: Array.isArray(body?.receipts) ? body.receipts as never : [], now: new Date().toISOString() }) });
    } catch {
      return json({ error: "Invalid release assessment payload.", code: "invalid_request" }, 400);
    }
  }
  if (url.pathname === "/audit/export" && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "audit_export", true);
    if (denied) return denied;
    const statement = env.DB.prepare("SELECT event_id, action, payload_json, created_at FROM tinkerbot_billing_audit_events WHERE organization_id = ?1 ORDER BY created_at DESC LIMIT 500").bind(access.membership.organizationId);
    const rows = typeof statement.all === "function" ? (await statement.all()).results ?? [] : [];
    return json({ events: rows, retentionDays: calculated.values });
  }
  if (url.pathname === "/notifications" && (request.method === "GET" || request.method === "POST")) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "POST" ? "factory:write" : "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "external_notifications", request.method !== "GET");
    if (denied) return denied;
    if (request.method === "GET") {
      const statement = env.DB.prepare("SELECT destination_id, kind, created_at FROM tinkerbot_notification_destinations WHERE organization_id = ?1").bind(access.membership.organizationId);
      return json({ destinations: typeof statement.all === "function" ? (await statement.all()).results ?? [] : [] });
    }
    const body = await jsonBody(request);
    const kind = body?.kind === "teams" ? "teams" : "slack";
    if (!originAllowed(request, env)) return json({ error: "Cross-origin notification mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const webhookUrl = notificationWebhookUrl(body?.webhookUrl, kind);
    if (!webhookUrl) return json({ error: "A provider webhook URL is required (Slack or Microsoft Teams).", code: "invalid_request" }, 400);
    await env.DB.prepare("INSERT INTO tinkerbot_notification_destinations (destination_id, organization_id, kind, webhook_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(crypto.randomUUID(), access.membership.organizationId, kind, webhookUrl, new Date().toISOString()).run();
    return json({ saved: true, kind });
  }
  if (url.pathname === "/roles" && (request.method === "GET" || request.method === "POST")) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), request.method === "POST" ? "tenant:admin" : "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "custom_roles", request.method !== "GET");
    if (denied) return denied;
    if (request.method === "GET") {
      const statement = env.DB.prepare("SELECT role_id, slug, capabilities_json FROM tinkerbot_organization_roles WHERE organization_id = ?1").bind(access.membership.organizationId);
      return json({ roles: typeof statement.all === "function" ? (await statement.all()).results ?? [] : [] });
    }
    if (!originAllowed(request, env)) return json({ error: "Cross-origin role mutation rejected.", code: "csrf_origin_rejected" }, 403);
    const body = await jsonBody(request);
    const slug = typeof body?.slug === "string" ? body.slug : "";
    if (!slug) return json({ error: "slug is required.", code: "invalid_request" }, 400);
    await env.DB.prepare("INSERT INTO tinkerbot_organization_roles (role_id, organization_id, slug, capabilities_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(crypto.randomUUID(), access.membership.organizationId, slug, JSON.stringify(body?.capabilities ?? []), new Date().toISOString()).run();
    return json({ saved: true, slug });
  }
  return undefined;
}

async function tenantsServiceUser(database: D1DatabaseLike, organizationId: string, credentialId: string): Promise<void> {
  const now = new Date().toISOString();
  await new D1TenantStore(database).upsertUser({ userId: credentialId, email: `${credentialId}@service.tinkerbot`, updatedAt: now });
  await new D1TenantStore(database).upsertMembership({ organizationId, userId: credentialId, role: "viewer", status: "active", identityType: "service", accessState: "enabled", updatedAt: now });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...jsonHeaders, allow: "GET, POST, OPTIONS" } });
    const url = new URL(request.url);
    try {
      const config = await hostedProviderConfig(env);
      if (url.pathname === "/health" && request.method === "GET") {
        const statuses = providerStatuses(config);
        const sessionReady = Boolean(config.sessionEncryptionKey) && (config.environment !== "production" || selfHostedSecretReady(config.sessionEncryptionKey));
        const degraded = !env.DB || !sessionReady || statuses.some((item) => item.state !== "configured");
        return json({ status: degraded ? "degraded" : "ok", service: "tinkerbot-control-plane" });
      }
      if (url.pathname === "/config/status" && request.method === "GET") {
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "Operator status requires an authenticated session store.", code: "session_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "ops:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const sessionReady = Boolean(config.sessionEncryptionKey) && (config.environment !== "production" || selfHostedSecretReady(config.sessionEncryptionKey));
        const selfHostedWork = Boolean(env.SELF_HOSTED_WORK || env.SELF_HOSTED_WORK_ENDPOINT);
        const selfHostedWorkReady = !selfHostedWork || Boolean(env.SELF_HOSTED_WORK_SECRET ?? (config.environment === "production" ? undefined : config.sessionEncryptionKey)) && (config.environment !== "production" || selfHostedSecretReady(env.SELF_HOSTED_WORK_SECRET));
        return json({ service: "tinkerbot-control-plane", environment: config.environment, providers: providerStatuses(config), resources: { d1: Boolean(env.DB), r2: Boolean(env.EVIDENCE_BUCKET), evidenceExport: Boolean(env.EVIDENCE_EXPORT_ENDPOINT), sessionEncryption: sessionReady, selfHostedWork, selfHostedWorkReady, stripePlanCount: config.stripe.plans.length, workosEventSync: env.WORKOS_EVENTS_SYNC_ENABLED === "true", aiGateway: env.AI_GATEWAY_ID ?? "tinkerbot-factory" }, localVerification: "independent" });
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "Factory MCP requires a hosted session.", code: "session_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        return handleFactoryMcpRequest(request, env, access.current.session.user.id, access.membership.organizationId);
      }
      if (url.pathname === "/tinker/commands" && request.method === "POST") {
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "The @tinker gateway requires a hosted session.", code: "session_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const body = await jsonBody(request);
        if (!body) return json({ error: "A JSON command body is required.", code: "invalid_request" }, 400);
        const sourceSystem = body.sourceSystem === "github" || body.sourceSystem === "slack" || body.sourceSystem === "jira" || body.sourceSystem === "linear" || body.sourceSystem === "manual" ? body.sourceSystem : "manual";
        const result = dispatchTinkerGateway({
          text: typeof body.text === "string" ? body.text : "",
          organizationId: access.membership.organizationId,
          sourceSystem,
          sourceObjectId: typeof body.sourceObjectId === "string" ? body.sourceObjectId : crypto.randomUUID(),
          actorId: access.current.session.user.id,
          authorized: true,
          workOrderId: typeof body.workOrderId === "string" ? body.workOrderId : undefined,
        });
        await new D1FactoryStore(env.DB).insertFactoryCommand(result.command);
        return json({ ...result, projection: "WorkOrder traveler. Not a verification verdict." });
      }
      if ((url.pathname === "/integrations/slack/webhook" || url.pathname === "/integrations/linear/webhook" || url.pathname === "/integrations/jira/webhook" || url.pathname === "/integrations/incident/webhook" || url.pathname === "/integrations/support/webhook") && request.method === "POST") {
        const kind = url.pathname.includes("slack") ? "slack" : url.pathname.includes("linear") ? "linear" : url.pathname.includes("incident") ? "incident" : url.pathname.includes("support") ? "support" : "jira";
        const secret = kind === "slack" ? env.SLACK_WEBHOOK_SECRET : kind === "linear" ? env.LINEAR_WEBHOOK_SECRET : kind === "jira" ? env.JIRA_WEBHOOK_SECRET : kind === "incident" ? env.INCIDENT_WEBHOOK_SECRET : env.SUPPORT_WEBHOOK_SECRET;
        const integrationOrganization = typeof env.INTEGRATION_ORGANIZATION_ID === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(env.INTEGRATION_ORGANIZATION_ID) ? env.INTEGRATION_ORGANIZATION_ID : undefined;
        if (env.ENVIRONMENT === "production" && (!secret || !integrationOrganization)) return json({ error: "Signed integration webhook and tenant binding are not configured.", code: "integration_not_configured" }, 503);
        const payload = await boundedRequestText(request, 1_500_000);
        if (secret && !await verifyIntegrationWebhook(request, payload, kind, secret)) return json({ error: "Integration webhook signature is invalid.", code: "invalid_integration_signature" }, 401);
        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(payload) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
          body = parsed as Record<string, unknown>;
        } catch {
          return json({ error: "Integration webhook body must be a JSON object.", code: "invalid_request" }, 400);
        }
        if (url.pathname.includes("slack") && body.type === "url_verification") return json({ challenge: body.challenge });
        const message = intakeFromIntegration(kind, body);
        if (integrationOrganization) message.organizationId = integrationOrganization;
        const suppliedDelivery = request.headers.get("x-request-id") ?? request.headers.get("x-event-id") ?? (typeof body.event_id === "string" ? body.event_id : typeof body.id === "string" ? body.id : message.deliveryId);
        const deliveryId = `${kind}:${suppliedDelivery && /^[A-Za-z0-9:._-]{1,200}$/.test(suppliedDelivery) ? suppliedDelivery : `sha256:${hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)))}`}`;
        const ledger = new D1WebhookLedger(env.DB!, `integration:${kind}`);
        if (ledger.claim && !await ledger.claim(deliveryId)) return json({ received: true, duplicate: true, sourceType: kind, deliveryId });
        try {
          message.deliveryId = deliveryId;
          if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
          else await handleFactoryQueueMessage(env, message);
          await ledger.record(deliveryId);
        } catch (error) {
          if (ledger.release) await ledger.release(deliveryId);
          throw error;
        }
        return json({ received: true, sourceType: kind, deliveryId });
      }
      if (url.pathname === "/auth/workos/start" && request.method === "GET") {
        if (env.DB && await new D1FactoryStore(env.DB).hitRateLimit(`auth:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, 30, 60_000)) return json({ error: "Too many authentication attempts.", code: "rate_limited" }, 429);
        const state = crypto.randomUUID();
        const nonce = crypto.randomUUID();
        const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
        const challenge = await pkceChallenge(verifier);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const organizationHint = url.searchParams.get("organizationId");
        const sso = organizationHint && env.DB ? await env.DB.prepare("SELECT connection_id FROM tinkerbot_sso_connections WHERE organization_id = ?1").bind(organizationHint).first<{ connection_id: string }>() : null;
        const location = provider.authorizationUrl({ redirectUri: safeRedirectUri(request, env), state, codeChallenge: challenge, nonce, connectionId: sso?.connection_id });
        const headers = new Headers({ location, "cache-control": "no-store" });
        headers.append("set-cookie", `tinkerbot_oauth_state=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
        headers.append("set-cookie", `tinkerbot_pkce=${encodeURIComponent(verifier)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
        headers.append("set-cookie", `tinkerbot_nonce=${encodeURIComponent(nonce)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname === "/auth/workos/callback" && request.method === "GET") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const verifier = cookieValue(request, "tinkerbot_pkce");
        if (!state || !code || !verifier || state !== cookieValue(request, "tinkerbot_oauth_state")) return json({ error: "Invalid or expired authentication state.", code: "invalid_oauth_state" }, 400);
        const store = sessionStore(env, config);
        if (!store) return json({ error: "WorkOS exchange is wired, but the D1 session store or session encryption secret is not configured yet.", code: "session_store_not_configured" }, 501);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const session = await provider.exchangeCode({ code, codeVerifier: verifier, ipAddress: request.headers.get("cf-connecting-ip") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined });
        const sessionId = crypto.randomUUID();
        await store.put(sessionId, session);
        const tenants = env.DB ? new D1TenantStore(env.DB) : null;
        const access = tenants ? await authorizeTenantSession({ id: sessionId, session }, tenants) : null;
        return jsonWithCookies({ authenticated: true, ...publicSession(session), ...(access?.ok ? publicAccess(access) : { authorized: false }) }, 200, [clearCookie("tinkerbot_oauth_state"), clearCookie("tinkerbot_pkce"), clearCookie("tinkerbot_nonce"), sessionCookie(sessionId)]);
      }
      if (url.pathname === "/auth/session" && request.method === "GET") {
        const store = sessionStore(env, config);
        if (!store) return json({ error: "The D1 session store or session encryption secret is not configured yet.", code: "session_store_not_configured" }, 501);
        const currentDatabase = env.DB;
        if (!currentDatabase) return json({ error: "The D1 session store is not configured yet.", code: "session_store_not_configured" }, 501);
        let current = await currentSession(request, store, env);
        if (!current) return json({ authenticated: false, code: "not_authenticated" }, 401);
        if (expired(current.session)) {
          try {
            const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
            const refreshed = await provider.refreshSession({ refreshToken: current.session.refreshToken, organizationId: current.session.organizationId });
            await store.put(current.id, refreshed);
            current = { id: current.id, session: refreshed };
          } catch {
            await store.delete(current.id);
            return jsonWithCookies({ authenticated: false, code: "session_expired" }, 401, [clearCookie("tinkerbot_session")]);
          }
        }
        const access = await authorizeTenantSession(current, new D1TenantStore(currentDatabase));
        if (!access.ok) return json({ authenticated: true, ...publicSession(current.session), authorized: false, code: access.code }, access.status);
        return json({ authenticated: true, ...publicSession(current.session), ...publicAccess(access) });
      }
      if (url.pathname === "/tenant/access" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "The D1 session store is not configured yet.", code: "tenant_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database));
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        return json(publicAccess(access));
      }
      if (url.pathname === "/tenant/organizations" && request.method === "GET") {
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "Organization selection requires the D1 session and tenant stores.", code: "tenant_store_not_configured" }, 501);
        const current = await currentSession(request, store, env);
        if (!current) return json({ error: "Authentication is required.", code: "not_authenticated" }, 401);
        const memberships = await new D1TenantStore(env.DB).listActiveMemberships(current.session.user.id);
        return json({ authenticated: true, currentOrganizationId: current.session.organizationId, organizations: memberships.map((membership) => ({ organizationId: membership.organizationId, role: membership.role, updatedAt: membership.updatedAt })) });
      }
      if (url.pathname === "/tenant/organizations/switch" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin organization mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "Organization selection requires the D1 session and tenant stores.", code: "tenant_store_not_configured" }, 501);
        const current = await currentSession(request, store, env);
        if (!current) return json({ error: "Authentication is required.", code: "not_authenticated" }, 401);
        const body = await jsonBody(request);
        const organizationId = typeof body?.organizationId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(body.organizationId) ? body.organizationId : undefined;
        if (!organizationId) return json({ error: "A valid organizationId is required.", code: "invalid_organization" }, 400);
        const tenants = new D1TenantStore(env.DB);
        const membership = await tenants.getMembership(current.session.user.id, organizationId);
        if (!membership || membership.status !== "active") return json({ error: "The authenticated user is not an active member of that organization.", code: "not_a_member" }, 403);
        await store.put(current.id, { ...current.session, organizationId });
        const access = await authorizeTenantSession({ id: current.id, session: { ...current.session, organizationId } }, tenants);
        return json({ switched: true, ...(access.ok ? publicAccess(access) : { authorized: false }) });
      }
      if (url.pathname === "/assurance/summary" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const calculated = await calculatedAccess(env, access);
        const denied = entitledFailureFrom(calculated, "assurance_metadata", true);
        if (denied) return denied;
        const repository = assuranceRepository(url.searchParams.get("repository"));
        if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
        const metadata = new D1JsonMetadataStore(database);
        const bundle = await metadata.get<Record<string, unknown>>(assuranceMetadataKey(access.membership.organizationId, repository));
        return json({ authorized: true, organizationId: access.membership.organizationId, repository, state: bundle ? "present" : "empty", sourceUpload: "not_uploaded", assurance: bundle ?? null });
      }
      if (url.pathname === "/assurance/ingest" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin assurance ingestion rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
        const factories = new D1FactoryStore(database);
        const bearer = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
        const runToken = bearer ? await factories.getRunToken(bearer) : null;
        let organizationId: string | undefined;
        let actorId = "action";
        if (runToken) {
          if (Date.parse(runToken.expiresAt) <= Date.now()) return json({ error: "The run token has expired.", code: "run_token_expired" }, 401);
        } else {
          const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:write");
          if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
          const calculated = await calculatedAccess(env, access);
          const denied = entitledFailureFrom(calculated, "assurance_metadata", true);
          if (denied) return denied;
          organizationId = access.membership.organizationId;
          actorId = access.current.session.user.id;
        }
        const body = await jsonBody(request);
        const repository = assuranceRepository(body?.repository);
        if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
        if (runToken && runToken.repository !== repository) return json({ error: "Run token repository mismatch.", code: "invalid_repository" }, 403);
        const metadata = new D1JsonMetadataStore(database);
        const tokenUseKey = runToken && bearer ? `assurance:run-token:${await sha256Text(bearer)}` : undefined;
        const tokenPayloadDigest = tokenUseKey ? await sha256Text(JSON.stringify(canonicalize({ repository, assurance: body?.assurance ?? body?.bundle }))) : undefined;
        const priorTokenUse = tokenUseKey ? await metadata.get<{ payloadDigest?: string }>(tokenUseKey) : null;
        if (priorTokenUse && priorTokenUse.payloadDigest !== tokenPayloadDigest) return json({ error: "The OIDC run token was already used for different assurance metadata.", code: "run_token_reused" }, 409);
        if (runToken) {
          const installation = await database.prepare("SELECT organization_id FROM tinkerbot_github_repositories r JOIN tinkerbot_github_installations i ON i.installation_id = r.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(repository).first<{ organization_id: string }>();
          const run = await factories.getRun(runToken.runId);
          const order = run?.work_order_id ? await factories.getWorkOrder(run.work_order_id) : null;
          if (order && (order.repositoryId.toLowerCase() !== repository.toLowerCase() || (installation?.organization_id && order.organizationId !== installation.organization_id))) return json({ error: "The run token is not scoped to this repository and installation.", code: "run_scope_mismatch" }, 403);
          organizationId = order?.organizationId ?? installation?.organization_id;
          if (organizationId) {
            const calculated = await entitlementsForOrganization(database, organizationId);
            const denied = entitlementDenied(calculated, "verification", true);
            if (denied) return json(denied, 403);
          }
        }
        const checked = validateHostedAssuranceBundle(body?.assurance ?? body?.bundle);
        if (!checked.ok) return json({ error: checked.error, code: "invalid_assurance_metadata" }, 400);
        let boundReceipt: Record<string, unknown> | undefined;
        const submittedReceipts = Array.isArray(checked.value.receipts) ? checked.value.receipts : [];
        if (runToken && submittedReceipts.length > 0) {
          for (const candidate of submittedReceipts) {
            const verifiedReceipt = await verifyHostedReceipt(candidate, { repository, sha: runToken.sha });
            if (!verifiedReceipt.ok) return json({ error: verifiedReceipt.error, code: "invalid_assurance_receipt" }, 400);
            boundReceipt = verifiedReceipt.receipt;
          }
          if (!boundReceipt) return json({ error: "A repository-bound assurance receipt is required.", code: "invalid_assurance_receipt" }, 400);
        }
        // Claim a run token before any metadata, evidence, Check Run, or
        // workflow side effect. The read-then-write check above is useful for
        // ordinary retries, but is not sufficient when two requests arrive at
        // the same time. D1JsonMetadataStore implements this as INSERT OR
        // IGNORE, so only one request can win the token-use race.
        if (tokenUseKey && tokenPayloadDigest && !priorTokenUse) {
          const claimed = await metadata.putIfAbsent?.(tokenUseKey, { payloadDigest: tokenPayloadDigest, runId: runToken?.runId, repository, expiresAt: runToken?.expiresAt });
          if (claimed !== true) {
            const racedTokenUse = await metadata.get<{ payloadDigest?: string }>(tokenUseKey);
            if (!racedTokenUse) return json({ error: "The assurance run-token claim could not be established.", code: "run_token_claim_unavailable" }, 503);
            if (racedTokenUse.payloadDigest !== tokenPayloadDigest) return json({ error: "The OIDC run token was already used for different assurance metadata.", code: "run_token_reused" }, 409);
            return json({ ingested: true, authorized: true, replayed: true, organizationId: organizationId ?? "oidc", repository, sourceUpload: "not_uploaded" });
          }
        }
        const org = organizationId ?? "oidc";
        const key = assuranceMetadataKey(org, repository);
        if (priorTokenUse) return json({ ingested: true, authorized: true, replayed: true, organizationId: org, repository, sourceUpload: "not_uploaded" });
        await metadata.put(key, { ...checked.value, repository, organizationId: org, ingestedAt: new Date().toISOString(), sourceUpload: "not_uploaded", runId: runToken?.runId });
        await metadata.put(`assurance:audit:${org}:${crypto.randomUUID()}`, { action: "assurance_ingest", repository, actorId, at: new Date().toISOString() });
        if (env.EVIDENCE_BUCKET) {
          await evidenceStoreFromEnv({ bucket: env.EVIDENCE_BUCKET, exportEndpoint: env.EVIDENCE_EXPORT_ENDPOINT, exportToken: env.EVIDENCE_EXPORT_TOKEN })?.put(`${org}/${repository.replace("/", "_")}/${runToken?.runId ?? crypto.randomUUID()}.json`, { ...checked.value, repository, organizationId: org });
        }
        await publishVerificationToGitHub(env, {
          repository,
          sha: runToken?.sha ?? (typeof (checked.value as { receipts?: Array<{ headSha?: string }> }).receipts?.[0]?.headSha === "string" ? (checked.value as { receipts: Array<{ headSha: string }> }).receipts[0].headSha : undefined),
          runId: runToken?.runId,
          bundle: checked.value,
          dashboardUrl: applicationUrl(request, env, "/app"),
        });
        const verdict = translateLegacyVerdict(typeof boundReceipt?.verdict === "string"
          ? boundReceipt.verdict
          : typeof (checked.value as { receipts?: Array<{ verdict?: string }> }).receipts?.[0]?.verdict === "string"
            ? (checked.value as { receipts: Array<{ verdict: string }> }).receipts[0].verdict
            : "UNKNOWN");
        if (runToken?.runId && env.DB) {
          const run = await factories.getRun(runToken.runId);
          if (run?.work_order_id) {
            const order = await factories.getWorkOrder(run.work_order_id);
            if (order) {
              await factories.patchWorkOrder(order.workOrderId, { verificationVerdict: verdict, reviewAssessment: verdict === "FAIL" ? "REVISE" : verdict === "PASS" ? "CLEAR" : "NEEDS_HUMAN_REVIEW", now: new Date().toISOString() });
              await handleFactoryQueueMessage(env, { deliveryId: `oidc:${runToken.runId}`, organizationId: order.organizationId, factoryId: order.factoryId, repository, sourceType: order.sourceType, sourceId: order.sourceId, workOrderId: order.workOrderId, actor: "oidc-ingest", sha: runToken.sha, verificationVerdict: verdict, verificationIngested: true, specApproved: true, sandboxComplete: true });
            }
          }
        }
        if (tokenUseKey && tokenPayloadDigest) await metadata.put(tokenUseKey, { payloadDigest: tokenPayloadDigest, runId: runToken?.runId, repository, expiresAt: runToken?.expiresAt });
        return json({ ingested: true, authorized: true, organizationId: org, repository, sourceUpload: "not_uploaded" });
      }
      if (url.pathname === "/assurance/delete" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin assurance deletion rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:delete");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const body = await jsonBody(request);
        const repository = assuranceRepository(body?.repository);
        if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
        const metadata = new D1JsonMetadataStore(database);
        await metadata.delete(assuranceMetadataKey(access.membership.organizationId, repository));
        await metadata.put(`assurance:audit:${access.membership.organizationId}:${crypto.randomUUID()}`, { action: "assurance_delete", repository, actorId: access.current.session.user.id, at: new Date().toISOString() });
        return json({ deleted: true, authorized: true, organizationId: access.membership.organizationId, repository });
      }
      if (url.pathname === "/tenant/membership/sync" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin membership mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Membership reconciliation requires the D1 session store and session encryption secret.", code: "tenant_store_not_configured" }, 501);
        const current = await currentSession(request, store, env);
        if (!current) return json({ error: "Authentication is required.", code: "not_authenticated" }, 401);
        if (!current.session.organizationId) return json({ error: "The authenticated user is not associated with an organization.", code: "organization_not_selected" }, 403);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const tenants = new D1TenantStore(database);
        const membership = await provider.getOrganizationMembership(current.session.user.id, current.session.organizationId);
        if (membership) {
          await applyWorkOSMembership(membership, tenants, undefined, undefined, env);
        } else {
          await tenants.upsertMembership({ organizationId: current.session.organizationId, userId: current.session.user.id, role: "viewer", status: "removed" });
          await afterSeatChange(env, tenants, current.session.organizationId, current.session.user.id, "removed");
        }
        const access = await authorizeTenantSession(current, tenants);
        if (!access.ok) return json({ synchronized: true, authorized: false, code: access.code }, access.status);
        return json({ synchronized: true, ...publicAccess(access) });
      }
      if (url.pathname === "/tenant/invitations" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Invitation management requires the D1 session store and session encryption secret.", code: "tenant_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "invitations:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const calculated = await calculatedAccess(env, access);
        const entitlement = entitledFailureFrom(calculated, "team_invitations", false);
        if (entitlement) return entitlement;
        const invitations = await new D1TenantStore(database).listInvitations(access.membership.organizationId);
        return json({ authorized: true, organizationId: access.membership.organizationId, invitations: invitations.map(publicInvitation) });
      }
      if (url.pathname === "/tenant/invitations" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin invitation mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Invitation management requires the D1 session store and session encryption secret.", code: "tenant_store_not_configured" }, 501);
        const tenants = new D1TenantStore(database);
        const access = await authorizeTenantSession(await currentSession(request, store, env), tenants, "invitations:create");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const calculated = await calculatedAccess(env, access);
        const entitlement = entitledFailureFrom(calculated, "team_invitations", true);
        if (entitlement) return entitlement;
        const body = await jsonBody(request, 20_000);
        const email = invitationEmail(body?.email);
        const role = body?.role === undefined ? "viewer" : invitationRole(body.role);
        if (!email || !role) return json({ error: "A valid email and an invite-safe role (viewer, reviewer, or maintainer) are required.", code: "invalid_invitation_request" }, 400);
        const organizationId = access.membership.organizationId;
        if (await tenants.getPendingInvitation(organizationId, email)) return json({ error: "A pending invitation already exists for this email address.", code: "invitation_already_pending" }, 409);
        if (env.DB && await new D1FactoryStore(env.DB).hitRateLimit(`invite:${organizationId}`, 20, 60_000)) return json({ error: "Too many invitation attempts.", code: "rate_limited" }, 429);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const providerInvitation = await provider.createInvitation({ email, organizationId, roleSlug: role, inviterUserId: access.current.session.user.id, expiresInDays: 7 });
        if (providerInvitation.organizationId && providerInvitation.organizationId !== organizationId) return json({ error: "The identity provider returned an invitation for a different organization.", code: "provider_invalid_response" }, 502);
        const now = new Date().toISOString();
        const invitation: TenantInvitation = {
          invitationId: providerInvitation.id,
          organizationId,
          email: providerInvitation.email,
          role,
          state: providerInvitation.state,
          providerInvitationId: providerInvitation.id,
          inviterUserId: providerInvitation.inviterUserId ?? access.current.session.user.id,
          acceptedUserId: providerInvitation.acceptedUserId,
          expiresAt: providerInvitation.expiresAt,
          createdAt: providerInvitation.createdAt ?? now,
          updatedAt: providerInvitation.updatedAt ?? now,
        };
        await tenants.upsertInvitation(invitation);
        await new D1JsonMetadataStore(database).put(`tenant:audit:${organizationId}:${crypto.randomUUID()}`, { action: "invitation_created", invitationId: invitation.invitationId, email, role, actorId: access.current.session.user.id, at: now });
        return json({ sent: true, authorized: true, organizationId, invitation: publicInvitation(invitation) }, 201);
      }
      if (url.pathname === "/auth/signout" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin session mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const authorization = request.headers.get("authorization");
        const sessionId = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1] ?? cookieValue(request, "tinkerbot_session");
        if (store && sessionId) await store.delete(sessionId);
        return jsonWithCookies({ signedOut: true }, 200, [clearCookie("tinkerbot_session"), clearCookie("tinkerbot_oauth_state")]);
      }
      if (url.pathname === "/integrations/github/install/callback" && request.method === "GET") {
        const store = sessionStore(env, config);
        if (!store || !env.DB) return json({ error: "GitHub installation binding requires the D1 session and tenant stores.", code: "github_installation_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const installationId = Number(url.searchParams.get("installation_id"));
        if (!Number.isSafeInteger(installationId) || installationId <= 0) return json({ error: "A valid GitHub installation_id is required.", code: "invalid_github_installation" }, 400);
        const existingInstallation = await env.DB.prepare("SELECT organization_id, status FROM tinkerbot_github_installations WHERE installation_id = ?1 LIMIT 1").bind(installationId).first<{ organization_id?: string | null; status?: string }>();
        // Never allow a user in one tenant to rebind an installation that is
        // already owned by another tenant. A signed setup-state flow should be
        // added by the deployment, but this server-side invariant is required
        // even when the callback is invoked directly.
        if (existingInstallation?.organization_id && existingInstallation.organization_id !== access.membership.organizationId) return json({ error: "That GitHub installation is already connected to another organization.", code: "github_installation_owned" }, 409);
        if (env.ENVIRONMENT === "production" && (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)) return json({ error: "GitHub App verification is not configured.", code: "github_app_not_configured" }, 503);
        if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
          try {
            // Minting an installation token proves that this installation is
            // actually attached to this GitHub App; an arbitrary integer is
            // not sufficient to establish an integration binding.
            await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId });
          } catch {
            return json({ error: "The GitHub installation could not be verified for this App.", code: "github_installation_unverified" }, 403);
          }
        }
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT INTO tinkerbot_github_installations (installation_id, organization_id, status, installed_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3) ON CONFLICT(installation_id) DO UPDATE SET organization_id = excluded.organization_id, updated_at = excluded.updated_at")
          .bind(installationId, access.membership.organizationId, now).run();
        return json({ connected: true, authorized: true, organizationId: access.membership.organizationId, installationId });
      }
      if (url.pathname === "/integrations/github/webhook" && request.method === "POST") {
        if (!env.DB) return json({ error: "GitHub webhook persistence requires the D1 store.", code: "github_webhook_store_not_configured" }, 501);
        const payload = await boundedRequestText(request, 1_500_000);
        const eventName = request.headers.get("x-github-event") ?? undefined;
        const deliveryId = request.headers.get("x-github-delivery") ?? undefined;
        const admission = admitWebhook({ payload, signature: request.headers.get("x-hub-signature-256") ?? undefined, secret: env.GITHUB_WEBHOOK_SECRET, eventName, deliveryId });
        if (!admission.accepted || !admission.payload || !admission.idempotencyKey) return json({ error: "GitHub webhook was rejected.", code: admission.reason ?? "invalid_github_webhook" }, 401);
        const ledger = new D1WebhookLedger(env.DB, "github");
        if (ledger.claim && !await ledger.claim(admission.idempotencyKey)) return json({ received: true, duplicate: true });
        try {
          const persisted = await persistGitHubWebhook(env.DB, admission.payload, eventName);
          await new D1JsonMetadataStore(env.DB).put(`github:audit:${admission.idempotencyKey}`, admission.audit);
          if (persisted.kind === "pull_request" || persisted.kind === "issue") {
            const sourceType: "github_issue" | "github_pull_request" = persisted.kind === "issue" ? "github_issue" : "github_pull_request";
            const message: Parameters<typeof handleFactoryQueueMessage>[1] = { deliveryId: admission.idempotencyKey, installationId: persisted.installationId, repository: persisted.repository, sourceType, sourceId: persisted.sourceId ?? admission.idempotencyKey, issueOrPullRequest: persisted.sourceId, sha: persisted.sha, actor: "github-webhook" };
            if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
            else await handleFactoryQueueMessage(env, message);
          }
          const security = githubSecurityIntake(eventName ?? "", admission.payload);
          if (security) {
            const message: Parameters<typeof handleFactoryQueueMessage>[1] = { deliveryId: admission.idempotencyKey, installationId: persisted.installationId, repository: persisted.repository, sourceType: security.sourceType, sourceId: security.sourceId, issueOrPullRequest: security.title, actor: "github-webhook" };
            if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
            else await handleFactoryQueueMessage(env, message);
          }
          const mention = githubTinkerMention(eventName ?? "", admission.payload as Record<string, unknown>);
          const githubOrganization = persisted.installationId
            ? await env.DB.prepare("SELECT organization_id FROM tinkerbot_github_installations WHERE installation_id = ?1 LIMIT 1").bind(persisted.installationId).first<{ organization_id?: string | null }>()
            : persisted.repository
              ? await env.DB.prepare("SELECT i.organization_id FROM tinkerbot_github_repositories r JOIN tinkerbot_github_installations i ON i.installation_id = r.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(persisted.repository).first<{ organization_id?: string | null }>()
              : null;
          if (mention && githubOrganization?.organization_id) {
            const dispatched = dispatchTinkerGateway({
              text: mention,
              organizationId: githubOrganization.organization_id,
              sourceSystem: "github",
              sourceObjectId: admission.idempotencyKey,
              actorId: "github-webhook",
              authorized: true,
            });
            await new D1FactoryStore(env.DB).insertFactoryCommand(dispatched.command);
            await new D1JsonMetadataStore(env.DB).put(`tinker:${admission.idempotencyKey}`, dispatched);
          }
          // Mark the delivery processed only after every derived queue/command
          // operation succeeds. A failed dispatch must remain retryable.
          await ledger.record(admission.idempotencyKey);
          return json({ received: true, duplicate: false });
        } catch (error) {
          if (ledger.release) await ledger.release(admission.idempotencyKey);
          throw error;
        }
      }
      if (url.pathname === "/integrations/gitlab/webhook" && request.method === "POST") {
        if (!env.DB) return json({ error: "GitLab webhook persistence requires the D1 store.", code: "gitlab_webhook_store_not_configured" }, 501);
        const integrationOrganization = typeof env.INTEGRATION_ORGANIZATION_ID === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(env.INTEGRATION_ORGANIZATION_ID) ? env.INTEGRATION_ORGANIZATION_ID : undefined;
        if (env.ENVIRONMENT === "production" && (!env.GITLAB_WEBHOOK_SECRET || !integrationOrganization)) return json({ error: "Signed GitLab webhook and tenant binding are not configured.", code: "integration_not_configured" }, 503);
        const payload = await boundedRequestText(request, 1_500_000);
        const admission = admitGitlabWebhook({
          payload,
          token: request.headers.get("x-gitlab-token") ?? undefined,
          secret: env.GITLAB_WEBHOOK_SECRET,
          eventName: request.headers.get("x-gitlab-event") ?? undefined,
          deliveryId: request.headers.get("x-gitlab-event-uuid") ?? request.headers.get("x-request-id") ?? undefined,
        });
        if (!admission.accepted || !admission.payload || !admission.idempotencyKey || !admission.sourceType) return json({ error: "GitLab webhook was rejected.", code: admission.reason ?? "invalid_gitlab_webhook" }, 401);
        const ledger = new D1WebhookLedger(env.DB, "gitlab");
        if (ledger.claim && !await ledger.claim(admission.idempotencyKey)) return json({ received: true, duplicate: true });
        try {
          await new D1JsonMetadataStore(env.DB).put(`gitlab:audit:${admission.idempotencyKey}`, { sourceType: admission.sourceType, repository: admission.repository, event: request.headers.get("x-gitlab-event"), merge: false });
          const message: Parameters<typeof handleFactoryQueueMessage>[1] = {
            deliveryId: admission.idempotencyKey,
            organizationId: integrationOrganization,
            repository: admission.repository,
            sourceType: admission.sourceType,
            sourceId: admission.sourceId ?? admission.idempotencyKey,
            issueOrPullRequest: admission.title,
            actor: "gitlab-webhook",
          };
          if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
          else await handleFactoryQueueMessage(env, message);
          // A queue/handler failure must release the processing claim so the
          // provider can retry instead of losing the delivery permanently.
          await ledger.record(admission.idempotencyKey);
          return json({ received: true, duplicate: false, merge: false, sourceType: admission.sourceType });
        } catch (error) {
          if (ledger.release) await ledger.release(admission.idempotencyKey);
          throw error;
        }
      }
      if (url.pathname === "/integrations/workos/webhook" && request.method === "POST") {
        if (!env.DB) return json({ error: "WorkOS webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
        const payload = await boundedRequestText(request, 2_000_000);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey, webhookSecret: config.workos.webhookSecret });
        const ledger = new D1WebhookLedger(env.DB, "workos");
        const tenants = new D1TenantStore(env.DB);
        const result = await provider.handleWebhook(payload, request.headers.get("workos-signature"), ledger, (event) => applyWorkOSEvent(event, tenants, env));
        return json({ received: true, duplicate: result.duplicate });
      }
      if ((url.pathname === "/billing/webhook" || url.pathname === "/webhooks/stripe") && request.method === "POST") {
        if (!env.DB) return json({ error: "Stripe webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
        const payload = await boundedRequestText(request, 2_000_000);
        const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret });
        const ledger = new D1WebhookLedger(env.DB);
        const metadata = new D1JsonMetadataStore(env.DB);
        const tenants = new D1TenantStore(env.DB);
        const result = await provider.handleWebhook(payload, request.headers.get("stripe-signature"), ledger, (event) => applyStripeEvent(event, metadata, new D1BillingStore(env.DB!), tenants, config.stripe.plans, env.DB));
        return json({ received: true, duplicate: result.duplicate });
      }
      if (url.pathname === "/billing/catalog" && request.method === "GET") {
        return json(publicCatalogResponse());
      }
      if (url.pathname === "/billing/summary" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "billing:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const account = await new D1BillingStore(database).getByOrganization(access.membership.organizationId);
        const calculated = await entitlementsForOrganization(database, access.membership.organizationId, access.entitlements);
        const seats = await new D1TenantStore(database).countSeatUsage(access.membership.organizationId);
        const plan = calculated.planId === "developer" || calculated.planId === "team" || calculated.planId === "business" ? publicCatalogResponse().plans.find((item) => item.id === calculated.planId) : publicCatalogResponse().plans.find((item) => item.id === "free");
        return json({
          authorized: true,
          organizationId: access.membership.organizationId,
          catalogVersion: calculated.catalogVersion,
          planId: calculated.planId,
          interval: account?.interval ?? null,
          pricePerSeatCents: account?.interval === "year" ? plan?.annualPriceCents ?? null : plan?.monthlyPriceCents ?? 0,
          subscriptionState: calculated.billingStatus,
          activeBillableSeats: seats,
          paidSeatCap: plan?.paidSeatCap ?? "none",
          trialState: calculated.trialState ?? null,
          trialEndsAt: calculated.trialEndsAt ?? null,
          cancellation: { cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false, currentPeriodEnd: account?.currentPeriodEnd ?? null },
          paymentState: account?.status ?? "free",
          entitlements: calculated.features,
          limited: calculated.limited,
        });
      }
      if (url.pathname === "/org/seats" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Seat listing requires the D1 session store.", code: "billing_contract_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "billing:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        return json({ authorized: true, organizationId: access.membership.organizationId, activeBillableSeats: await new D1TenantStore(database).countSeatUsage(access.membership.organizationId) });
      }
      if ((url.pathname === "/billing/checkout" || url.pathname === "/billing/portal" || url.pathname === "/billing/subscription/cancel" || url.pathname === "/billing/subscription/reactivate" || url.pathname === "/billing/subscription/change" || url.pathname === "/billing/trial/start" || url.pathname === "/billing/reconcile") && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin billing mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "billing:manage");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const organizationId = access.membership.organizationId;
        if (productionCatalogUnavailable(env.ENVIRONMENT, config.stripe.plans) && url.pathname !== "/billing/trial/start") return json({ error: "The production Stripe catalog is not configured.", code: "catalog_unavailable" }, 503);
        const billing = new D1BillingStore(database);
        const billingState = await billing.getByOrganization(organizationId);
        const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, plans: config.stripe.plans });
        const body = await jsonBody(request);
        if (url.pathname === "/billing/trial/start") {
          const trial = await startTeamTrial(database, organizationId, access.current.session.user.id);
          if (!trial.ok) return json({ error: trial.error, code: trial.code }, 409);
          return json({ pending: false, trial: { state: "trialing", endsAt: trial.endsAt }, grantedFromRedirect: false });
        }
        if (url.pathname === "/billing/reconcile") {
          const result = await syncStripeQuantity({ database, provider, organizationId });
          await recordBillingAudit(database, { organizationId, actorId: access.current.session.user.id, action: "reconcile", payload: result });
          return json({ pending: Boolean(result.pending), expectedQuantity: result.expected });
        }
        if (!body && url.pathname !== "/billing/portal" && url.pathname !== "/billing/subscription/cancel" && url.pathname !== "/billing/subscription/reactivate") return json({ error: "A JSON request body is required.", code: "invalid_request" }, 400);
        if (url.pathname === "/billing/checkout") {
          const allowed = checkoutPlanAllowed(typeof body?.planId === "string" ? body.planId : "", body?.interval === "year" ? "year" : body?.interval === "month" ? "month" : "", config.stripe.plans);
          if (!allowed) return json({ error: "planId and interval must match the server catalog.", code: "invalid_billing_request" }, 400);
          // Reject client attempts to smuggle server-owned billing inputs even
          // when the value is falsy (for example quantity=0 or an empty ID).
          if (["priceId", "quantity", "organizationId", "entitlements"].some((field) => Object.prototype.hasOwnProperty.call(body ?? {}, field))) return json({ error: "Client-submitted price, quantity, organization, and entitlement fields are ignored. Use planId and interval only.", code: "invalid_billing_request" }, 400);
          if (billingState?.subscriptionId && !["canceled", "cancelled", "incomplete_expired", "free"].includes(billingState.status)) return json({ error: "This organization already has a subscription. Change it in-app or in the billing portal instead.", code: "subscription_already_exists" }, 409);
          const requestKey = request.headers.get("idempotency-key")?.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120) || crypto.randomUUID();
          const seatQuantity = await new D1TenantStore(database).countSeatUsage(organizationId);
          await new D1FactoryStore(database).putSeatLedger(organizationId, new Date().toISOString().slice(0, 7), seatQuantity, new Date().toISOString());
          const checkout = await provider.createCheckoutSession({ planId: allowed.planId, interval: allowed.interval, organizationId, successUrl: safeReturnUrl(body?.successUrl, request, env, "/app/settings/billing"), cancelUrl: safeReturnUrl(body?.cancelUrl, request, env, "/app/settings/billing"), customerId: billingState?.customerId, customerEmail: access.current.session.user.email, seatQuantity, idempotencyKey: `checkout:${organizationId}:${allowed.planId}:${allowed.interval}:${requestKey}` });
          await new D1JsonMetadataStore(database).put(`billing:checkout:${checkout.id}`, { organizationId, planId: allowed.planId, interval: allowed.interval, createdAt: new Date().toISOString() } satisfies CheckoutMapping);
          await database.prepare("INSERT INTO tinkerbot_checkout_sessions (checkout_session_id, organization_id, plan_id, billing_interval, seat_quantity, idempotency_key, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)").bind(checkout.id, organizationId, allowed.planId, allowed.interval, seatQuantity, requestKey, new Date().toISOString()).run();
          return json({ pending: true, checkout, grantedFromRedirect: false });
        }
        if (url.pathname === "/billing/portal") {
          if (!billingState?.customerId) return json({ error: "No billing customer is associated with this organization yet.", code: "billing_customer_missing" }, 409);
          const portal = await provider.createPortalSession({ customerId: billingState.customerId, returnUrl: safeReturnUrl(body?.returnUrl, request, env, "/app/settings/billing"), idempotencyKey: `portal:${organizationId}:${crypto.randomUUID()}` });
          return json({ portal });
        }
        if (url.pathname === "/billing/subscription/change") {
          if (!billingState?.subscriptionId) return json({ error: "No active subscription is associated with this organization.", code: "billing_subscription_missing" }, 409);
          const allowed = checkoutPlanAllowed(typeof body?.planId === "string" ? body.planId : "", body?.interval === "year" ? "year" : body?.interval === "month" ? "month" : billingState.interval ?? "month", config.stripe.plans);
          if (!allowed) return json({ error: "planId and interval must match the server catalog.", code: "invalid_billing_request" }, 400);
          const currentRank = { developer: 1, team: 2, business: 3, free: 0, enterprise: 4 };
          const upgrade = currentRank[allowed.planId] >= currentRank[(billingState.planId as keyof typeof currentRank) ?? "developer"] && !(billingState.interval === "year" && allowed.interval === "month");
          const priceId = allowed.interval === "year" ? allowed.stripe.annualPriceId : allowed.stripe.monthlyPriceId;
          if (!priceId) return json({ error: "The requested interval is not configured.", code: "price_not_configured" }, 409);
          const quantity = await new D1TenantStore(database).countSeatUsage(organizationId);
          const changed = await provider.changeSubscriptionPrice({ subscriptionId: billingState.subscriptionId, priceId, quantity, prorationBehavior: upgrade ? "create_prorations" : "none", idempotencyKey: `change:${organizationId}:${allowed.planId}:${allowed.interval}` });
          await recordBillingAudit(database, { organizationId, actorId: access.current.session.user.id, action: "subscription_change", payload: { planId: allowed.planId, interval: allowed.interval, upgrade } });
          return json({ pending: true, subscription: changed, effective: upgrade ? "immediate" : "period_end" });
        }
        if (!billingState?.subscriptionId) return json({ error: "No active subscription is associated with this organization.", code: "billing_subscription_missing" }, 409);
        const cancelAtPeriodEnd = url.pathname === "/billing/subscription/cancel";
        const subscription = await provider.setSubscriptionCancellation({ subscriptionId: billingState.subscriptionId, cancelAtPeriodEnd, idempotencyKey: `${cancelAtPeriodEnd ? "cancel" : "reactivate"}:${organizationId}:${billingState.subscriptionId}` });
        return json({ pending: true, subscription });
      }
      const factoryResponse = await handleFactoryHttp(request, env, url, config);
      if (factoryResponse) return factoryResponse;
      if (env.ASSETS && request.method === "GET") {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
      }
      return json({ error: "Not found", code: "not_found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "control_plane_request_failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.name : "UnknownError", provider: error instanceof ProviderError ? error.provider : undefined, code: error instanceof ProviderError ? error.code : undefined }));
      return errorResponse(error);
    }
  },
  async queue(batch: { messages: Array<{ body: Parameters<typeof handleFactoryQueueMessage>[1]; ack(): void }> }, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await handleFactoryQueueMessage(env, message.body);
      message.ack();
    }
  },
  async scheduled(controller: { cron?: string }, env: Env): Promise<void> {
    if (env.DB) await reconcileBilling(env);
    await sweepFactoryOs(env);
    if (env.WORKOS_EVENTS_SYNC_ENABLED !== "true") return;
    const result = await reconcileWorkOSEvents(env);
    console.log(JSON.stringify({ event: "workos_events_reconciled", cron: controller.cron, processed: result.processed, cursor: result.cursor ?? null }));
  },
};
