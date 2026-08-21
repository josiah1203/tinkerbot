import {
  D1DatabaseLike,
  D1TenantStore,
  ProviderError,
  hostedProviderConfig,
  providerStatuses,
} from "../../../packages/hosted-integrations/src";
import { D1FactoryStore } from "./factory-store";
import { Sandbox, handleFactoryMcpRequest, runFactoryTurn, routeFactoryCellHold, routeFactoryGraphCommand, routeFactoryQueueMessage, routeFactorySpecApproval, routeFactoryTransition, factoryWorkOrderCoordinationName, classifyWorkOrderGroup } from "./factory-runtime";
import { ForemanDurableObject, runForemanWorkDecision } from "./foreman-routes";
import { sweepFactoryOs } from "./factory-maintenance";
import { assertCredentialRef, calculateFactoryEconomics, createFactoryOperationalSignal, parseFactoryTelemetryRetentionDays, projectFactoryEvents, verifyOidcJwt, oidcReplayKey, containsRawCredentials, customerProviderLabel, sameActorApprovalBlocked, selfHostedSecretReady, canonicalize, factoryCollectionRouteResponse, workOrderGraphRouteResponse, workOrderListRouteResponse, workOrderRouteView, workOrderDetailRouteResponse, workOrderMutationRouteResponse, workOrderRunRouteResponse, type FactoryEvent, type WorkOrderState } from "../../../packages/factory/src";
import { createChangeSet, assessChangeSet, assessReleaseSafety, createReleaseManifest } from "../../../packages/assurance/src";
import { calculateEntitlements, type EntitlementKey } from "../../../packages/control-plane/src";
import {
  entitlementDenied,
  entitlementsForOrganization,
} from "./billing";
import { handleBillingRoute, reconcileBilling } from "./billing-routes";
import { authorizeTenantSession, currentSession, publicAccess, roleHasCapability, sessionStore, type AuthorizedSession } from "./tenant-auth";
import { reconcileWorkOSEvents, workOSRoleToTenantRole } from "./workos-sync";
import { handleSelfHostedCompletion } from "./self-hosted-routes";
import { handleTenantRoute } from "./tenant-routes";
import { handleAssuranceRoute } from "./assurance-routes";
import { handleIntegrationRoute } from "./integration-routes";
export { workOSRoleToTenantRole } from "./workos-sync";
export { roleHasCapability } from "./tenant-auth";
export { ForemanDurableObject, Sandbox };

export interface Env extends Record<string, unknown> {
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
  FACTORY_SHADOW_READ_ORGANIZATION_ID?: string;
  FACTORY_TELEMETRY_RETENTION_DAYS?: string;
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

function operationalErrorCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.name : fallback;
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96) || fallback;
}

