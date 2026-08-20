export const BILLING_CATALOG_VERSION = "2026-08-18.seat-v1";

export type PlanId = "free" | "developer" | "team" | "business" | "enterprise";
export type BillingInterval = "month" | "year" | "custom";
export type BillingStatus =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "incomplete"
  | "unpaid"
  | "paused"
  | "canceled_at_period_end"
  | "canceled"
  | "deleted"
  | "unknown"
  | "expired"
  | "payment_required"
  | "enterprise_inquiry"
  | "billing_unavailable";

export type TrialState = "eligible" | "trialing" | "trial_expiring" | "converted" | "expired" | "canceled" | "blocked";
export type IdentityType = "human" | "bot" | "github_app" | "service" | "system";
export type AccessState = "enabled" | "suspended" | "disabled";
export type AiCostClass = "economy" | "standard" | "premium" | "steward";
export type EntitlementAvailability = "included" | "limited" | "unavailable" | "custom";

export const ENTITLEMENT_KEYS = [
  "hosted_account",
  "public_repository_connection",
  "private_repository_connection",
  "verification",
  "receipts",
  "markdown_receipts",
  "basic_work_orders",
  "full_factory_pipeline",
  "basic_history",
  "shared_policies",
  "shared_baselines",
  "change_contracts",
  "repository_assurance",
  "reviewer_calibration",
  "standard_roles",
  "advanced_rbac",
  "custom_roles",
  "change_sets",
  "release_assessments",
  "audit_history",
  "audit_export",
  "hosted_api",
  "service_credentials",
  "sso",
  "scim",
  "advanced_github_governance",
  "custom_factory_skills",
  "factory_improvement",
  "priority_queue",
  "premium_escalation",
  "external_notifications",
  "private_execution",
  "custom_retention",
  "assurance_metadata",
  "team_invitations",
  "local_execution",
  "byok_inference",
  "portable_eval_suites",
  "offline_assurance",
  "cloud_sync",
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const PAID_CAP_FIELDS = [
  "memberLimit",
  "seatLimit",
  "privateRepositoryLimit",
  "repositoryLimit",
  "additionalRepositoryPrice",
  "perRepositoryPrice",
  "perRunPrice",
  "perTokenPrice",
  "factoryLimit",
] as const;

export const BILLING_POLICY = {
  catalogVersion: BILLING_CATALOG_VERSION,
  currency: "USD" as const,
  trialDays: 14,
  graceDays: 7,
  free: {
    historyRetentionDays: 14,
    requestRatePerMinute: 30,
    concurrency: 1,
    storageBytes: 50_000_000,
    publicRepositoryAllowance: 3,
  },
  developer: { historyRetentionDays: 90, boundedPremiumEscalationsPerDay: 3 },
  team: { historyRetentionDays: 365, improvementProposalsPerMonth: 4 },
  business: { historyRetentionDays: 730 },
} as const;

const TEAM_PLUS: PlanId[] = ["team", "business", "enterprise"];
const PAID: PlanId[] = ["developer", "team", "business", "enterprise"];
const BUSINESS_PLUS: PlanId[] = ["business", "enterprise"];

function availabilityFor(planId: PlanId, key: EntitlementKey): EntitlementAvailability {
  if (key === "hosted_account" || key === "public_repository_connection" || key === "verification" || key === "receipts" || key === "markdown_receipts" || key === "basic_work_orders" || key === "basic_history" || key === "assurance_metadata") {
    return planId === "free" ? "limited" : planId === "enterprise" ? "custom" : "included";
  }
  if (key === "private_repository_connection" || key === "full_factory_pipeline" || key === "change_contracts") {
    return planId === "free" ? "unavailable" : planId === "enterprise" ? "custom" : "included";
  }
  if (key === "shared_policies" || key === "shared_baselines" || key === "repository_assurance" || key === "reviewer_calibration" || key === "standard_roles" || key === "team_invitations" || key === "advanced_github_governance" || key === "custom_factory_skills" || key === "priority_queue") {
    if (planId === "free" || planId === "developer") return key === "standard_roles" ? "limited" : "unavailable";
    return planId === "enterprise" ? "custom" : "included";
  }
  if (key === "factory_improvement") {
    if (planId === "team") return "limited";
    if (BUSINESS_PLUS.includes(planId)) return planId === "enterprise" ? "custom" : "included";
    return "unavailable";
  }
  if (key === "premium_escalation") {
    if (planId === "developer") return "limited";
    if (TEAM_PLUS.includes(planId)) return planId === "enterprise" ? "custom" : "included";
    return "unavailable";
  }
  if (key === "audit_history") {
    if (planId === "free" || planId === "developer") return "limited";
    return planId === "enterprise" ? "custom" : "included";
  }
  if (key === "advanced_rbac" || key === "custom_roles" || key === "change_sets" || key === "release_assessments" || key === "audit_export" || key === "hosted_api" || key === "service_credentials" || key === "sso" || key === "scim" || key === "external_notifications") {
    return planId === "enterprise" ? "custom" : BUSINESS_PLUS.includes(planId) ? "included" : "unavailable";
  }
  if (key === "local_execution" || key === "byok_inference" || key === "portable_eval_suites" || key === "offline_assurance" || key === "cloud_sync") {
    return planId === "enterprise" ? "custom" : "included";
  }
  if (key === "private_execution" || key === "custom_retention") return planId === "enterprise" ? "custom" : "unavailable";
  return PAID.includes(planId) ? "included" : "unavailable";
}

export function publicCapabilities(planId: PlanId): Record<EntitlementKey, EntitlementAvailability> {
  return Object.fromEntries(ENTITLEMENT_KEYS.map((key) => [key, availabilityFor(planId, key)])) as Record<EntitlementKey, EntitlementAvailability>;
}

export interface Plan {
  id: PlanId;
  displayName: string;
  price: { amountCents: number | null; currency: "USD"; interval: BillingInterval };
  annualPriceCents?: number;
  billingUnit: "active_seat" | "organization" | "custom";
  historyRetention: string;
  policyFeatures: string[];
  teamFeatures: string[];
  auditFeatures: string[];
  supportLevel: "community" | "standard" | "priority" | "enterprise";
  selfHostedAvailable: boolean;
  paidSeatCap: "none" | "n/a" | "contract";
  paidRepositoryCap: "none" | "n/a" | "contract";
}

export const PLAN_CATALOG: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    displayName: "Free",
    price: { amountCents: 0, currency: "USD", interval: "month" },
    billingUnit: "organization",
    historyRetention: "14 days hosted",
    policyFeatures: ["Default advisory policy"],
    teamFeatures: ["Public repositories", "Basic work-order intake"],
    auditFeatures: ["Limited history"],
    supportLevel: "community",
    // Self-hosted workers are a portable execution boundary; they do not imply
    // dedicated hosted control-plane infrastructure (which remains private_execution).
    selfHostedAvailable: true,
    paidSeatCap: "n/a",
    paidRepositoryCap: "n/a",
  },
  developer: {
    id: "developer",
    displayName: "Developer",
    price: { amountCents: 2000, currency: "USD", interval: "month" },
    annualPriceCents: 20000,
    billingUnit: "active_seat",
    historyRetention: "90 days",
    policyFeatures: ["Change contracts", "Hosted history"],
    teamFeatures: ["Private repositories", "Full factory pipeline", "Per active human seat", "No seat or repository cap"],
    auditFeatures: ["90-day audit log"],
    supportLevel: "standard",
    selfHostedAvailable: true,
    paidSeatCap: "none",
    paidRepositoryCap: "none",
  },
  team: {
    id: "team",
    displayName: "Team",
    price: { amountCents: 4000, currency: "USD", interval: "month" },
    annualPriceCents: 40000,
    billingUnit: "active_seat",
    historyRetention: "1 year",
    policyFeatures: ["Shared policies", "Shared baselines and waivers", "Repository assurance"],
    teamFeatures: ["Standard organization roles", "Shared factory skills", "Priority queue", "Per active human seat", "No seat or repository cap"],
    auditFeatures: ["1-year audit log"],
    supportLevel: "priority",
    selfHostedAvailable: true,
    paidSeatCap: "none",
    paidRepositoryCap: "none",
  },
  business: {
    id: "business",
    displayName: "Business",
    price: { amountCents: 6000, currency: "USD", interval: "month" },
    annualPriceCents: 60000,
    billingUnit: "active_seat",
    historyRetention: "2 years",
    policyFeatures: ["Advanced RBAC", "Custom roles", "Release assessments"],
    teamFeatures: ["SSO", "SCIM", "Hosted API", "Change Sets", "External notifications", "Per active human seat", "No seat or repository cap"],
    auditFeatures: ["2-year audit log", "Audit export"],
    supportLevel: "priority",
    selfHostedAvailable: true,
    paidSeatCap: "none",
    paidRepositoryCap: "none",
  },
  enterprise: {
    id: "enterprise",
    displayName: "Enterprise",
    price: { amountCents: null, currency: "USD", interval: "custom" },
    billingUnit: "custom",
    historyRetention: "Contract-defined",
    policyFeatures: ["Signed entitlement grants"],
    teamFeatures: ["Contract-defined seats and execution"],
    auditFeatures: ["Contract-defined retention and residency"],
    supportLevel: "enterprise",
    selfHostedAvailable: true,
    paidSeatCap: "contract",
    paidRepositoryCap: "contract",
  },
};

