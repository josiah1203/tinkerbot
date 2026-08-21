import {
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  StripeBillingProvider,
  WorkOSAuthProvider,
  hostedProviderConfig,
  normalizeWorkOSInvitation,
  normalizeWorkOSMembership,
  type D1DatabaseLike,
  type TenantMembership,
  type WorkOSWebhookEvent,
} from "../../../packages/hosted-integrations/src";
import { entitlementDenied, entitlementsForOrganization, recordSeatTransition, syncStripeQuantity } from "./billing";

export interface WorkOSEnv extends Record<string, unknown> {
  DB?: D1DatabaseLike;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  WORKOS_EVENTS_RANGE_START?: string;
}

function workerRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function workOSRoleToTenantRole(roleSlugs: readonly string[]): "owner" | "admin" | "billing_administrator" | "maintainer" | "reviewer" | "viewer" {
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

export async function afterSeatChange(env: WorkOSEnv | undefined, tenants: D1TenantStore, organizationId: string, userId: string, transition: string): Promise<void> {
  if (!env?.DB) return;
  const quantityAfter = await tenants.countSeatUsage(organizationId);
  await recordSeatTransition(env.DB, { organizationId, userId, transition, quantityAfter });
  if (!env.STRIPE_SECRET_KEY) return;
  const provider = new StripeBillingProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
  await syncStripeQuantity({ database: env.DB, provider, organizationId });
}

export async function applyWorkOSEvent(event: WorkOSWebhookEvent, tenants: D1TenantStore, env?: WorkOSEnv): Promise<void> {
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

export async function applyWorkOSMembership(membership: NonNullable<ReturnType<typeof normalizeWorkOSMembership>>, tenants: D1TenantStore, status: TenantMembership["status"] = workOSStatusToMembershipStatus(membership.status, false), fallbackUpdatedAt = new Date().toISOString(), env?: WorkOSEnv): Promise<void> {
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

export async function reconcileWorkOSEvents(env: WorkOSEnv): Promise<{ processed: number; cursor?: string }> {
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
