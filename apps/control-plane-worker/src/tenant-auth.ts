import {
  D1AuthSessionStore,
  D1DatabaseLike,
  D1TenantStore,
  HostedProviderConfig,
  HostedSession,
  TenantEntitlement,
  TenantInvitation,
  TenantMembership,
  TenantRole,
} from "../../../packages/hosted-integrations/src";

export interface TenantAuthEnv {
  DB?: D1DatabaseLike;
}

export function cookieValue(request: Request, name: string): string | undefined {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const prefix = `${name}=`;
  const value = cookies.find((item) => item.trim().startsWith(prefix))?.trim().slice(prefix.length);
  try { return value ? decodeURIComponent(value) : undefined; } catch { return undefined; }
}

export function expired(session: HostedSession): boolean {
  return Boolean(session.expiresAt && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) <= Date.now());
}

export function sessionCookie(sessionId: string): string {
  return `tinkerbot_session=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function publicSession(session: HostedSession): Record<string, unknown> {
  return { user: session.user, organizationId: session.organizationId, expiresAt: session.expiresAt, authenticationMethod: session.authenticationMethod };
}

export function sessionStore(env: TenantAuthEnv, config: HostedProviderConfig): D1AuthSessionStore | null {
  const keyReady = Boolean(config.sessionEncryptionKey) && (config.environment !== "production" || sessionSecretReady(config.sessionEncryptionKey));
  return env.DB && keyReady ? new D1AuthSessionStore(env.DB, config.sessionEncryptionKey!) : null;
}

async function currentServiceCredential(request: Request, env?: TenantAuthEnv): Promise<{ id: string; session: HostedSession } | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
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

export async function currentSession(request: Request, store: D1AuthSessionStore, env?: TenantAuthEnv): Promise<{ id: string; session: HostedSession } | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
  const id = bearer ?? cookieValue(request, "tinkerbot_session");
  if (!id) return null;
  const session = await store.get(id);
  if (session) return { id, session };
  return currentServiceCredential(request, env);
}

export interface AuthorizedSession {
  ok: true;
  current: { id: string; session: HostedSession };
  membership: TenantMembership;
  entitlements: TenantEntitlement | null;
}

export interface AuthorizationFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export const INVITATION_ROLES: TenantRole[] = ["maintainer", "reviewer", "viewer"];

export type TenantCapability = "tenant:read" | "tenant:admin" | "factory:write" | "work:operate" | "ops:read" | "billing:read" | "billing:manage" | "invitations:read" | "invitations:create" | "assurance:read" | "assurance:write" | "assurance:delete";

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

export async function authorizeTenantSession(current: { id: string; session: HostedSession } | null, tenants: D1TenantStore, requiredCapability?: TenantCapability): Promise<AuthorizedSession | AuthorizationFailure> {
  if (!current) return { ok: false, status: 401, code: "not_authenticated", error: "Authentication is required." };
  if (expired(current.session)) return { ok: false, status: 401, code: "session_expired", error: "The authenticated session has expired." };
  const organizationId = current.session.organizationId;
  if (!organizationId) return { ok: false, status: 403, code: "organization_not_selected", error: "The authenticated user is not associated with an organization." };
  const membership = await tenants.getMembership(current.session.user.id, organizationId);
  if (!membership || membership.status !== "active") return { ok: false, status: 403, code: "not_a_member", error: "The authenticated user is not an active member of this organization." };
  if (requiredCapability && !roleHasCapability(membership.role, requiredCapability)) return { ok: false, status: 403, code: "insufficient_role", error: "The authenticated user is not authorized for this action." };
  return { ok: true, current, membership, entitlements: await tenants.getEntitlements(organizationId) };
}

export function publicAccess(access: AuthorizedSession): Record<string, unknown> {
  return { authorized: true, organizationId: access.membership.organizationId, role: access.membership.role, entitlements: access.entitlements };
}

export function invitationRole(value: unknown): TenantRole | null {
  return typeof value === "string" && INVITATION_ROLES.includes(value as TenantRole) ? value as TenantRole : null;
}

export function invitationEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function publicInvitation(invitation: TenantInvitation): Record<string, unknown> {
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

function sessionSecretReady(value: string | undefined): boolean {
  return Boolean(value && new TextEncoder().encode(value).byteLength >= 32 && !/(?:replace|placeholder|change[_ -]?me)/i.test(value));
}
