export type ProviderName = "workos" | "stripe" | "cloudflare";
export type ProviderState = "configured" | "unavailable";

export interface ProviderStatus {
  provider: ProviderName;
  state: ProviderState;
  missing: string[];
}

export interface HostedUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified?: boolean;
}

export interface HostedSession {
  user: HostedUser;
  organizationId?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  authenticationMethod?: string;
}

export interface SessionStore {
  get(sessionId: string): Promise<HostedSession | null>;
  put(sessionId: string, session: HostedSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface AuthProvider {
  authorizationUrl(input: { redirectUri: string; state: string; connectionId?: string; codeChallenge?: string; nonce?: string }): string;
  exchangeCode(input: { code: string; codeVerifier?: string; ipAddress?: string; userAgent?: string }): Promise<HostedSession>;
  refreshSession(input: { refreshToken: string; organizationId?: string }): Promise<HostedSession>;
}

export interface WorkOSConfig {
  clientId?: string;
  apiKey?: string;
  webhookSecret?: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}

export interface WorkOSOrganizationMembership {
  id?: string;
  userId: string;
  organizationId: string;
  organizationName?: string;
  status: "active" | "inactive" | "pending";
  roleSlugs: string[];
  user?: HostedUser;
  updatedAt?: string;
}

export interface WorkOSWebhookEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  createdAt?: string;
  context?: Record<string, unknown>;
}

export interface WorkOSInvitation {
  id: string;
  email: string;
  organizationId?: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  roleSlug?: string;
  inviterUserId?: string;
  acceptedUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkOSInvitationInput {
  email: string;
  organizationId: string;
  roleSlug: string;
  inviterUserId?: string;
  expiresInDays?: number;
  locale?: string;
}

export interface StripePlan {
  id: string;
  monthlyPriceId: string;
  annualPriceId?: string;
  catalogVersion?: string;
}

export interface CheckoutSessionInput {
  planId: string;
  interval: "month" | "year";
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
  customerEmail?: string;
  seatQuantity?: number;
  trialPeriodDays?: number;
  idempotencyKey: string;
}

export interface BillingProvider {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url?: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ id: string; url?: string }>;
  setSubscriptionCancellation(input: { subscriptionId: string; cancelAtPeriodEnd: boolean; idempotencyKey: string }): Promise<{ id: string; status?: string; cancelAtPeriodEnd?: boolean }>;
}

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  apiBaseUrl?: string;
  plans?: StripePlan[];
  fetcher?: typeof fetch;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface WebhookLedger {
  has(eventId: string): Promise<boolean>;
  record(eventId: string): Promise<void>;
  claim?(eventId: string): Promise<boolean>;
  release?(eventId: string): Promise<void>;
}

export interface MetadataStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface EvidenceStore {
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
}

export type TenantRole = "owner" | "admin" | "maintainer" | "reviewer" | "viewer" | "billing_administrator";
export type MembershipStatus = "active" | "invited" | "suspended" | "removed";

export interface TenantMembership {
  organizationId: string;
  userId: string;
  role: TenantRole;
  status: MembershipStatus;
  identityType?: "human" | "bot" | "github_app" | "service" | "system";
  accessState?: "enabled" | "suspended" | "disabled";
  updatedAt?: string;
}

export interface TenantUser {
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  emailVerified?: boolean;
  updatedAt?: string;
}

export interface TenantOrganization {
  organizationId: string;
  name: string;
  status: "active" | "inactive";
  updatedAt?: string;
}

export interface TenantEntitlement {
  organizationId: string;
  planId: string;
  billingStatus: string;
  privateRepositoryLimit: number;
  memberLimit: number;
  retentionDays: number;
  features: Record<string, boolean>;
  updatedAt: string;
}

export interface TenantBillingAccount {
  organizationId: string;
  customerId?: string;
  subscriptionId?: string;
  planId: string;
  interval?: "month" | "year";
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: string;
  lastEventId?: string;
  lastEventCreatedAt: number;
  updatedAt: string;
}

export type TenantInvitationState = "pending" | "accepted" | "revoked" | "expired";

export interface TenantInvitation {
  invitationId: string;
  organizationId: string;
  email: string;
  role: TenantRole;
  state: TenantInvitationState;
  providerInvitationId?: string;
  inviterUserId?: string;
  acceptedUserId?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantAccessStore {
  getMembership(userId: string, organizationId: string): Promise<TenantMembership | null>;
  getEntitlements(organizationId: string): Promise<TenantEntitlement | null>;
  putEntitlements(entitlement: TenantEntitlement): Promise<void>;
  upsertOrganization(organization: TenantOrganization): Promise<void>;
  upsertUser(user: TenantUser): Promise<void>;
  upsertMembership(membership: TenantMembership): Promise<void>;
}

export interface CloudflareSecretBinding {
  get(): Promise<string | undefined> | string | undefined;
}

export interface CloudflareEnv {
  [key: string]: unknown;
}

export interface HostedProviderConfig {
  environment: "development" | "staging" | "production";
  workos: { clientId?: string; apiKey?: string; webhookSecret?: string };
  stripe: { secretKey?: string; webhookSecret?: string; plans: StripePlan[] };
  cloudflare: { accountId?: string; workerName?: string };
  sessionEncryptionKey?: string;
}

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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredSecret(value: string | undefined, name: string, provider: ProviderName): string {
  if (!value) throw new ProviderError(provider, `${name} is not configured.`, { code: "provider_not_configured" });
  return value;
}

async function jsonRequest(provider: ProviderName, fetcher: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
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

function normalizeWorkOSSession(payload: Record<string, unknown>): HostedSession {
  const user = recordValue(payload.user);
  const id = typeof user.id === "string" ? user.id : "";
  const email = typeof user.email === "string" ? user.email : "";
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  if (!id || !email || !accessToken || !refreshToken) throw new ProviderError("workos", "WorkOS returned an incomplete session.", { code: "provider_invalid_response" });
  const rawExpiresAt = payload.expires_at;
  const expiresAt = typeof rawExpiresAt === "string"
    ? rawExpiresAt
    : typeof rawExpiresAt === "number"
      ? new Date(rawExpiresAt < 2_000_000_000 ? rawExpiresAt * 1000 : rawExpiresAt).toISOString()
      : typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : undefined;
  return {
    user: {
      id,
      email,
      firstName: typeof user.first_name === "string" ? user.first_name : undefined,
      lastName: typeof user.last_name === "string" ? user.last_name : undefined,
      emailVerified: typeof user.email_verified === "boolean" ? user.email_verified : undefined,
    },
    organizationId: typeof payload.organization_id === "string" ? payload.organization_id : undefined,
    accessToken,
    refreshToken,
    expiresAt,
    authenticationMethod: typeof payload.authentication_method === "string" ? payload.authentication_method : undefined,
  };
}

export function normalizeWorkOSMembership(value: unknown): WorkOSOrganizationMembership | null {
  const raw = recordValue(value);
  const user = recordValue(raw.user);
  const userId = typeof raw.user_id === "string" ? raw.user_id : typeof user.id === "string" ? user.id : "";
  const organizationId = typeof raw.organization_id === "string" ? raw.organization_id : "";
  const status = raw.status === "active" || raw.status === "inactive" || raw.status === "pending" ? raw.status : null;
  if (!userId || !organizationId || !status) return null;
  const roleSlugs: string[] = [];
  const primaryRole = recordValue(raw.role).slug;
  if (typeof primaryRole === "string") roleSlugs.push(primaryRole);
  if (Array.isArray(raw.roles)) {
    for (const item of raw.roles) {
      const slug = recordValue(item).slug;
      if (typeof slug === "string" && !roleSlugs.includes(slug)) roleSlugs.push(slug);
    }
  }
  const email = typeof user.email === "string" ? user.email : undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    userId,
    organizationId,
    organizationName: typeof raw.organization_name === "string" ? raw.organization_name : undefined,
    status,
    roleSlugs,
    user: email ? {
      id: userId,
      email,
      firstName: typeof user.first_name === "string" ? user.first_name : undefined,
      lastName: typeof user.last_name === "string" ? user.last_name : undefined,
      emailVerified: typeof user.email_verified === "boolean" ? user.email_verified : undefined,
    } : undefined,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
  };
}

function normalizeWorkOSEvent(value: unknown): WorkOSWebhookEvent | null {
  const raw = recordValue(value);
  if (typeof raw.id !== "string" || typeof raw.event !== "string") return null;
  return { id: raw.id, event: raw.event, data: recordValue(raw.data), createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined, context: recordValue(raw.context) };
}

export function normalizeWorkOSInvitation(value: unknown): WorkOSInvitation | null {
  const raw = recordValue(value);
  if (typeof raw.id !== "string" || typeof raw.email !== "string") return null;
  const state = raw.state === "pending" || raw.state === "accepted" || raw.state === "revoked" || raw.state === "expired" ? raw.state : null;
  if (!state) return null;
  return {
    id: raw.id,
    email: raw.email,
    organizationId: typeof raw.organization_id === "string" ? raw.organization_id : undefined,
    state,
    roleSlug: typeof raw.role_slug === "string" ? raw.role_slug : undefined,
    inviterUserId: typeof raw.inviter_user_id === "string" ? raw.inviter_user_id : undefined,
    acceptedUserId: typeof raw.accepted_user_id === "string" ? raw.accepted_user_id : undefined,
    acceptedAt: typeof raw.accepted_at === "string" ? raw.accepted_at : undefined,
    revokedAt: typeof raw.revoked_at === "string" ? raw.revoked_at : undefined,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : undefined,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
  };
}

export class WorkOSAuthProvider implements AuthProvider {
  private readonly clientId: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(config: WorkOSConfig) {
    this.clientId = config.clientId;
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.workos.com").replace(/\/$/, "");
    this.fetcher = config.fetcher ?? fetch;
  }