export function getPlan(planId: PlanId): Plan {
  const plan = PLAN_CATALOG[planId];
  if (!plan) throw new Error(`Unknown plan: ${String(planId)}`);
  return plan;
}

export function isPlanId(value: unknown): value is PlanId {
  return value === "free" || value === "developer" || value === "team" || value === "business" || value === "enterprise";
}

export function publicBillingCatalog(): Array<{
  id: PlanId;
  displayName: string;
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  currency: "USD";
  billingUnit: Plan["billingUnit"];
  trialAvailable: boolean;
  paidSeatCap: Plan["paidSeatCap"];
  paidRepositoryCap: Plan["paidRepositoryCap"];
  capabilities: Record<EntitlementKey, EntitlementAvailability>;
}> {
  return (Object.keys(PLAN_CATALOG) as PlanId[]).map((id) => {
    const plan = PLAN_CATALOG[id];
    return {
      id,
      displayName: plan.displayName,
      monthlyPriceCents: plan.price.amountCents,
      annualPriceCents: plan.annualPriceCents ?? null,
      currency: "USD",
      billingUnit: plan.billingUnit,
      trialAvailable: id === "team",
      paidSeatCap: plan.paidSeatCap,
      paidRepositoryCap: plan.paidRepositoryCap,
      capabilities: publicCapabilities(id),
    };
  });
}

