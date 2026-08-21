import type {
  HostedSession,
  MembershipStatus,
  MetadataStore,
  SessionStore,
  TenantAccessStore,
  TenantBillingAccount,
  TenantEntitlement,
  TenantInvitation,
  TenantInvitationState,
  TenantMembership,
  TenantOrganization,
  TenantRole,
  TenantUser,
  WebhookLedger,
} from "./index";

export interface D1DatabaseLike {
  prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; all?<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
  batch?(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]>;
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

  async putIfAbsent<T>(key: string, value: T): Promise<boolean> {
    const result = await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_metadata (key, value, updated_at) VALUES (?1, ?2, ?3)").bind(key, JSON.stringify(value), new Date().toISOString()).run() as { meta?: { changes?: number } };
    // Cloudflare D1 exposes `meta.changes`. If an adapter cannot report it,
    // fail closed rather than pretending an atomic claim was acquired.
    return result.meta?.changes === 1;
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
