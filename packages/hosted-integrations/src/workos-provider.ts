import type {
  AuthProvider,
  HostedSession,
  HostedUser,
  WebhookLedger,
  WorkOSConfig,
  WorkOSInvitation,
  WorkOSInvitationInput,
  WorkOSOrganizationMembership,
  WorkOSWebhookEvent,
} from "./index";
import { jsonRequest, ProviderError, recordValue, requiredSecret } from "./provider-core";

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
