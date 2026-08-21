import {
  D1JsonMetadataStore,
  D1TenantStore,
  HostedProviderConfig,
  TenantInvitation,
  WorkOSAuthProvider,
} from "../../../packages/hosted-integrations/src";
import { type EntitlementKey } from "../../../packages/control-plane/src";
import { D1FactoryStore } from "./factory-store";
import { afterSeatChange, applyWorkOSMembership } from "./workos-sync";
import {
  authorizeTenantSession,
  clearCookie,
  cookieValue,
  currentSession,
  expired,
  invitationEmail,
  invitationRole,
  publicAccess,
  publicInvitation,
  publicSession,
  sessionCookie,
  sessionStore,
  type AuthorizedSession,
} from "./tenant-auth";
import type { Env } from "./index";
import type { entitlementsForOrganization } from "./billing";

type CalculatedEntitlements = Awaited<ReturnType<typeof entitlementsForOrganization>>;

type Json = (value: unknown, status?: number, headers?: HeadersInit) => Response;
type JsonWithCookies = (value: unknown, status: number, cookies: string[]) => Response;
type JsonBody = (request: Request, maxBytes?: number) => Promise<Record<string, unknown> | null>;

export interface TenantRouteSupport {
  json: Json;
  jsonWithCookies: JsonWithCookies;
  jsonBody: JsonBody;
  originAllowed: (request: Request, env: Env) => boolean;
  pkceChallenge: (verifier: string) => Promise<string>;
  safeRedirectUri: (request: Request, env: Env) => string;
  calculatedAccess: (env: Env, access: AuthorizedSession) => Promise<CalculatedEntitlements>;
  entitledFailureFrom: (calculated: CalculatedEntitlements, feature: EntitlementKey, mutation?: boolean) => Response | null;
}

/**
 * Tenant and session routes are adapters around the auth/tenant stores. They
 * never advance Factory lifecycle state; Factory commands remain owned by the
 * graph command boundary in the runtime and D1 store.
 */
export async function handleTenantRoute(
  request: Request,
  env: Env,
  url: URL,
  config: HostedProviderConfig,
  support: TenantRouteSupport,
): Promise<Response | undefined> {
  const { json, jsonWithCookies, jsonBody, originAllowed, pkceChallenge, safeRedirectUri, calculatedAccess, entitledFailureFrom } = support;

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

  return undefined;
}