  authorizationUrl(input: { redirectUri: string; state: string; connectionId?: string; codeChallenge?: string; nonce?: string }): string {
    const clientId = requiredSecret(this.clientId, "WORKOS_CLIENT_ID", "workos");
    const url = new URL("/user_management/authorize", this.apiBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    if (input.connectionId) url.searchParams.set("connection_id", input.connectionId);
    if (input.codeChallenge) {
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    if (input.nonce) url.searchParams.set("nonce", input.nonce);
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier?: string; ipAddress?: string; userAgent?: string }): Promise<HostedSession> {
    const clientId = requiredSecret(this.clientId, "WORKOS_CLIENT_ID", "workos");
    const apiKey = requiredSecret(this.apiKey, "WORKOS_API_KEY", "workos");
    const body: Record<string, string> = { client_id: clientId, client_secret: apiKey, grant_type: "authorization_code", code: input.code };
    if (input.codeVerifier) body.code_verifier = input.codeVerifier;
    if (input.ipAddress) body.ip_address = input.ipAddress;
    if (input.userAgent) body.user_agent = input.userAgent;
    const payload = await jsonRequest("workos", this.fetcher, `${this.apiBaseUrl}/user_management/authenticate`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    return normalizeWorkOSSession(payload);
  }

  async listOrganizationMemberships(input: { userId: string; organizationId?: string }): Promise<WorkOSOrganizationMembership[]> {
    const apiKey = requiredSecret(this.apiKey, "WORKOS_API_KEY", "workos");
    if (!input.userId) throw new ProviderError("workos", "A WorkOS user id is required to list memberships.", { code: "invalid_request" });
    const memberships: WorkOSOrganizationMembership[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("/user_management/organization_memberships", this.apiBaseUrl);
      url.searchParams.set("user_id", input.userId);
      if (input.organizationId) url.searchParams.set("organization_id", input.organizationId);
      for (const status of ["active", "inactive", "pending"]) url.searchParams.append("statuses[]", status);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const payload = await jsonRequest("workos", this.fetcher, url.toString(), { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } });
      if (Array.isArray(payload.data)) {
        for (const item of payload.data) {
          const membership = normalizeWorkOSMembership(item);
          if (membership) memberships.push(membership);
        }
      }
      const listMetadata = recordValue(payload.list_metadata);
      const nextAfter = typeof listMetadata.after === "string" ? listMetadata.after : undefined;
      if (!nextAfter || nextAfter === after) break;
      after = nextAfter;
    }
    return memberships;
  }

  async listEvents(input: { after?: string; limit?: number; eventTypes?: string[]; rangeStart?: string; organizationId?: string } = {}): Promise<{ events: WorkOSWebhookEvent[]; after?: string }> {
    const apiKey = requiredSecret(this.apiKey, "WORKOS_API_KEY", "workos");
    const url = new URL("/events", this.apiBaseUrl);
    const requestedLimit = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 100;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    url.searchParams.set("limit", String(limit));
    if (input.after) url.searchParams.set("after", input.after);
    if (input.rangeStart) url.searchParams.set("range_start", input.rangeStart);
    if (input.organizationId) url.searchParams.set("organization_id", input.organizationId);
    for (const eventType of input.eventTypes ?? []) if (eventType.trim()) url.searchParams.append("events[]", eventType);
    const payload = await jsonRequest("workos", this.fetcher, url.toString(), { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } });
    if (!Array.isArray(payload.data)) throw new ProviderError("workos", "WorkOS returned an invalid events response.", { code: "provider_invalid_response" });
    const events: WorkOSWebhookEvent[] = [];
    for (const item of payload.data) {
      const event = normalizeWorkOSEvent(item);
      if (!event) throw new ProviderError("workos", "WorkOS returned an invalid event record.", { code: "provider_invalid_response" });
      events.push(event);
    }
    const listMetadata = recordValue(payload.list_metadata);
    return { events, after: typeof listMetadata.after === "string" ? listMetadata.after : undefined };
  }

