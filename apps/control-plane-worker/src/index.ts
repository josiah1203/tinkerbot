import {
  D1AuthSessionStore,
  D1BillingStore,
  D1DatabaseLike,
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  HostedSession,
  TenantEntitlement,
  TenantBillingAccount,
  TenantInvitation,
  TenantMembership,
  TenantRole,
  WorkOSWebhookEvent,
  normalizeWorkOSMembership,
  ProviderError,
  StripeBillingProvider,
  StripePlan,
  StripeWebhookEvent,
  WorkOSAuthProvider,
  hostedProviderConfig,
  normalizeWorkOSInvitation,
  providerStatuses,
} from "../../../packages/hosted-integrations/src";

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
  SESSION_ENCRYPTION_KEY?: string;
  WORKOS_REDIRECT_URI?: string;
  CONTROL_PLANE_URL?: string;
  DB?: D1DatabaseLike;
  EVIDENCE_BUCKET?: unknown;
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
  return env.DB && config.sessionEncryptionKey ? new D1AuthSessionStore(env.DB, config.sessionEncryptionKey) : null;
}

async function currentSession(request: Request, store: D1AuthSessionStore): Promise<{ id: string; session: HostedSession } | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
  const id = bearer ?? cookieValue(request, "tinkerbot_session");
  if (!id) return null;
  const session = await store.get(id);
  return session ? { id, session } : null;
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

type TenantCapability = "tenant:read" | "billing:read" | "billing:manage" | "invitations:read" | "invitations:create" | "assurance:read" | "assurance:write" | "assurance:delete";

const ROLE_CAPABILITIES: Record<TenantRole, readonly TenantCapability[]> = {
  owner: ["tenant:read", "billing:read", "billing:manage", "invitations:read", "invitations:create", "assurance:read", "assurance:write", "assurance:delete"],
  admin: ["tenant:read", "billing:read", "billing:manage", "invitations:read", "invitations:create", "assurance:read", "assurance:write", "assurance:delete"],
  billing_administrator: ["tenant:read", "billing:read", "billing:manage"],
  maintainer: ["tenant:read", "assurance:read", "assurance:write"],
  reviewer: ["tenant:read", "assurance:read"],
  viewer: ["tenant:read", "assurance:read"],
};

