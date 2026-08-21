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

export interface StripeCatalogValidation {
  valid: boolean;
  plans: StripePlan[];
  errors: string[];
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
  /** Atomically claim a key when the backing store supports conditional insert. */
  putIfAbsent?<T>(key: string, value: T): Promise<boolean>;
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

export { ProviderError } from "./provider-core";
export { normalizeWorkOSInvitation, normalizeWorkOSMembership, verifyWorkOSSignature, WorkOSAuthProvider } from "./workos-provider";

export { StripeBillingProvider, verifyStripeSignature } from "./stripe-provider";

export async function readCloudflareSecret(env: CloudflareEnv, name: string): Promise<string | undefined> {
  const value = env[name] as CloudflareSecretBinding | string | undefined;
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object" && typeof value.get === "function") return await value.get();
  return undefined;
}

export async function hostedProviderConfig(env: CloudflareEnv): Promise<HostedProviderConfig> {
  const environment = env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging" ? env.ENVIRONMENT : "development";
  const catalog = validateStripePlans(env.STRIPE_PLANS_JSON, { requireAllPlans: environment === "production", requireAnnualPrices: environment === "production" });
  return {
    environment,
    workos: { clientId: await readCloudflareSecret(env, "WORKOS_CLIENT_ID"), apiKey: await readCloudflareSecret(env, "WORKOS_API_KEY"), webhookSecret: await readCloudflareSecret(env, "WORKOS_WEBHOOK_SECRET") },
    stripe: { secretKey: await readCloudflareSecret(env, "STRIPE_SECRET_KEY"), webhookSecret: await readCloudflareSecret(env, "STRIPE_WEBHOOK_SECRET"), plans: catalog.plans },
    cloudflare: { accountId: typeof env.CLOUDFLARE_ACCOUNT_ID === "string" ? env.CLOUDFLARE_ACCOUNT_ID : undefined, workerName: typeof env.WORKER_NAME === "string" ? env.WORKER_NAME : undefined },
    sessionEncryptionKey: await readCloudflareSecret(env, "SESSION_ENCRYPTION_KEY"),
  };
}

export function providerStatuses(config: HostedProviderConfig): ProviderStatus[] {
  const stripeCatalogReady = config.environment !== "production" || stripeCatalogComplete(config.stripe.plans);
  const stripePlansPresent = config.stripe.plans.length > 0;
  return [
    { provider: "workos", state: config.workos.clientId && config.workos.apiKey && config.workos.webhookSecret ? "configured" : "unavailable", missing: [!config.workos.clientId ? "WORKOS_CLIENT_ID" : "", !config.workos.apiKey ? "WORKOS_API_KEY" : "", !config.workos.webhookSecret ? "WORKOS_WEBHOOK_SECRET" : ""].filter(Boolean) },
    { provider: "stripe", state: config.stripe.secretKey && config.stripe.webhookSecret && stripePlansPresent && stripeCatalogReady ? "configured" : "unavailable", missing: [!config.stripe.secretKey ? "STRIPE_SECRET_KEY" : "", !config.stripe.webhookSecret ? "STRIPE_WEBHOOK_SECRET" : "", !stripePlansPresent || !stripeCatalogReady ? "STRIPE_PLANS_JSON" : ""].filter(Boolean) },
    { provider: "cloudflare", state: config.cloudflare.accountId && config.cloudflare.workerName ? "configured" : "unavailable", missing: [!config.cloudflare.accountId ? "CLOUDFLARE_ACCOUNT_ID" : "", !config.cloudflare.workerName ? "WORKER_NAME" : ""].filter(Boolean) },
  ];
}

export {
  D1BillingStore,
  D1JsonMetadataStore,
  D1TenantStore,
  D1AuthSessionStore,
  D1WebhookLedger,
  METADATA_SCHEMA,
} from "./d1-stores";
export type { D1DatabaseLike } from "./d1-stores";

export {
  FanoutEvidenceStore,
  HttpEvidenceReplica,
  R2JsonEvidenceStore,
  evidenceStoreFromEnv,
} from "./evidence-store";
export type { R2BucketLike, R2ObjectLike } from "./evidence-store";

export function validateStripePlans(value: unknown, options: { requireAllPlans?: boolean; requireAnnualPrices?: boolean } = {}): StripeCatalogValidation {
  const errors: string[] = [];
  if (typeof value !== "string" || !value.trim()) return { valid: false, plans: [], errors: ["STRIPE_PLANS_JSON is empty."] };
  if (value.length > 1_000_000) return { valid: false, plans: [], errors: ["STRIPE_PLANS_JSON exceeds the 1 MB configuration limit."] };
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return { valid: false, plans: [], errors: ["STRIPE_PLANS_JSON is not valid JSON."] }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { valid: false, plans: [], errors: ["STRIPE_PLANS_JSON must be a non-empty array."] };
  if (parsed.length > 32) return { valid: false, plans: [], errors: ["STRIPE_PLANS_JSON contains too many plan entries."] };
  const prohibited = ["memberLimit", "seatLimit", "privateRepositoryLimit", "repositoryLimit", "additionalRepositoryPrice", "perRepositoryPrice", "perRunPrice", "perTokenPrice", "factoryLimit"];
  const ids = new Set<string>();
  const prices = new Set<string>();
  const versions = new Set<string>();
  const allowedFields = new Set(["id", "monthlyPriceId", "annualPriceId", "catalogVersion"]);
  const plans: StripePlan[] = [];
  for (const [index, item] of parsed.entries()) {
    const context = `Stripe plan ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${context} must be an object.`); continue; }
    const plan = item as Record<string, unknown>;
    for (const field of Object.keys(plan)) if (!allowedFields.has(field)) errors.push(`${context} contains unsupported field '${field}'.`);
    const id = typeof plan.id === "string" ? plan.id.trim() : "";
    const monthly = typeof plan.monthlyPriceId === "string" ? plan.monthlyPriceId.trim() : "";
    const annual = plan.annualPriceId === undefined ? undefined : typeof plan.annualPriceId === "string" ? plan.annualPriceId.trim() : "";
    if (!["developer", "team", "business"].includes(id)) errors.push(`${context} has an unsupported id.`);
    if (!monthly || !/^price_[A-Za-z0-9]+$/.test(monthly) || monthly.includes("REPLACE")) errors.push(`${context} has an invalid monthlyPriceId.`);
    if (annual !== undefined && (!annual || !/^price_[A-Za-z0-9]+$/.test(annual) || annual.includes("REPLACE"))) errors.push(`${context} has an invalid annualPriceId.`);
    if (annual !== undefined && annual === monthly) errors.push(`${context} must use distinct monthlyPriceId and annualPriceId values.`);
    if (options.requireAnnualPrices && annual === undefined) errors.push(`${context} is missing annualPriceId.`);
    for (const field of prohibited) if (Object.prototype.hasOwnProperty.call(plan, field)) errors.push(`${context} must not include ${field}; the catalog is seat-only.`);
    const catalogVersion = plan.catalogVersion;
    if (catalogVersion !== undefined) {
      if (typeof catalogVersion !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(catalogVersion)) errors.push(`${context} has an invalid catalogVersion.`);
      else versions.add(catalogVersion);
    } else if (options.requireAllPlans) errors.push(`${context} is missing catalogVersion.`);
    if (!id || !monthly || !/^price_[A-Za-z0-9]+$/.test(monthly)) continue;
    if (ids.has(id)) errors.push(`Duplicate Stripe plan id '${id}'.`);
    if (prices.has(monthly)) errors.push(`Duplicate Stripe price id '${monthly}'.`);
    if (annual && prices.has(annual)) errors.push(`Duplicate Stripe price id '${annual}'.`);
    ids.add(id);
    prices.add(monthly);
    if (annual) prices.add(annual);
    plans.push({ id, monthlyPriceId: monthly, ...(annual ? { annualPriceId: annual } : {}), ...(typeof catalogVersion === "string" ? { catalogVersion } : {}) });
  }
  if (versions.size > 1) errors.push("All Stripe plans must use the same catalogVersion.");
  if (options.requireAllPlans) for (const id of ["developer", "team", "business"]) if (!plans.some((plan) => plan.id === id)) errors.push(`Stripe catalog is missing ${id}.`);
  return { valid: errors.length === 0, plans: errors.length === 0 ? plans : [], errors };
}

/** Strict production readiness check for the seat catalog. */
export function stripeCatalogComplete(plans: readonly StripePlan[]): boolean {
  if (plans.length !== 3) return false;
  const ids = new Set(plans.map((plan) => plan.id));
  const versions = new Set(plans.map((plan) => plan.catalogVersion).filter((version): version is string => Boolean(version)));
  return ids.size === 3 && ["developer", "team", "business"].every((id) => ids.has(id)) && plans.every((plan) => Boolean(plan.monthlyPriceId && plan.annualPriceId)) && versions.size === 1;
}

export function parseStripePlans(value: unknown): StripePlan[] {
  return validateStripePlans(value).plans;
}