export interface EnterpriseGrant {
  key: EntitlementKey;
  expiresAt?: string;
}

export interface EntitlementInput {
  organizationId?: string;
  planId?: string | null;
  billingStatus?: string | null;
  trialState?: TrialState | null;
  trialEndsAt?: string | null;
  enterpriseGrants?: EnterpriseGrant[];
  now?: string;
  catalogVersion?: string;
}

export interface CalculatedEntitlements {
  catalogVersion: string;
  planId: PlanId;
  billingStatus: BillingStatus;
  features: Record<EntitlementKey, boolean>;
  limited: Partial<Record<EntitlementKey, boolean>>;
  historicalReadsAllowed: boolean;
  paidMutationsAllowed: boolean;
  newSeatsAllowed: boolean;
  premiumWorkflowsAllowed: boolean;
  aiClass: AiCostClass;
  trialState?: TrialState;
  trialEndsAt?: string;
  graceUntil?: string;
  values: typeof BILLING_POLICY.free | typeof BILLING_POLICY.developer | typeof BILLING_POLICY.team | typeof BILLING_POLICY.business;
}

const PAID_LIKE: BillingStatus[] = ["active", "trialing", "grace", "canceled_at_period_end", "past_due"];

export function normalizeBillingStatus(value: string | null | undefined): BillingStatus {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "paid") return "active";
  if (status === "cancelled") return "canceled";
  if (status === "inactive" || status === "") return "free";
  if (([
    "free", "trialing", "active", "past_due", "grace", "incomplete", "unpaid", "paused",
    "canceled_at_period_end", "canceled", "deleted", "unknown", "expired", "payment_required",
    "enterprise_inquiry", "billing_unavailable",
  ] as BillingStatus[]).includes(status as BillingStatus)) return status as BillingStatus;
  return "unknown";
}

export function effectivePlanId(input: EntitlementInput): PlanId {
  const trial = input.trialState;
  if (trial === "trialing" || trial === "trial_expiring") return "team";
  const status = normalizeBillingStatus(input.billingStatus);
  if (status === "trialing") return "team";
  if (status === "free" || status === "canceled" || status === "deleted" || status === "expired") return "free";
  if (isPlanId(input.planId)) return input.planId;
  return "free";
}