export function roleHasCapability(role: TenantRole, capability: TenantCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

async function authorizeTenantSession(current: { id: string; session: HostedSession } | null, tenants: D1TenantStore, requiredCapability?: TenantCapability): Promise<AuthorizedSession | AuthorizationFailure> {
  if (!current) return { ok: false, status: 401, code: "not_authenticated", error: "Authentication is required." };
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

function activeEntitlement(access: AuthorizedSession): boolean {
  const status = access.entitlements?.billingStatus?.trim().toLowerCase();
  return Boolean(access.entitlements) && ["active", "trialing", "paid"].includes(status ?? "");
}

function featureEntitled(access: AuthorizedSession, feature: string): boolean {
  if (!activeEntitlement(access)) return false;
  return access.entitlements?.features?.[feature] === true;
}

function entitledFailure(access: AuthorizedSession, feature: string): Response | null {
  if (featureEntitled(access, feature)) return null;
  return json({ error: "The current server-side entitlement does not include this capability.", code: "entitlement_required", feature }, 403);
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

function assuranceMetadataKey(organizationId: string, repository: string): string {
  return `assurance:${encodeURIComponent(organizationId)}:${encodeURIComponent(repository)}`;
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

function workerRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const STRIPE_BILLING_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
]);

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stripeSubscriptionId(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  if (event.type.startsWith("customer.subscription.")) return stringField(object.id);
  const direct = stringField(object.subscription);
  if (direct) return direct;
  const parent = workerRecordValue(object.parent);
  return stringField(workerRecordValue(parent.subscription_details).subscription);
}

function stripePriceIds(object: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const container of [workerRecordValue(object.items), workerRecordValue(object.lines)]) {
    if (!Array.isArray(container.data)) continue;
    for (const entry of container.data) {
      const row = workerRecordValue(entry);
      const price = stringField(workerRecordValue(row.price).id)
        ?? stringField(workerRecordValue(workerRecordValue(row.pricing).price_details).price);
      if (price && !ids.includes(price)) ids.push(price);
    }
  }
  return ids;
}

interface CheckoutMapping {
  organizationId: string;
  planId: string;
  interval: "month" | "year";
  createdAt: string;
}

function configuredStripePlan(object: Record<string, unknown>, plans: StripePlan[], checkoutMapping?: CheckoutMapping | null): { plan?: StripePlan; interval?: "month" | "year" } {
  for (const priceId of stripePriceIds(object)) {
    const plan = plans.find((candidate) => candidate.monthlyPriceId === priceId || candidate.annualPriceId === priceId);
    if (plan) return { plan, interval: plan.annualPriceId === priceId ? "year" : "month" };
  }
  const plan = checkoutMapping ? plans.find((candidate) => candidate.id === checkoutMapping.planId) : undefined;
  return plan && checkoutMapping ? { plan, interval: checkoutMapping.interval } : {};
}

function stripeStatus(event: StripeWebhookEvent, existing?: TenantBillingAccount | null): string {
  if (event.type === "customer.subscription.deleted") return "canceled";
  if (event.type === "invoice.payment_failed") return "past_due";
  if (event.type === "invoice.payment_action_required" || event.type === "invoice.finalization_failed") return "payment_required";
  if (event.type === "invoice.paid") return "active";
  if (event.type === "customer.subscription.paused") return "paused";
  if (event.type === "customer.subscription.resumed") return stringField(event.data.object.status) ?? "active";
  if (event.type.startsWith("customer.subscription.")) return stringField(event.data.object.status) ?? "unknown";
  return existing?.status ?? "incomplete";
}

async function applyStripeEvent(event: StripeWebhookEvent, metadata: D1JsonMetadataStore, billing: D1BillingStore, tenants: D1TenantStore, plans: StripePlan[]): Promise<void> {
  if (!STRIPE_BILLING_EVENTS.has(event.type)) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, receivedAt: new Date().toISOString() });
    return;
  }
  const object = event.data.object;
  const objectMetadata = workerRecordValue(object.metadata);
  const subscriptionId = stripeSubscriptionId(event);
  const customerId = stringField(object.customer);
  const mapped = subscriptionId ? await billing.getBySubscription(subscriptionId) : customerId ? await billing.getByCustomer(customerId) : null;
  const checkoutId = event.type === "checkout.session.completed" ? stringField(object.id) : undefined;
  const checkoutMapping = checkoutId ? await metadata.get<CheckoutMapping>(`billing:checkout:${checkoutId}`) : null;
  const organizationId = mapped?.organizationId ?? checkoutMapping?.organizationId;
  if (!organizationId) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, reason: "organization_unresolved", receivedAt: new Date().toISOString() });
    return;
  }
  const claimedOrganizationId = stringField(objectMetadata.organization_id) ?? stringField(object.client_reference_id);
  if (claimedOrganizationId && claimedOrganizationId !== organizationId) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, reason: "organization_mismatch", receivedAt: new Date().toISOString(), organizationId });
    return;
  }
  const existing = mapped ?? await billing.getByOrganization(organizationId);
  const eventCreated = Number.isSafeInteger(event.created) && (event.created as number) >= 0 ? event.created as number : Math.floor(Date.now() / 1000);
  const updatedAt = new Date(eventCreated * 1000).toISOString();
  const configured = configuredStripePlan(object, plans, checkoutMapping);
  const plan = configured.plan;
  const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : existing?.currentPeriodEnd;
  const account: TenantBillingAccount = {
    organizationId,
    customerId: customerId ?? existing?.customerId,
    subscriptionId: subscriptionId ?? existing?.subscriptionId,
    planId: plan?.id ?? "free",
    interval: configured.interval ?? existing?.interval,
    status: stripeStatus(event, existing),
    cancelAtPeriodEnd: typeof object.cancel_at_period_end === "boolean" ? object.cancel_at_period_end : existing?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: periodEnd,
    lastEventId: event.id,
    lastEventCreatedAt: eventCreated,
    updatedAt,
  };
  const applied = await billing.upsert(account);
  if (applied) {
    await tenants.putEntitlements({ organizationId, planId: account.planId, billingStatus: account.status, privateRepositoryLimit: plan?.privateRepositoryLimit ?? 0, memberLimit: plan?.memberLimit ?? 0, retentionDays: plan?.retentionDays ?? 0, features: plan?.features ?? {}, updatedAt });
  }
  await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, stale: !applied, receivedAt: new Date().toISOString(), organizationId });
}