  async createInvitation(input: WorkOSInvitationInput): Promise<WorkOSInvitation> {
    const apiKey = requiredSecret(this.apiKey, "WORKOS_API_KEY", "workos");
    const body: Record<string, unknown> = {
      email: input.email,
      organization_id: input.organizationId,
      role_slug: input.roleSlug,
      ...(input.inviterUserId ? { inviter_user_id: input.inviterUserId } : {}),
      ...(input.expiresInDays !== undefined ? { expires_in_days: input.expiresInDays } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    };
    const payload = await jsonRequest("workos", this.fetcher, `${this.apiBaseUrl}/user_management/invitations`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const invitation = normalizeWorkOSInvitation(payload);
    if (!invitation) throw new ProviderError("workos", "WorkOS returned an incomplete invitation.", { code: "provider_invalid_response" });
    return invitation;
  }

  async getOrganizationMembership(userId: string, organizationId: string): Promise<WorkOSOrganizationMembership | null> {
    const memberships = await this.listOrganizationMemberships({ userId, organizationId });
    return memberships.find((membership) => membership.organizationId === organizationId) ?? null;
  }

  async refreshSession(input: { refreshToken: string; organizationId?: string }): Promise<HostedSession> {
    const clientId = requiredSecret(this.clientId, "WORKOS_CLIENT_ID", "workos");
    const apiKey = requiredSecret(this.apiKey, "WORKOS_API_KEY", "workos");
    const body: Record<string, string> = { client_id: clientId, client_secret: apiKey, grant_type: "refresh_token", refresh_token: input.refreshToken };
    if (input.organizationId) body.organization_id = input.organizationId;
    const payload = await jsonRequest("workos", this.fetcher, `${this.apiBaseUrl}/user_management/authenticate`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    return normalizeWorkOSSession(payload);
  }

  async handleWebhook(payload: string, signatureHeader: string | null | undefined, ledger: WebhookLedger, onEvent: (event: WorkOSWebhookEvent) => Promise<void>, options: { nowMilliseconds?: number; toleranceSeconds?: number } = {}): Promise<{ duplicate: boolean; event: WorkOSWebhookEvent }> {
    const secret = requiredSecret(this.webhookSecret, "WORKOS_WEBHOOK_SECRET", "workos");
    if (!await verifyWorkOSSignature(payload, signatureHeader, secret, options.toleranceSeconds ?? 300, options.nowMilliseconds)) throw new ProviderError("workos", "WorkOS webhook signature verification failed.", { code: "invalid_webhook_signature" });
    let event: WorkOSWebhookEvent;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const normalized = normalizeWorkOSEvent(parsed);
      if (!normalized) throw new Error("invalid event");
      event = normalized;
    } catch {
      throw new ProviderError("workos", "WorkOS webhook payload is invalid.", { code: "invalid_webhook_payload" });
    }
    const claimed = Boolean(ledger.claim);
    if (ledger.claim) {
      if (!await ledger.claim(event.id)) return { duplicate: true, event };
    } else if (await ledger.has(event.id)) {
      return { duplicate: true, event };
    }
    try {
      await onEvent(event);
      await ledger.record(event.id);
    } catch (error) {
      if (claimed && ledger.release) await ledger.release(event.id);
      throw error;
    }
    return { duplicate: false, event };
  }
}

function formEntries(value: unknown, prefix: string, entries: Array<[string, string]>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEntries(item, `${prefix}[${index}]`, entries));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) formEntries(item, `${prefix}[${key}]`, entries);
    return;
  }
  if (value !== undefined && value !== null) entries.push([prefix, typeof value === "boolean" ? (value ? "true" : "false") : String(value)]);
}

function toFormBody(value: Record<string, unknown>): string {
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) formEntries(item, key, entries);
  return new URLSearchParams(entries).toString();
}

function basicAuth(value: string): string {
  return `Basic ${btoa(`${value}:`)}`;
}

export async function verifyStripeSignature(payload: string, signatureHeader: string | null | undefined, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const values = new Map<string, string[]>();
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key && value) values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get("t")?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = `${timestamp}.${payload}`;
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expected)));
  const expectedHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (values.get("v1") ?? []).some((candidate) => candidate.length === expectedHex.length && [...candidate].reduce((different, character, index) => different | (character.charCodeAt(0) ^ expectedHex.charCodeAt(index)), 0) === 0);
}