function grantActive(grant: EnterpriseGrant, now: string): boolean {
  return !grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(now);
}

export function calculateEntitlements(input: EntitlementInput): CalculatedEntitlements {
  const now = input.now ?? new Date().toISOString();
  let billingStatus = normalizeBillingStatus(input.billingStatus);
  if (input.trialState === "trialing" || input.trialState === "trial_expiring") billingStatus = "trialing";
  if (input.trialState === "expired" && (billingStatus === "trialing" || billingStatus === "free")) billingStatus = "free";
  const planId = effectivePlanId({ ...input, billingStatus });
  const features = {} as Record<EntitlementKey, boolean>;
  const limited: Partial<Record<EntitlementKey, boolean>> = {};
  for (const key of ENTITLEMENT_KEYS) {
    const availability = availabilityFor(planId, key);
    features[key] = availability === "included" || availability === "limited" || availability === "custom";
    if (availability === "limited") limited[key] = true;
  }
  for (const grant of input.enterpriseGrants ?? []) {
    if (grantActive(grant, now) && ENTITLEMENT_KEYS.includes(grant.key)) features[grant.key] = true;
  }
  const unknown = billingStatus === "unknown" || billingStatus === "billing_unavailable";
  const historicalReadsAllowed = billingStatus !== "deleted";
  const paidMutationsAllowed = !unknown && PAID_LIKE.includes(billingStatus) && billingStatus !== "past_due";
  const inGrace = billingStatus === "grace" || billingStatus === "past_due";
  const newSeatsAllowed = paidMutationsAllowed && !inGrace;
  const premiumWorkflowsAllowed = paidMutationsAllowed && features.premium_escalation && !inGrace;
  const aiClass: AiCostClass = planId === "free" ? "economy" : planId === "developer" ? "standard" : planId === "team" ? "standard" : "premium";
  const values = planId === "developer" ? BILLING_POLICY.developer : planId === "team" ? BILLING_POLICY.team : planId === "business" ? BILLING_POLICY.business : BILLING_POLICY.free;
  return {
    catalogVersion: input.catalogVersion ?? BILLING_CATALOG_VERSION,
    planId,
    billingStatus,
    features,
    limited,
    historicalReadsAllowed,
    paidMutationsAllowed,
    newSeatsAllowed,
    premiumWorkflowsAllowed,
    aiClass,
    trialState: input.trialState ?? undefined,
    trialEndsAt: input.trialEndsAt ?? undefined,
    values,
  };
}

export function hasEntitlement(calculated: CalculatedEntitlements, key: EntitlementKey, options: { mutation?: boolean } = {}): boolean {
  if (options.mutation && !calculated.paidMutationsAllowed && key !== "hosted_account" && key !== "basic_history" && key !== "verification" && key !== "receipts" && key !== "assurance_metadata") return false;
  return calculated.features[key] === true;
}

export function canConnectPrivateRepository(input: EntitlementInput | { planId: PlanId; billingStatus: BillingStatus; activePrivateRepositories?: number; memberCount?: number }): boolean {
  const calculated = calculateEntitlements(input);
  if (calculated.billingStatus === "past_due" || calculated.billingStatus === "payment_required" || calculated.billingStatus === "expired" || calculated.billingStatus === "unpaid") return false;
  return hasEntitlement(calculated, "private_repository_connection");
}

export function modelForCostClass(aiClass: AiCostClass, agentId: string): string {
  if (aiClass === "economy" || agentId === "triage") return "@cf/zhipuai/glm-4.7-flash";
  if (aiClass === "steward") return "@cf/qwen/qwen2.5-coder-32b-instruct";
  if (aiClass === "premium" && (agentId === "implement" || agentId === "implementation" || agentId === "recovery")) return "@cf/zhipuai/glm-5.2";
  if (agentId === "implement" || agentId === "implementation") return "@cf/qwen/qwen2.5-coder-32b-instruct";
  return "@cf/openai/gpt-oss-120b";
}

export function isBillableSeat(input: { organizationId: string; targetOrganizationId: string; membershipStatus: string; identityType?: string | null; accessState?: string | null }): boolean {
  return input.organizationId === input.targetOrganizationId
    && input.membershipStatus === "active"
    && (input.identityType ?? "human") === "human"
    && (input.accessState ?? "enabled") === "enabled";
}

export function containsPaidCapField(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return PAID_CAP_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}