function workOSRoleToTenantRole(roleSlugs: readonly string[]): TenantRole {
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

async function applyWorkOSEvent(event: WorkOSWebhookEvent, tenants: D1TenantStore): Promise<void> {
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
  if (!event.event.startsWith("organization_membership.")) return;
  const membership = normalizeWorkOSMembership(data);
  if (!membership) return;
  await applyWorkOSMembership(membership, tenants, workOSStatusToMembershipStatus(membership.status, event.event === "organization_membership.deleted"), updatedAt);
}

async function applyWorkOSMembership(membership: NonNullable<ReturnType<typeof normalizeWorkOSMembership>>, tenants: D1TenantStore, status: TenantMembership["status"] = workOSStatusToMembershipStatus(membership.status, false), fallbackUpdatedAt = new Date().toISOString()): Promise<void> {
  const updatedAt = membership.updatedAt ?? fallbackUpdatedAt;
  await tenants.upsertOrganization({ organizationId: membership.organizationId, name: membership.organizationName ?? membership.organizationId, status: "active", updatedAt });
  if (membership.user) await tenants.upsertUser({ userId: membership.user.id, email: membership.user.email, firstName: membership.user.firstName, lastName: membership.user.lastName, emailVerified: membership.user.emailVerified, updatedAt });
  await tenants.upsertMembership({ organizationId: membership.organizationId, userId: membership.userId, role: workOSRoleToTenantRole(membership.roleSlugs), status, updatedAt });
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
          await applyWorkOSEvent(event, tenants);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...jsonHeaders, allow: "GET, POST, OPTIONS" } });
    const url = new URL(request.url);
    try {
      const config = await hostedProviderConfig(env);
      if (url.pathname === "/health" || url.pathname === "/config/status") {
        return json({ service: "tinkerbot-control-plane", environment: config.environment, providers: providerStatuses(config), resources: { d1: Boolean(env.DB), r2: Boolean(env.EVIDENCE_BUCKET), stripePlanCount: config.stripe.plans.length, workosEventSync: env.WORKOS_EVENTS_SYNC_ENABLED === "true" }, localVerification: "independent" });
      }
      if (url.pathname === "/auth/workos/start" && request.method === "GET") {
        const state = crypto.randomUUID();
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const location = provider.authorizationUrl({ redirectUri: safeRedirectUri(request, env), state });
        return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "set-cookie": `tinkerbot_oauth_state=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
      }
      if (url.pathname === "/auth/workos/callback" && request.method === "GET") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || !code || state !== cookieValue(request, "tinkerbot_oauth_state")) return json({ error: "Invalid or expired authentication state.", code: "invalid_oauth_state" }, 400);
        const store = sessionStore(env, config);
        if (!store) return json({ error: "WorkOS exchange is wired, but the D1 session store or session encryption secret is not configured yet.", code: "session_store_not_configured" }, 501);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const session = await provider.exchangeCode({ code, ipAddress: request.headers.get("cf-connecting-ip") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined });
        const sessionId = crypto.randomUUID();
        await store.put(sessionId, session);
        const tenants = env.DB ? new D1TenantStore(env.DB) : null;
        const access = tenants ? await authorizeTenantSession({ id: sessionId, session }, tenants) : null;
        return jsonWithCookies({ authenticated: true, ...publicSession(session), ...(access?.ok ? publicAccess(access) : { authorized: false }) }, 200, [clearCookie("tinkerbot_oauth_state"), sessionCookie(sessionId)]);
      }
      if (url.pathname === "/auth/session" && request.method === "GET") {
        const store = sessionStore(env, config);
        if (!store) return json({ error: "The D1 session store or session encryption secret is not configured yet.", code: "session_store_not_configured" }, 501);
        const currentDatabase = env.DB;
        if (!currentDatabase) return json({ error: "The D1 session store is not configured yet.", code: "session_store_not_configured" }, 501);
        let current = await currentSession(request, store);
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
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database));
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        return json(publicAccess(access));
      }
      if (url.pathname === "/assurance/summary" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "assurance:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        if (!featureEntitled(access, "assurance_metadata")) return json({ error: "The current server-side entitlement does not include hosted assurance metadata.", code: "entitlement_required", feature: "assurance_metadata" }, 403);
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
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "assurance:write");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        if (!featureEntitled(access, "assurance_metadata")) return json({ error: "The current server-side entitlement does not include hosted assurance metadata.", code: "entitlement_required", feature: "assurance_metadata" }, 403);
        const body = await jsonBody(request);
        const repository = assuranceRepository(body?.repository);
        if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
        const checked = validateHostedAssuranceBundle(body?.assurance ?? body?.bundle);
        if (!checked.ok) return json({ error: checked.error, code: "invalid_assurance_metadata" }, 400);
        const metadata = new D1JsonMetadataStore(database);
        const key = assuranceMetadataKey(access.membership.organizationId, repository);
        await metadata.put(key, { ...checked.value, repository, organizationId: access.membership.organizationId, ingestedAt: new Date().toISOString(), sourceUpload: "not_uploaded" });
        await metadata.put(`assurance:audit:${access.membership.organizationId}:${crypto.randomUUID()}`, { action: "assurance_ingest", repository, actorId: access.current.session.user.id, at: new Date().toISOString() });
        return json({ ingested: true, authorized: true, organizationId: access.membership.organizationId, repository, sourceUpload: "not_uploaded" });
      }
      if (url.pathname === "/assurance/delete" && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin assurance deletion rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "assurance:delete");
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
        const current = await currentSession(request, store);
        if (!current) return json({ error: "Authentication is required.", code: "not_authenticated" }, 401);
        if (!current.session.organizationId) return json({ error: "The authenticated user is not associated with an organization.", code: "organization_not_selected" }, 403);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey });
        const tenants = new D1TenantStore(database);
        const membership = await provider.getOrganizationMembership(current.session.user.id, current.session.organizationId);
        if (membership) {
          await applyWorkOSMembership(membership, tenants);
        } else {
          await tenants.upsertMembership({ organizationId: current.session.organizationId, userId: current.session.user.id, role: "viewer", status: "removed" });
        }
        const access = await authorizeTenantSession(current, tenants);
        if (!access.ok) return json({ synchronized: true, authorized: false, code: access.code }, access.status);
        return json({ synchronized: true, ...publicAccess(access) });
      }
      if (url.pathname === "/tenant/invitations" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Invitation management requires the D1 session store and session encryption secret.", code: "tenant_store_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "invitations:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const entitlement = entitledFailure(access, "team_invitations");
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
        const access = await authorizeTenantSession(await currentSession(request, store), tenants, "invitations:create");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const entitlement = entitledFailure(access, "team_invitations");
        if (entitlement) return entitlement;
        const body = await jsonBody(request, 20_000);
        const email = invitationEmail(body?.email);
        const role = body?.role === undefined ? "viewer" : invitationRole(body.role);
        if (!email || !role) return json({ error: "A valid email and an invite-safe role (viewer, reviewer, or maintainer) are required.", code: "invalid_invitation_request" }, 400);
        const organizationId = access.membership.organizationId;
        if (await tenants.getPendingInvitation(organizationId, email)) return json({ error: "A pending invitation already exists for this email address.", code: "invitation_already_pending" }, 409);
        const memberLimit = access.entitlements?.memberLimit ?? 0;
        const seatUsage = await tenants.countSeatUsage(organizationId);
        if (memberLimit <= 0 || seatUsage >= memberLimit) return json({ error: "The organization has reached its member entitlement.", code: "member_limit_reached", memberLimit, seatUsage }, 403);
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
      if (url.pathname === "/integrations/workos/webhook" && request.method === "POST") {
        if (!env.DB) return json({ error: "WorkOS webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
        const payload = await boundedRequestText(request, 2_000_000);
        const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey, webhookSecret: config.workos.webhookSecret });
        const ledger = new D1WebhookLedger(env.DB, "workos");
        const tenants = new D1TenantStore(env.DB);
        const result = await provider.handleWebhook(payload, request.headers.get("workos-signature"), ledger, (event) => applyWorkOSEvent(event, tenants));
        return json({ received: true, duplicate: result.duplicate });
      }
      if (url.pathname === "/billing/webhook" && request.method === "POST") {
        if (!env.DB) return json({ error: "Stripe webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
        const payload = await boundedRequestText(request, 2_000_000);
        const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret });
        const ledger = new D1WebhookLedger(env.DB);
        const metadata = new D1JsonMetadataStore(env.DB);
        const tenants = new D1TenantStore(env.DB);
        const result = await provider.handleWebhook(payload, request.headers.get("stripe-signature"), ledger, (event) => applyStripeEvent(event, metadata, new D1BillingStore(env.DB!), tenants, config.stripe.plans));
        return json({ received: true, duplicate: result.duplicate });
      }
      if (url.pathname === "/billing/summary" && request.method === "GET") {
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "billing:read");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const account = await new D1BillingStore(database).getByOrganization(access.membership.organizationId);
        return json({ authorized: true, organizationId: access.membership.organizationId, account, entitlements: access.entitlements, plans: config.stripe.plans.map(({ id, privateRepositoryLimit, memberLimit, retentionDays, features, annualPriceId }) => ({ id, privateRepositoryLimit, memberLimit, retentionDays, features: features ?? {}, annualBillingAvailable: Boolean(annualPriceId) })) });
      }
      if ((url.pathname === "/billing/checkout" || url.pathname === "/billing/portal" || url.pathname === "/billing/subscription/cancel" || url.pathname === "/billing/subscription/reactivate") && request.method === "POST") {
        if (!originAllowed(request, env)) return json({ error: "Cross-origin billing mutation rejected.", code: "csrf_origin_rejected" }, 403);
        const store = sessionStore(env, config);
        const database = env.DB;
        if (!store || !database) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
        const access = await authorizeTenantSession(await currentSession(request, store), new D1TenantStore(database), "billing:manage");
        if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
        const organizationId = access.membership.organizationId;
        const billing = new D1BillingStore(database);
        const billingState = await billing.getByOrganization(organizationId);
        const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, plans: config.stripe.plans });
        const body = await jsonBody(request);
        if (!body && url.pathname !== "/billing/portal" && url.pathname !== "/billing/subscription/cancel") return json({ error: "A JSON request body is required.", code: "invalid_request" }, 400);
        if (url.pathname === "/billing/checkout") {
          const planId = body && typeof body.planId === "string" ? body.planId : "";
          const interval = body?.interval === "year" ? "year" : body?.interval === "month" ? "month" : "";
          if (!planId || !interval) return json({ error: "planId and interval are required.", code: "invalid_billing_request" }, 400);
          if (billingState?.subscriptionId && !["canceled", "cancelled", "incomplete_expired"].includes(billingState.status)) return json({ error: "This organization already has a subscription. Manage it in the billing portal instead.", code: "subscription_already_exists" }, 409);
          const requestKey = request.headers.get("idempotency-key")?.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120) || crypto.randomUUID();
          const checkout = await provider.createCheckoutSession({ planId, interval, organizationId, successUrl: safeReturnUrl(body?.successUrl, request, env, "/app/settings/billing"), cancelUrl: safeReturnUrl(body?.cancelUrl, request, env, "/app/settings/billing"), customerId: billingState?.customerId, customerEmail: access.current.session.user.email, idempotencyKey: `checkout:${organizationId}:${planId}:${interval}:${requestKey}` });
          await new D1JsonMetadataStore(database).put(`billing:checkout:${checkout.id}`, { organizationId, planId, interval, createdAt: new Date().toISOString() } satisfies CheckoutMapping);
          return json({ checkout });
        }
        if (url.pathname === "/billing/portal") {
          if (!billingState?.customerId) return json({ error: "No billing customer is associated with this organization yet.", code: "billing_customer_missing" }, 409);
          const portal = await provider.createPortalSession({ customerId: billingState.customerId, returnUrl: safeReturnUrl(body?.returnUrl, request, env, "/app/settings/billing"), idempotencyKey: `portal:${organizationId}:${crypto.randomUUID()}` });
          return json({ portal });
        }
        if (!billingState?.subscriptionId) return json({ error: "No active subscription is associated with this organization.", code: "billing_subscription_missing" }, 409);
        const cancelAtPeriodEnd = url.pathname === "/billing/subscription/cancel";
        const subscription = await provider.setSubscriptionCancellation({ subscriptionId: billingState.subscriptionId, cancelAtPeriodEnd, idempotencyKey: `${cancelAtPeriodEnd ? "cancel" : "reactivate"}:${organizationId}:${billingState.subscriptionId}` });
        return json({ subscription });
      }
      return json({ error: "Not found", code: "not_found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "control_plane_request_failed", method: request.method, path: url.pathname, error: error instanceof Error ? error.name : "UnknownError", provider: error instanceof ProviderError ? error.provider : undefined, code: error instanceof ProviderError ? error.code : undefined }));
      return errorResponse(error);
    }
  },
  async scheduled(controller: { cron?: string }, env: Env): Promise<void> {
    if (env.WORKOS_EVENTS_SYNC_ENABLED !== "true") return;
    const result = await reconcileWorkOSEvents(env);
    console.log(JSON.stringify({ event: "workos_events_reconciled", cron: controller.cron, processed: result.processed, cursor: result.cursor ?? null }));
  },
};