async function emitFactoryOperationalSignal(env: Env | undefined, input: Parameters<typeof createFactoryOperationalSignal>[0], error = false): Promise<void> {
  let signal: ReturnType<typeof createFactoryOperationalSignal>;
  try {
    signal = createFactoryOperationalSignal(input);
  } catch (signalError) {
    console.error(JSON.stringify({ event: "factory_operational_signal_rejected", errorCode: operationalErrorCode(signalError, "factory_operational_signal_invalid") }));
    return;
  }
  const encoded = JSON.stringify(signal);
  if (error) console.error(encoded);
  else console.log(encoded);
  if (!env?.DB) return;
  try {
    await new D1FactoryStore(env.DB).persistOperationalSignal(signal);
  } catch (sinkError) {
    // Operational telemetry is deliberately best-effort and cannot affect
    // command authority, queue acknowledgement, or lifecycle state.
    console.error(JSON.stringify({ event: "factory_operational_sink_failed", signal: signal.signal, correlationId: signal.correlationId, errorCode: operationalErrorCode(sinkError, "factory_operational_sink_failed") }));
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function jsonWithCookies(value: unknown, status: number, cookies: string[]): Response {
  const headers = new Headers(jsonHeaders);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(value), { status, headers });
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
  const selfHostedResponse = await handleSelfHostedCompletion(request, env, url, factories, { json, jsonBody, handleFactoryQueueMessage });
  if (selfHostedResponse) return selfHostedResponse;
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
  const store = sessionStore(env, config);
  if (!store) return undefined;
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
    const graph = projectFactoryEvents(events);
    if (!view) return json({ error: "Work order view not found.", code: "not_found" }, 404);
    return json(workOrderGraphRouteResponse({
      workOrder: workOrderRouteView(view, { lane: view.stage }),
      graph,
      economics: calculateFactoryEconomics(events),
      events,
      sourceOfTruth: "append_only_factory_graph",
    }));
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
    const decision = body?.decision === "approved" || body?.decision === "rejected" || body?.decision === "changes_requested" || body?.decision === "hold" ? body.decision : undefined;
    if (!type || !decision) return json({ error: "type and decision must be a supported typed decision.", code: "invalid_decision" }, 400);
    const actor = access.current.session.user.id;
    const decisionRouteResponse = async (payload: unknown, status: number): Promise<Response> => {
      if (status >= 400) return json(payload, status);
      const payloadObject = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { result: payload };
      const { workOrder: _legacyWorkOrder, ...acknowledgement } = payloadObject;
      const updated = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      return json(workOrderMutationRouteResponse({
        ...acknowledgement,
        workOrderId: order.workOrderId,
        workOrder: updated ? workOrderRouteView(updated, { lane: updated.stage }) : undefined,
      }), status);
    };
    const dispatchDecision = async (): Promise<Response> => {
      const now = new Date().toISOString();
      if (env.FOREMAN) {
        const id = env.FOREMAN.idFromName(factoryWorkOrderCoordinationName(access.membership.organizationId, order.workOrderId));
        const response = await env.FOREMAN.get(id).fetch(new Request("https://tinkerbot.internal/foreman/decision", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tinkerbot-internal": "foreman-v1" },
          body: JSON.stringify({ command: "work_decision", workOrderId: order.workOrderId, organizationId: access.membership.organizationId, actor, type, decision, now }),
        }));
        let payload: unknown = { error: "Foreman decision failed.", code: "foreman_decision_failed" };
        try { payload = await response.json(); } catch { /* use the stable fallback above */ }
        return decisionRouteResponse(payload, response.status);
      }
      const result = await runForemanWorkDecision(env, { workOrderId: order.workOrderId, organizationId: access.membership.organizationId, actor, type, decision, now });
      return decisionRouteResponse(result, 200);
    };
    if (type === "review") {
      if (decision === "hold") return json({ error: "Review decisions cannot use a release hold; record a review outcome instead.", code: "invalid_review_decision" }, 400);
      if (view.reviewDecision !== "awaiting_human") return json({ error: "This work order is not awaiting human review.", code: "review_not_available" }, 409);
      const independence = sameActorApprovalBlocked({ actorId: actor, cellHolderId: order.heldBy, lineId: order.lineId, autonomyMode: order.autonomyMode });
      if (independence.blocked) return json({ error: "The producer cannot approve this restricted work order.", code: independence.reason }, 403);
      return dispatchDecision();
    }
    if (decision !== "approved" && decision !== "hold") return json({ error: "Release authorization must be approved, held, or omitted; use review for a rejected change.", code: "invalid_release_decision" }, 400);
    if (body?.evidenceAcknowledged !== true) return json({ error: "Evidence acknowledgement is required before release authorization.", code: "evidence_acknowledgement_required" }, 409);
    if (view.verificationVerdict !== "pass" || view.reviewDecision !== "approved" || !["awaiting_authorization", "hold"].includes(view.releaseDecision)) return json({ error: "Release authorization requires a passing deterministic verdict, human review, and release policy eligibility.", code: "release_gate_blocked" }, 409);
    return dispatchDecision();
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
      return json(workOrderListRouteResponse(workOrders.map((order) => workOrderRouteView(order, {
        legacyGroup: classifyWorkOrderGroup(order.status as Parameters<typeof classifyWorkOrderGroup>[0]),
        lane: order.stage,
      }))));
    }
    if (request.method === "GET" && workMatch[1]) {
      const order = await factories.getWorkOrder(workMatch[1]);
      if (!order || order.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
      const view = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      const run = await factories.getRunByWorkOrder(order.workOrderId);
      const stages = run ? await factories.listRunStages(run.run_id) : [];
      const events = await factories.listFactoryEvents(order.workOrderId, access.membership.organizationId);
      const graph = projectFactoryEvents(events);
      if (!view) return json({ error: "Work order view not found.", code: "not_found" }, 404);
      return json(workOrderDetailRouteResponse({ workOrder: workOrderRouteView(view, { lane: view.stage }), run, stages, events, availableActions: view.availableActions, graph }));
    }
    if (request.method === "POST" && !workMatch[1]) {
      if (!originAllowed(request, env)) return json({ error: "Cross-origin work-order mutation rejected.", code: "csrf_origin_rejected" }, 403);
      const body = await jsonBody(request);
      const factoryId = typeof body?.factoryId === "string" ? body.factoryId : "";
      const repositoryId = typeof body?.repositoryId === "string" ? body.repositoryId : "";
      if (!factoryId || !repositoryId) return json({ error: "factoryId and repositoryId are required.", code: "invalid_request" }, 400);
      const factory = await factories.getFactory(factoryId);
      if (!factory || factory.organizationId !== access.membership.organizationId) return json({ error: "Factory not found.", code: "not_found" }, 404);
      const sourceId = `manual:${crypto.randomUUID()}`;
      const result = await handleFactoryQueueMessage(env, { deliveryId: sourceId, organizationId: access.membership.organizationId, factoryId, repository: repositoryId, sourceType: "manual", sourceId, issueOrPullRequest: typeof body?.intent === "string" ? body.intent : undefined, actor: access.current.session.user.id });
      const order = await factories.getWorkOrderForOrganization(result.workOrderId, access.membership.organizationId);
      if (!order) return json({ error: "The Foreman did not persist the WorkOrder.", code: "work_order_persistence_failed" }, 500);
      const view = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
      return json(workOrderMutationRouteResponse({ workOrder: view ? workOrderRouteView(view, { lane: view.stage }) : undefined, availableActions: view?.availableActions ?? [] }), 201);
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
        const updated = await factories.getWorkOrderView(order.workOrderId, access.membership.organizationId);
        return json(workOrderMutationRouteResponse({ steered: true, workOrderId: order.workOrderId, workOrder: updated ? workOrderRouteView(updated, { lane: updated.stage }) : undefined }));
      }
      if (workMatch[2] === "take" || workMatch[2] === "return") {
        const current = await factories.getWorkOrder(workMatch[1]);
        if (!current || current.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
        const actor = access.current.session.user.id;
        const now = new Date().toISOString();
        const result = await routeFactoryCellHold(env, { workOrderId: current.workOrderId, organizationId: current.organizationId, actor, action: workMatch[2], now });
        if (!result.ok) return json({ error: "Work order not found.", code: result.code }, 404);
        const view = await factories.getWorkOrderView(result.workOrder.workOrderId, access.membership.organizationId);
        return json(workOrderMutationRouteResponse({ workOrder: view ? workOrderRouteView(view, { lane: view.stage }) : undefined, held: result.held }));
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
        await routeFactorySpecApproval(env, { workOrderId: current.workOrderId, organizationId: current.organizationId, actor: access.current.session.user.id, decision: "approved", signature: "session", now: new Date().toISOString() });
        if (spec) {
          await handleFactoryQueueMessage(env, { deliveryId: `spec-approve:${crypto.randomUUID()}`, organizationId: current.organizationId, factoryId: current.factoryId, repository: current.repositoryId, sourceType: current.sourceType, sourceId: current.sourceId, workOrderId: current.workOrderId, issueOrPullRequest: current.issueOrPullRequest, actor: access.current.session.user.id, specApproved: true });
          const updated = await factories.getWorkOrderView(current.workOrderId, access.membership.organizationId);
          return json(workOrderMutationRouteResponse({ workOrder: updated ? workOrderRouteView(updated, { lane: updated.stage }) : undefined, specApproved: true }));
        }
      }
      const current = await factories.getWorkOrder(workMatch[1]);
      if (!current || current.organizationId !== access.membership.organizationId) return json({ error: "Work order not found.", code: "not_found" }, 404);
      const toState: WorkOrderState = workMatch[2] === "approve" ? "ready" : workMatch[2] === "cancel" ? "cancelled" : "intake";
      const result = await routeFactoryTransition(env, { organizationId: current.organizationId, workOrderId: current.workOrderId, toState, causeId: `${workMatch[2]}:${crypto.randomUUID()}`, actor: access.current.session.user.id, now: new Date().toISOString() });
      if (!result.ok) return json({ error: "Work-order transition was rejected.", code: result.code }, result.code === "not_found" ? 404 : 409);
      const updated = await factories.getWorkOrderView(current.workOrderId, access.membership.organizationId);
      return json(workOrderMutationRouteResponse({ workOrder: updated ? workOrderRouteView(updated, { lane: updated.stage }) : undefined }));
    }
  }
  if (runMatch && request.method === "GET") {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const run = await factories.getRunForOrganization(runMatch[1], access.membership.organizationId);
    if (!run) return json({ error: "Run not found.", code: "not_found" }, 404);
    const stages = await factories.listRunStages(runMatch[1]);
    const events = await factories.listFactoryEvents(run.work_order_id, access.membership.organizationId);
    return json(workOrderRunRouteResponse({ run, stages, events }));
  }
  const osList = url.pathname.match(/^\/(products|cells|skills|evolution|releases|outcomes)(?:\/([^/]+))?(?:\/(approve))?$/);
  if (osList) {
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), osList[1] === "evolution" && osList[3] === "approve" ? "factory:write" : "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const listed = await factories.listFactories(access.membership.organizationId);
    const factoryId = listed[0]?.factoryId;
    if (osList[1] === "products" && request.method === "GET") return json(factoryCollectionRouteResponse("products", await factories.listProducts(access.membership.organizationId)));
    if (osList[1] === "cells" && request.method === "GET") return json(factoryCollectionRouteResponse("cells", factoryId ? await factories.listWorkCells(factoryId) : []));
    if (osList[1] === "skills" && request.method === "GET") {
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "custom_factory_skills", false);
      if (denied) return denied;
      return json(factoryCollectionRouteResponse("skills", factoryId ? await factories.listSkills(factoryId) : []));
    }
    if (osList[1] === "evolution" && request.method === "GET") {
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "factory_improvement", false);
      if (denied) return denied;
      return json(factoryCollectionRouteResponse("proposals", factoryId ? await factories.listProposals(factoryId) : []));
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
    if (osList[1] === "releases" && request.method === "GET") return json(factoryCollectionRouteResponse("releases", factoryId ? await factories.listReleaseCandidates(factoryId) : []));
    if (osList[1] === "outcomes" && request.method === "GET") return json(factoryCollectionRouteResponse("outcomes", await factories.listOutcomes(access.membership.organizationId)));
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
      const suppliedChangeSetId = typeof body?.changeSetId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(body.changeSetId) ? body.changeSetId : undefined;
      if (workOrderId) {
        const linkedOrder = await factories.getWorkOrderForOrganization(workOrderId, access.membership.organizationId);
        if (!linkedOrder) return json({ error: "Work order not found.", code: "not_found" }, 404);
      }
      const changeSetId = suppliedChangeSetId ?? crypto.randomUUID();
      const changeSetDigest = `sha256:${await sha256Text(JSON.stringify(canonicalize(changeSet)))}`;
      if (workOrderId) {
        const linkedOrder = await factories.getWorkOrderForOrganization(workOrderId, access.membership.organizationId);
        if (!linkedOrder) return json({ error: "Work order not found.", code: "not_found" }, 404);
        const prior = await factories.reconstructFactoryGraph(workOrderId, access.membership.organizationId);
        const eventType: FactoryEvent["type"] = prior.currentChangeSetDigest ? "change.updated" : "change.proposed";
        const event: FactoryEvent = {
          eventId: `change:${changeSetId}`,
          type: eventType,
          aggregateId: workOrderId,
          aggregateType: "work_order",
          organizationId: access.membership.organizationId,
          factoryId: linkedOrder.factoryId,
          actorId: access.current.session.user.id,
          actorType: "human",
          occurredAt: new Date().toISOString(),
          correlationId: changeSetId,
          schemaVersion: 1,
          policyVersion: linkedOrder.policyVersion,
          provenance: "HUMAN_VERIFIED",
          payload: { workOrderId, changeSetId, changeSetDigest },
        };
        const idempotencyKey = request.headers.get("x-idempotency-key") ?? (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : `change-set:${changeSetId}`);
        await routeFactoryGraphCommand(env, {
          organizationId: access.membership.organizationId,
          factoryId: linkedOrder.factoryId,
          workOrderId,
          actorId: access.current.session.user.id,
          actorType: "human",
          idempotencyKey,
          payload: { changeSetId, changeSetDigest },
          now: event.occurredAt,
          event,
        });
      }
      await env.DB.prepare("INSERT OR IGNORE INTO tinkerbot_change_sets (change_set_id, work_order_id, payload_json, updated_at) VALUES (?1, ?2, ?3, ?4)").bind(changeSetId, workOrderId ?? "unassigned", JSON.stringify({ changeSet, changeSetDigest, assessment }), new Date().toISOString()).run();
      return json({ changeSetId, changeSet, changeSetDigest, assessment }, 201);
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
      const integrationResponse = await handleIntegrationRoute(request, env, url, config, { json, readBodyText: boundedRequestText, handleFactoryQueueMessage });
      if (integrationResponse) return integrationResponse;
      const tenantResponse = await handleTenantRoute(request, env, url, config, { json, jsonWithCookies, jsonBody, originAllowed, pkceChallenge, safeRedirectUri, calculatedAccess, entitledFailureFrom });
      if (tenantResponse) return tenantResponse;
      const assuranceResponse = await handleAssuranceRoute(request, env, url, config, { json, jsonBody, originAllowed, applicationUrl, calculatedAccess, entitledFailureFrom, handleFactoryQueueMessage });
      if (assuranceResponse) return assuranceResponse;
      const billingResponse = await handleBillingRoute(request, env, config, {
        json,
        readBodyText: boundedRequestText,
        jsonBody,
        sessionStore,
        currentSession,
        authorizeTenantSession,
        originAllowed,
        safeReturnUrl,
      });
      if (billingResponse) return billingResponse;
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
      const startedAt = Date.now();
      const body = message.body;
      try {
        await handleFactoryQueueMessage(env, body);
        await emitFactoryOperationalSignal(env, { signal: "queue_delivery", outcome: "completed", correlationId: `${body.workOrderId ?? body.sourceId}:${body.deliveryId}`, organizationId: body.organizationId, workOrderId: body.workOrderId, durationMs: Math.max(0, Date.now() - startedAt), createdAt: new Date().toISOString() });
        message.ack();
      } catch (error) {
        await emitFactoryOperationalSignal(env, { signal: "queue_delivery", outcome: "failed", correlationId: `${body.workOrderId ?? body.sourceId}:${body.deliveryId}`, organizationId: body.organizationId, workOrderId: body.workOrderId, durationMs: Math.max(0, Date.now() - startedAt), errorCode: operationalErrorCode(error, "queue_delivery_failed"), createdAt: new Date().toISOString() }, true);
        throw error;
      }
    }
  },
  async scheduled(controller: { cron?: string }, env: Env): Promise<void> {
    if (env.DB) await reconcileBilling(env);
    await sweepFactoryOs(env);
    if (env.DB && typeof env.FACTORY_SHADOW_READ_ORGANIZATION_ID === "string" && env.FACTORY_SHADOW_READ_ORGANIZATION_ID.trim()) {
      const summary = await new D1FactoryStore(env.DB).shadowReadOrganization(env.FACTORY_SHADOW_READ_ORGANIZATION_ID.trim());
      const evidence = { event: "factory_projection_shadow_read", cron: controller.cron, organizationId: summary.organizationId, checkedAt: summary.checkedAt, checked: summary.checked, skipped: summary.skipped, divergentWorkOrders: summary.divergentWorkOrders, status: summary.status };
      if (summary.status === "diverged") console.error(JSON.stringify({ ...evidence, divergences: summary.divergences.slice(0, 100) }));
      else console.log(JSON.stringify(evidence));
      await emitFactoryOperationalSignal(env, { signal: "projection_shadow_read", outcome: summary.status === "clean" ? "completed" : "failed", correlationId: `shadow:${summary.organizationId}`, organizationId: summary.organizationId, durationMs: 0, createdAt: summary.checkedAt, dimensions: { checked: summary.checked, skipped: summary.skipped, divergentWorkOrders: summary.divergentWorkOrders } }, summary.status === "diverged");
    }
    if (env.DB && env.FACTORY_TELEMETRY_RETENTION_DAYS !== undefined) {
      const retentionDays = parseFactoryTelemetryRetentionDays(env.FACTORY_TELEMETRY_RETENTION_DAYS);
      if (retentionDays === null) {
        await emitFactoryOperationalSignal(env, { signal: "telemetry_retention", outcome: "failed", correlationId: "telemetry-retention", errorCode: "factory_telemetry_retention_invalid", createdAt: new Date().toISOString() }, true);
      } else {
        try {
          const deleted = await new D1FactoryStore(env.DB).pruneTelemetry(retentionDays);
          await emitFactoryOperationalSignal(env, { signal: "telemetry_retention", outcome: "completed", correlationId: "telemetry-retention", durationMs: 0, createdAt: new Date().toISOString(), dimensions: { retentionDays, commandDeleted: deleted.commandDeleted, operationalDeleted: deleted.operationalDeleted } });
        } catch (error) {
          await emitFactoryOperationalSignal(env, { signal: "telemetry_retention", outcome: "failed", correlationId: "telemetry-retention", errorCode: operationalErrorCode(error, "factory_telemetry_retention_failed"), createdAt: new Date().toISOString() }, true);
        }
      }
    }
    if (env.WORKOS_EVENTS_SYNC_ENABLED !== "true") return;
    const result = await reconcileWorkOSEvents(env);
    console.log(JSON.stringify({ event: "workos_events_reconciled", cron: controller.cron, processed: result.processed, cursor: result.cursor ?? null }));
  },
};