export async function verifyWorkOSSignature(payload: string, signatureHeader: string | null | undefined, secret: string, toleranceSeconds = 300, nowMilliseconds = Date.now()): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const values = new Map<string, string[]>();
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key && value) values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get("t")?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowMilliseconds - timestamp) > toleranceSeconds * 1000) return false;
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  const expectedHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (values.get("v1") ?? []).some((candidate) => candidate.length === expectedHex.length && [...candidate].reduce((different, character, index) => different | (character.charCodeAt(0) ^ expectedHex.charCodeAt(index)), 0) === 0);
}

export class StripeBillingProvider implements BillingProvider {
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly plans: Map<string, StripePlan>;
  private readonly fetcher: typeof fetch;

  constructor(config: StripeConfig) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
    this.plans = new Map((config.plans ?? []).map((plan) => [plan.id, plan]));
    this.fetcher = config.fetcher ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const secretKey = requiredSecret(this.secretKey, "STRIPE_SECRET_KEY", "stripe");
    return jsonRequest("stripe", this.fetcher, `${this.apiBaseUrl}${path}`, { method: "POST", headers: { accept: "application/json", authorization: basicAuth(secretKey), "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: toFormBody(body) });
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url?: string }> {
    const plan = this.plans.get(input.planId);
    if (!plan) throw new ProviderError("stripe", `Billing plan ${input.planId} is not configured on the server.`, { code: "plan_not_configured" });
    const price = input.interval === "year" ? plan.annualPriceId : plan.monthlyPriceId;
    if (!price) throw new ProviderError("stripe", `Billing interval ${input.interval} is not configured for plan ${input.planId}.`, { code: "price_not_configured" });
    const subscriptionData: Record<string, unknown> = { metadata: { organization_id: input.organizationId, plan_id: plan.id, billing_interval: input.interval } };
    if (input.trialPeriodDays && input.trialPeriodDays > 0) subscriptionData.trial_period_days = input.trialPeriodDays;
    const payload = await this.post("/v1/checkout/sessions", { mode: "subscription", success_url: input.successUrl, cancel_url: input.cancelUrl, client_reference_id: input.organizationId, customer: input.customerId, customer_email: input.customerEmail, "line_items": [{ price, quantity: Math.max(0, Math.floor(input.seatQuantity ?? 0)) }], "subscription_data": subscriptionData, metadata: { organization_id: input.organizationId, plan_id: plan.id } }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete checkout session.", { code: "provider_invalid_response" });
    return { id: payload.id, url: typeof payload.url === "string" ? payload.url : undefined };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ id: string; url?: string }> {
    const payload = await this.post("/v1/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete billing portal session.", { code: "provider_invalid_response" });
    return { id: payload.id, url: typeof payload.url === "string" ? payload.url : undefined };
  }

  async setSubscriptionCancellation(input: { subscriptionId: string; cancelAtPeriodEnd: boolean; idempotencyKey: string }): Promise<{ id: string; status?: string; cancelAtPeriodEnd?: boolean }> {
    const payload = await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, { cancel_at_period_end: input.cancelAtPeriodEnd }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription.", { code: "provider_invalid_response" });
    return { id: payload.id, status: typeof payload.status === "string" ? payload.status : undefined, cancelAtPeriodEnd: typeof payload.cancel_at_period_end === "boolean" ? payload.cancel_at_period_end : undefined };
  }

  async retrieveSubscription(subscriptionId: string): Promise<Record<string, unknown>> {
    const secretKey = requiredSecret(this.secretKey, "STRIPE_SECRET_KEY", "stripe");
    return jsonRequest("stripe", this.fetcher, `${this.apiBaseUrl}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET", headers: { accept: "application/json", authorization: basicAuth(secretKey) } });
  }

  async updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number; idempotencyKey: string }): Promise<{ id: string; quantity?: number }> {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    const items = recordValue(subscription.items);
    const data = Array.isArray(items.data) ? items.data : [];
    const first = data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : undefined;
    const itemId = typeof first?.id === "string" ? first.id : undefined;
    if (!itemId) throw new ProviderError("stripe", "Stripe subscription has no billable item to update.", { code: "subscription_item_missing" });
    const payload = await this.post(`/v1/subscription_items/${encodeURIComponent(itemId)}`, { quantity: Math.max(0, Math.floor(input.quantity)), proration_behavior: "create_prorations" }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription item.", { code: "provider_invalid_response" });
    return { id: payload.id, quantity: typeof payload.quantity === "number" ? payload.quantity : undefined };
  }

  async changeSubscriptionPrice(input: { subscriptionId: string; priceId: string; quantity: number; prorationBehavior: "create_prorations" | "none"; idempotencyKey: string }): Promise<{ id: string; status?: string }> {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    const items = recordValue(subscription.items);
    const data = Array.isArray(items.data) ? items.data : [];
    const first = data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : undefined;
    const itemId = typeof first?.id === "string" ? first.id : undefined;
    if (!itemId) throw new ProviderError("stripe", "Stripe subscription has no billable item to update.", { code: "subscription_item_missing" });
    const payload = await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
      items: [{ id: itemId, price: input.priceId, quantity: Math.max(0, Math.floor(input.quantity)) }],
      proration_behavior: input.prorationBehavior,
      cancel_at_period_end: false,
    }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription.", { code: "provider_invalid_response" });
    return { id: payload.id, status: typeof payload.status === "string" ? payload.status : undefined };
  }

  async handleWebhook(payload: string, signatureHeader: string | null | undefined, ledger: WebhookLedger, onEvent: (event: StripeWebhookEvent) => Promise<void>, options: { nowSeconds?: number; toleranceSeconds?: number } = {}): Promise<{ duplicate: boolean; event: StripeWebhookEvent }> {
    const secret = requiredSecret(this.webhookSecret, "STRIPE_WEBHOOK_SECRET", "stripe");
    if (!await verifyStripeSignature(payload, signatureHeader, secret, options.toleranceSeconds ?? 300, options.nowSeconds)) throw new ProviderError("stripe", "Stripe webhook signature verification failed.", { code: "invalid_webhook_signature" });
    let event: StripeWebhookEvent;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const data = recordValue(parsed.data);
      const object = recordValue(data.object);
      if (typeof parsed.id !== "string" || typeof parsed.type !== "string") throw new Error("invalid event");
      event = { id: parsed.id, type: parsed.type, created: typeof parsed.created === "number" ? parsed.created : undefined, data: { object } };
    } catch {
      throw new ProviderError("stripe", "Stripe webhook payload is invalid.", { code: "invalid_webhook_payload" });
    }
    const claimed = Boolean(ledger.claim);
    if (ledger.claim) {
      if (!await ledger.claim(event.id)) return { duplicate: true, event };
    } else if (await ledger.has(event.id)) {
      return { duplicate: true, event };
    }
    try {
      await onEvent(event);
      await ledger.record(event.id);
    } catch (error) {
      if (claimed && ledger.release) await ledger.release(event.id);
      throw error;
    }
    return { duplicate: false, event };
  }
}

export async function readCloudflareSecret(env: CloudflareEnv, name: string): Promise<string | undefined> {
  const value = env[name] as CloudflareSecretBinding | string | undefined;
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object" && typeof value.get === "function") return await value.get();
  return undefined;
}

export async function hostedProviderConfig(env: CloudflareEnv): Promise<HostedProviderConfig> {
  return {
    environment: env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging" ? env.ENVIRONMENT : "development",
    workos: { clientId: await readCloudflareSecret(env, "WORKOS_CLIENT_ID"), apiKey: await readCloudflareSecret(env, "WORKOS_API_KEY"), webhookSecret: await readCloudflareSecret(env, "WORKOS_WEBHOOK_SECRET") },
    stripe: { secretKey: await readCloudflareSecret(env, "STRIPE_SECRET_KEY"), webhookSecret: await readCloudflareSecret(env, "STRIPE_WEBHOOK_SECRET"), plans: parseStripePlans(env.STRIPE_PLANS_JSON) },
    cloudflare: { accountId: typeof env.CLOUDFLARE_ACCOUNT_ID === "string" ? env.CLOUDFLARE_ACCOUNT_ID : undefined, workerName: typeof env.WORKER_NAME === "string" ? env.WORKER_NAME : undefined },
    sessionEncryptionKey: await readCloudflareSecret(env, "SESSION_ENCRYPTION_KEY"),
  };
}

export function providerStatuses(config: HostedProviderConfig): ProviderStatus[] {
  return [
    { provider: "workos", state: config.workos.clientId && config.workos.apiKey && config.workos.webhookSecret ? "configured" : "unavailable", missing: [!config.workos.clientId ? "WORKOS_CLIENT_ID" : "", !config.workos.apiKey ? "WORKOS_API_KEY" : "", !config.workos.webhookSecret ? "WORKOS_WEBHOOK_SECRET" : ""].filter(Boolean) },
    { provider: "stripe", state: config.stripe.secretKey && config.stripe.webhookSecret && config.stripe.plans.length > 0 ? "configured" : "unavailable", missing: [!config.stripe.secretKey ? "STRIPE_SECRET_KEY" : "", !config.stripe.webhookSecret ? "STRIPE_WEBHOOK_SECRET" : "", config.stripe.plans.length === 0 ? "STRIPE_PLANS_JSON" : ""].filter(Boolean) },
    { provider: "cloudflare", state: config.cloudflare.accountId && config.cloudflare.workerName ? "configured" : "unavailable", missing: [!config.cloudflare.accountId ? "CLOUDFLARE_ACCOUNT_ID" : "", !config.cloudflare.workerName ? "WORKER_NAME" : ""].filter(Boolean) },
  ];
}

export interface D1DatabaseLike {
  prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; all?<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
}

export const METADATA_SCHEMA = "CREATE TABLE IF NOT EXISTS tinkerbot_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);";

export class D1JsonMetadataStore implements MetadataStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.database.prepare("SELECT value FROM tinkerbot_metadata WHERE key = ?1").bind(key).first<{ value: string }>();
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_metadata (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, JSON.stringify(value), new Date().toISOString()).run();
  }

  async delete(key: string): Promise<void> {
    await this.database.prepare("DELETE FROM tinkerbot_metadata WHERE key = ?1").bind(key).run();
  }
}

const TENANT_ROLES: TenantRole[] = ["owner", "admin", "maintainer", "reviewer", "viewer", "billing_administrator"];
const MEMBERSHIP_STATUSES: MembershipStatus[] = ["active", "invited", "suspended", "removed"];

function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && TENANT_ROLES.includes(value as TenantRole);
}

function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" && MEMBERSHIP_STATUSES.includes(value as MembershipStatus);
}

interface D1MembershipRow {
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  updated_at?: string | null;
}

interface D1EntitlementRow {
  organization_id: string;
  plan_id: string;
  billing_status: string;
  private_repository_limit: number;
  member_limit: number;
  retention_days: number;
  features_json: string;
  updated_at: string;
}

interface D1BillingRow {
  organization_id: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  plan_id: string;
  billing_interval?: string | null;
  subscription_status: string;
  cancel_at_period_end: number;
  current_period_end?: string | null;
  last_event_id?: string | null;
  last_event_created_at: number;
  updated_at: string;
}

function normalizeBillingAccount(row: D1BillingRow | null): TenantBillingAccount | null {
  if (!row) return null;
  const interval = row.billing_interval === "month" || row.billing_interval === "year" ? row.billing_interval : undefined;
  return {
    organizationId: row.organization_id,
    customerId: row.stripe_customer_id ?? undefined,
    subscriptionId: row.stripe_subscription_id ?? undefined,
    planId: row.plan_id,
    interval,
    status: row.subscription_status,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    currentPeriodEnd: row.current_period_end ?? undefined,
    lastEventId: row.last_event_id ?? undefined,
    lastEventCreatedAt: row.last_event_created_at,
    updatedAt: row.updated_at,
  };
}

export class D1BillingStore {
  constructor(private readonly database: D1DatabaseLike) {}

  private async find(column: "organization_id" | "stripe_customer_id" | "stripe_subscription_id", value: string): Promise<TenantBillingAccount | null> {
    const row = await this.database.prepare(`SELECT organization_id, stripe_customer_id, stripe_subscription_id, plan_id, billing_interval, subscription_status, cancel_at_period_end, current_period_end, last_event_id, last_event_created_at, updated_at FROM tinkerbot_billing_accounts WHERE ${column} = ?1`).bind(value).first<D1BillingRow>();
    return normalizeBillingAccount(row);
  }

  getByOrganization(organizationId: string): Promise<TenantBillingAccount | null> { return this.find("organization_id", organizationId); }
  getByCustomer(customerId: string): Promise<TenantBillingAccount | null> { return this.find("stripe_customer_id", customerId); }
  getBySubscription(subscriptionId: string): Promise<TenantBillingAccount | null> { return this.find("stripe_subscription_id", subscriptionId); }

  async upsert(account: TenantBillingAccount): Promise<boolean> {
    const result = await this.database.prepare("INSERT INTO tinkerbot_billing_accounts (organization_id, stripe_customer_id, stripe_subscription_id, plan_id, billing_interval, subscription_status, cancel_at_period_end, current_period_end, last_event_id, last_event_created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(organization_id) DO UPDATE SET stripe_customer_id = COALESCE(excluded.stripe_customer_id, tinkerbot_billing_accounts.stripe_customer_id), stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, tinkerbot_billing_accounts.stripe_subscription_id), plan_id = excluded.plan_id, billing_interval = COALESCE(excluded.billing_interval, tinkerbot_billing_accounts.billing_interval), subscription_status = excluded.subscription_status, cancel_at_period_end = excluded.cancel_at_period_end, current_period_end = excluded.current_period_end, last_event_id = excluded.last_event_id, last_event_created_at = excluded.last_event_created_at, updated_at = excluded.updated_at WHERE excluded.last_event_created_at >= tinkerbot_billing_accounts.last_event_created_at").bind(account.organizationId, account.customerId ?? null, account.subscriptionId ?? null, account.planId, account.interval ?? null, account.status, account.cancelAtPeriodEnd ? 1 : 0, account.currentPeriodEnd ?? null, account.lastEventId ?? null, account.lastEventCreatedAt, account.updatedAt).run();
    const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes;
    return changes === undefined || changes > 0;
  }
}

interface D1InvitationRow {
  invitation_id: string;
  organization_id: string;
  email: string;
  role: string;
  state: string;
  provider_invitation_id?: string | null;
  inviter_user_id?: string | null;
  accepted_user_id?: string | null;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export class D1TenantStore implements TenantAccessStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async getMembership(userId: string, organizationId: string): Promise<TenantMembership | null> {
    const row = await this.database.prepare("SELECT m.organization_id, m.user_id, m.role, m.status, m.updated_at FROM tinkerbot_memberships m INNER JOIN tinkerbot_organizations o ON o.organization_id = m.organization_id AND o.status = 'active' WHERE m.organization_id = ?1 AND m.user_id = ?2").bind(organizationId, userId).first<D1MembershipRow>();
    if (!row || !isTenantRole(row.role) || !isMembershipStatus(row.status)) return null;
    return { organizationId: row.organization_id, userId: row.user_id, role: row.role, status: row.status, ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}) };
  }

  async listActiveMemberships(userId: string): Promise<TenantMembership[]> {
    const statement = this.database.prepare("SELECT m.organization_id, m.user_id, m.role, m.status, m.updated_at FROM tinkerbot_memberships m INNER JOIN tinkerbot_organizations o ON o.organization_id = m.organization_id AND o.status = 'active' WHERE m.user_id = ?1 AND m.status = 'active' ORDER BY m.updated_at DESC").bind(userId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<D1MembershipRow>();
    return (result.results ?? []).flatMap((row) => !isTenantRole(row.role) || !isMembershipStatus(row.status) ? [] : [{ organizationId: row.organization_id, userId: row.user_id, role: row.role, status: row.status, ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}) }]);
  }

  async getEntitlements(organizationId: string): Promise<TenantEntitlement | null> {
    const row = await this.database.prepare("SELECT organization_id, plan_id, billing_status, private_repository_limit, member_limit, retention_days, features_json, updated_at FROM tinkerbot_entitlements WHERE organization_id = ?1").bind(organizationId).first<D1EntitlementRow>();
    if (!row) return null;
    let features: Record<string, boolean> = {};
    try {
      const parsed = JSON.parse(row.features_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "boolean") features[key] = value;
      }
    } catch {
      features = {};
    }
    return { organizationId: row.organization_id, planId: row.plan_id, billingStatus: row.billing_status, privateRepositoryLimit: row.private_repository_limit, memberLimit: row.member_limit, retentionDays: row.retention_days, features, updatedAt: row.updated_at };
  }

  async putEntitlements(entitlement: TenantEntitlement): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_entitlements (organization_id, plan_id, billing_status, private_repository_limit, member_limit, retention_days, features_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(organization_id) DO UPDATE SET plan_id = excluded.plan_id, billing_status = excluded.billing_status, private_repository_limit = excluded.private_repository_limit, member_limit = excluded.member_limit, retention_days = excluded.retention_days, features_json = excluded.features_json, updated_at = excluded.updated_at WHERE excluded.updated_at >= tinkerbot_entitlements.updated_at").bind(entitlement.organizationId, entitlement.planId, entitlement.billingStatus, entitlement.privateRepositoryLimit, entitlement.memberLimit, entitlement.retentionDays, JSON.stringify(entitlement.features), entitlement.updatedAt).run();
  }

  async countSeatUsage(organizationId: string): Promise<number> {
    const row = await this.database.prepare("SELECT COUNT(*) AS count FROM tinkerbot_memberships WHERE organization_id = ?1 AND status = 'active' AND COALESCE(identity_type, 'human') = 'human' AND COALESCE(access_state, 'enabled') = 'enabled'").bind(organizationId).first<{ count?: number | string }>();
    const count = typeof row?.count === "number" ? row.count : Number(row?.count);
    return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
  }

  async getPendingInvitation(organizationId: string, email: string): Promise<TenantInvitation | null> {
    const row = await this.database.prepare("SELECT invitation_id, organization_id, email, role, state, provider_invitation_id, inviter_user_id, accepted_user_id, expires_at, created_at, updated_at FROM tinkerbot_invitations WHERE organization_id = ?1 AND lower(email) = lower(?2) AND state = 'pending' ORDER BY created_at DESC LIMIT 1").bind(organizationId, email).first<D1InvitationRow>();
    return row ? this.normalizeInvitation(row) : null;
  }

  async listInvitations(organizationId: string): Promise<TenantInvitation[]> {
    const statement = this.database.prepare("SELECT invitation_id, organization_id, email, role, state, provider_invitation_id, inviter_user_id, accepted_user_id, expires_at, created_at, updated_at FROM tinkerbot_invitations WHERE organization_id = ?1 ORDER BY created_at DESC LIMIT 100").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<D1InvitationRow>();
    return (result.results ?? []).map((row) => this.normalizeInvitation(row));
  }

  async upsertInvitation(invitation: TenantInvitation): Promise<void> {
    await this.database.prepare("INSERT INTO tinkerbot_invitations (invitation_id, organization_id, email, role, state, provider_invitation_id, inviter_user_id, accepted_user_id, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(invitation_id) DO UPDATE SET organization_id = excluded.organization_id, email = excluded.email, role = excluded.role, state = excluded.state, provider_invitation_id = excluded.provider_invitation_id, inviter_user_id = excluded.inviter_user_id, accepted_user_id = excluded.accepted_user_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at WHERE excluded.updated_at >= tinkerbot_invitations.updated_at").bind(invitation.invitationId, invitation.organizationId, invitation.email, invitation.role, invitation.state, invitation.providerInvitationId ?? null, invitation.inviterUserId ?? null, invitation.acceptedUserId ?? null, invitation.expiresAt ?? null, invitation.createdAt, invitation.updatedAt).run();
  }

  private normalizeInvitation(row: D1InvitationRow): TenantInvitation {
    const role = isTenantRole(row.role) ? row.role : "viewer";
    const state: TenantInvitationState = row.state === "accepted" || row.state === "revoked" || row.state === "expired" ? row.state : "pending";
    return {
      invitationId: row.invitation_id,
      organizationId: row.organization_id,
      email: row.email,
      role,
      state,
      ...(row.provider_invitation_id ? { providerInvitationId: row.provider_invitation_id } : {}),
      ...(row.inviter_user_id ? { inviterUserId: row.inviter_user_id } : {}),
      ...(row.accepted_user_id ? { acceptedUserId: row.accepted_user_id } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async upsertOrganization(organization: TenantOrganization): Promise<void> {
    const updatedAt = organization.updatedAt ?? new Date().toISOString();
    const name = organization.name.trim() || organization.organizationId;
    await this.database.prepare("INSERT INTO tinkerbot_organizations (organization_id, name, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(organization_id) DO UPDATE SET name = CASE WHEN excluded.name = excluded.organization_id THEN tinkerbot_organizations.name ELSE excluded.name END, status = excluded.status, updated_at = excluded.updated_at WHERE excluded.updated_at >= tinkerbot_organizations.updated_at").bind(organization.organizationId, name, organization.status, updatedAt, updatedAt).run();
  }

  async upsertUser(user: TenantUser): Promise<void> {
    const updatedAt = user.updatedAt ?? new Date().toISOString();
    await this.database.prepare("INSERT INTO tinkerbot_users (user_id, email, first_name, last_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name, updated_at = excluded.updated_at WHERE excluded.updated_at >= tinkerbot_users.updated_at").bind(user.userId, user.email, user.firstName ?? null, user.lastName ?? null, updatedAt, updatedAt).run();
  }

  async upsertMembership(membership: TenantMembership): Promise<void> {
    if (!isTenantRole(membership.role) || !isMembershipStatus(membership.status)) throw new Error("Invalid tenant membership state.");
    const updatedAt = membership.updatedAt ?? new Date().toISOString();
    const identityType = membership.identityType ?? "human";
    const accessState = membership.accessState ?? (membership.status === "active" ? "enabled" : "disabled");
    await this.database.prepare("INSERT INTO tinkerbot_memberships (organization_id, user_id, role, status, identity_type, access_state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status, identity_type = excluded.identity_type, access_state = excluded.access_state, updated_at = excluded.updated_at WHERE excluded.updated_at >= tinkerbot_memberships.updated_at").bind(membership.organizationId, membership.userId, membership.role, membership.status, identityType, accessState, updatedAt, updatedAt).run();
  }
}

interface D1SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  email_verified?: number | null;
  organization_id?: string | null;
  expires_at?: string | null;
  authentication_method?: string | null;
  token_ciphertext: string;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionCipherKey(secret: string): Promise<CryptoKey> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return globalThis.crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealSessionTokens(tokens: { accessToken: string; refreshToken: string }, secret: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionCipherKey(secret);
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(tokens)));
  return `${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

async function openSessionTokens(value: string, secret: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const [encodedIv, encodedCiphertext] = value.split(".", 2);
    if (!encodedIv || !encodedCiphertext) return null;
    const key = await sessionCipherKey(secret);
    const plaintext = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Decode(encodedIv) as unknown as BufferSource }, key, base64Decode(encodedCiphertext) as unknown as BufferSource);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

export class D1AuthSessionStore implements SessionStore {
  constructor(private readonly database: D1DatabaseLike, private readonly encryptionKey: string) {}

  async get(sessionId: string): Promise<HostedSession | null> {
    const row = await this.database.prepare("SELECT session_id, user_id, email, first_name, last_name, email_verified, organization_id, expires_at, authentication_method, token_ciphertext FROM tinkerbot_sessions WHERE session_id = ?1").bind(sessionId).first<D1SessionRow>();
    if (!row) return null;
    const tokens = await openSessionTokens(row.token_ciphertext, this.encryptionKey);
    if (!tokens) return null;
    return {
      user: {
        id: row.user_id,
        email: row.email,
        firstName: row.first_name ?? undefined,
        lastName: row.last_name ?? undefined,
        emailVerified: row.email_verified === null || row.email_verified === undefined ? undefined : row.email_verified === 1,
      },
      organizationId: row.organization_id ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      authenticationMethod: row.authentication_method ?? undefined,
      ...tokens,
    };
  }

  async put(sessionId: string, session: HostedSession): Promise<void> {
    const tokenCiphertext = await sealSessionTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken }, this.encryptionKey);
    await this.database.prepare("INSERT INTO tinkerbot_sessions (session_id, user_id, email, first_name, last_name, email_verified, organization_id, expires_at, authentication_method, token_ciphertext, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11) ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name, email_verified = excluded.email_verified, organization_id = excluded.organization_id, expires_at = excluded.expires_at, authentication_method = excluded.authentication_method, token_ciphertext = excluded.token_ciphertext, updated_at = excluded.updated_at").bind(sessionId, session.user.id, session.user.email, session.user.firstName ?? null, session.user.lastName ?? null, session.user.emailVerified === undefined ? null : session.user.emailVerified ? 1 : 0, session.organizationId ?? null, session.expiresAt ?? null, session.authenticationMethod ?? null, tokenCiphertext, new Date().toISOString()).run();
  }

  async delete(sessionId: string): Promise<void> {
    await this.database.prepare("DELETE FROM tinkerbot_sessions WHERE session_id = ?1").bind(sessionId).run();
  }
}

export class D1WebhookLedger implements WebhookLedger {
  constructor(private readonly database: D1DatabaseLike, private readonly provider = "stripe") {}

  async has(eventId: string): Promise<boolean> {
    const row = await this.database.prepare("SELECT event_id FROM tinkerbot_webhook_events WHERE event_id = ?1 AND provider = ?2").bind(eventId, this.provider).first<{ event_id: string }>();
    return Boolean(row);
  }

  async claim(eventId: string): Promise<boolean> {
    const result = await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_webhook_events (provider, event_id, status, received_at) VALUES (?2, ?1, 'processing', ?3)").bind(eventId, this.provider, new Date().toISOString()).run();
    const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes;
    if (changes !== undefined) return changes > 0;
    return changes === undefined ? false : changes > 0;
  }

  async record(eventId: string): Promise<void> {
    await this.database.prepare("UPDATE tinkerbot_webhook_events SET status = 'processed', processed_at = ?3 WHERE event_id = ?1 AND provider = ?2").bind(eventId, this.provider, new Date().toISOString()).run();
  }

  async release(eventId: string): Promise<void> {
    await this.database.prepare("DELETE FROM tinkerbot_webhook_events WHERE event_id = ?1 AND provider = ?2 AND status = 'processing'").bind(eventId, this.provider).run();
  }
}

export interface R2ObjectLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export class R2JsonEvidenceStore implements EvidenceStore {
  constructor(private readonly bucket: R2BucketLike, private readonly prefix = "evidence/") {}

  async put(key: string, value: unknown): Promise<void> {
    await this.bucket.put(`${this.prefix}${key}`, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
  }

  async get<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(`${this.prefix}${key}`);
    if (!object) return null;
    try { return JSON.parse(await object.text()) as T; } catch { return null; }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(`${this.prefix}${key}`);
  }
}

/** Optional customer S3/GCS-compatible HTTP replica. Failures never change a tb check verdict. */
export class HttpEvidenceReplica implements EvidenceStore {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, value: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`Evidence export HTTP ${response.status}`);
  }

  async get<T>(): Promise<T | null> {
    return null;
  }

  async delete(): Promise<void> {
    return;
  }
}

export class FanoutEvidenceStore implements EvidenceStore {
  constructor(private readonly primary: EvidenceStore, private readonly replica?: EvidenceStore) {}

  async put(key: string, value: unknown): Promise<void> {
    await this.primary.put(key, value);
    if (!this.replica) return;
    try { await this.replica.put(key, value); } catch { /* replica fan-out cannot set or rewrite a verification verdict */ }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.primary.get<T>(key);
  }

  async delete(key: string): Promise<void> {
    await this.primary.delete(key);
  }
}

export function evidenceStoreFromEnv(input: { bucket?: R2BucketLike; exportEndpoint?: string; exportToken?: string; fetchImpl?: typeof fetch }): EvidenceStore | undefined {
  if (!input.bucket) return undefined;
  const primary = new R2JsonEvidenceStore(input.bucket);
  const replica = input.exportEndpoint ? new HttpEvidenceReplica(input.exportEndpoint, input.exportToken, input.fetchImpl) : undefined;
  return new FanoutEvidenceStore(primary, replica);
}

export function parseStripePlans(value: unknown): StripePlan[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const prohibited = ["memberLimit", "seatLimit", "privateRepositoryLimit", "repositoryLimit", "additionalRepositoryPrice", "perRepositoryPrice", "perRunPrice", "perTokenPrice", "factoryLimit"];
    const plans = parsed.filter((item): item is StripePlan => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const plan = item as Record<string, unknown>;
      if (prohibited.some((field) => Object.prototype.hasOwnProperty.call(plan, field))) return false;
      if (typeof plan.id !== "string" || !plan.id.trim() || typeof plan.monthlyPriceId !== "string" || !plan.monthlyPriceId.trim() || (plan.annualPriceId !== undefined && (typeof plan.annualPriceId !== "string" || !plan.annualPriceId.trim()))) return false;
      if (!["developer", "team", "business"].includes(plan.id)) return false;
      return true;
    });
    const ids = new Set<string>();
    const prices = new Set<string>();
    return plans.filter((plan) => {
      if (ids.has(plan.id) || prices.has(plan.monthlyPriceId) || (plan.annualPriceId && prices.has(plan.annualPriceId))) return false;
      ids.add(plan.id);
      prices.add(plan.monthlyPriceId);
      if (plan.annualPriceId) prices.add(plan.annualPriceId);
      return true;
    });
  } catch {
    return [];
  }
}
