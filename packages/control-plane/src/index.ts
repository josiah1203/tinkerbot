import type { PrProofReport, Verdict } from "../../core/src/types";

export type BillingStatus =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired"
  | "payment_required"
  | "enterprise_inquiry"
  | "billing_unavailable";

export type PlanId = "free" | "developer" | "team" | "business" | "enterprise";
export type OrganizationRole = "owner" | "admin" | "maintainer" | "reviewer" | "viewer" | "billing_administrator";

export interface Plan {
  id: PlanId;
  displayName: string;
  price: { amountCents: number | null; currency: "USD"; interval: "month" | "year" | "custom" };
  privateRepositoryLimit: number | null;
  historyRetention: string;
  policyFeatures: string[];
  teamFeatures: string[];
  auditFeatures: string[];
  supportLevel: "community" | "standard" | "priority" | "enterprise";
  selfHostedAvailable: boolean;
}

export const PLAN_CATALOG: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    displayName: "Free",
    price: { amountCents: 0, currency: "USD", interval: "month" },
    privateRepositoryLimit: 0,
    historyRetention: "Local only",
    policyFeatures: ["Default advisory policy"],
    teamFeatures: [],
    auditFeatures: [],
    supportLevel: "community",
    selfHostedAvailable: false,
  },
  developer: {
    id: "developer",
    displayName: "Developer",
    price: { amountCents: 1900, currency: "USD", interval: "month" },
    privateRepositoryLimit: 3,
    historyRetention: "90 days",
    policyFeatures: ["Repository policies", "Baselines and waivers"],
    teamFeatures: ["3 members"],
    auditFeatures: ["90-day audit log"],
    supportLevel: "standard",
    selfHostedAvailable: false,
  },
  team: {
    id: "team",
    displayName: "Team",
    price: { amountCents: 14900, currency: "USD", interval: "month" },
    privateRepositoryLimit: 15,
    historyRetention: "1 year",
    policyFeatures: ["Repository policies", "Baselines and waivers", "Required evidence rules"],
    teamFeatures: ["15 members", "Role-based access"],
    auditFeatures: ["1-year audit log"],
    supportLevel: "priority",
    selfHostedAvailable: false,
  },
  business: {
    id: "business",
    displayName: "Business",
    price: { amountCents: 49900, currency: "USD", interval: "month" },
    privateRepositoryLimit: 50,
    historyRetention: "2 years",
    policyFeatures: ["Required evidence rules", "Blocking policy controls", "Policy revision history"],
    teamFeatures: ["50 members", "Advanced repository access"],
    auditFeatures: ["2-year audit log", "Exportable audit events"],
    supportLevel: "priority",
    selfHostedAvailable: false,
  },
  enterprise: {
    id: "enterprise",
    displayName: "Enterprise",
    price: { amountCents: null, currency: "USD", interval: "custom" },
    privateRepositoryLimit: null,
    historyRetention: "Configurable",
    policyFeatures: ["Custom policy controls", "Approval workflows"],
    teamFeatures: ["Custom member limit", "SCIM / SSO configuration"],
    auditFeatures: ["Configurable audit retention"],
    supportLevel: "enterprise",
    selfHostedAvailable: true,
  },
};

export interface EntitlementSnapshot {
  planId: PlanId;
  billingStatus: BillingStatus;
  activePrivateRepositories: number;
  memberCount: number;
}

export function getPlan(planId: PlanId): Plan {
  const plan = PLAN_CATALOG[planId];
  if (!plan) throw new Error(`Unknown plan: ${String(planId)}`);
  return plan;
}

export function canConnectPrivateRepository(snapshot: EntitlementSnapshot): boolean {
  if (!snapshot || !Number.isFinite(snapshot.activePrivateRepositories) || snapshot.activePrivateRepositories < 0) return false;
  let plan: Plan;
  try { plan = getPlan(snapshot.planId); } catch { return false; }
  if (snapshot.billingStatus === "past_due" || snapshot.billingStatus === "payment_required" || snapshot.billingStatus === "expired") return false;
  if (plan.privateRepositoryLimit === null) return true;
  return snapshot.activePrivateRepositories < plan.privateRepositoryLimit;
}

export function usageRatio(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null;
  if (limit <= 0) return used > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, used / limit));
}

export type OrganizationAction =
  | "manage_billing"
  | "manage_members"
  | "manage_policy"
  | "view_audit"
  | "connect_repository"
  | "delete_metadata";

const ROLE_ACTIONS: Readonly<Record<OrganizationRole, ReadonlySet<OrganizationAction>>> = {
  owner: new Set(["manage_billing", "manage_members", "manage_policy", "view_audit", "connect_repository", "delete_metadata"]),
  admin: new Set(["manage_members", "manage_policy", "view_audit", "connect_repository", "delete_metadata"]),
  maintainer: new Set(["manage_policy", "connect_repository"]),
  reviewer: new Set(["view_audit"]),
  viewer: new Set(),
  billing_administrator: new Set(["manage_billing"]),
};

export function isOrganizationActionAllowed(role: OrganizationRole, action: OrganizationAction): boolean {
  return ROLE_ACTIONS[role]?.has(action) ?? false;
}

export function safeReturnTo(value: unknown, fallback = "/app/overview"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value) || !value.startsWith("/") || value.startsWith("//") || value.includes("://")) return fallback;
  return value;
}

export function requiresAuthentication(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export interface AuthSession {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  role: OrganizationRole;
  expiresAt: string;
  developmentOnly?: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthAdapter {
  getSession(): Promise<AuthSession | null>;
  signIn(input: { email: string; password: string }): Promise<{ session?: AuthSession; error?: string }>;
  signUp(input: { name: string; email: string; password: string }): Promise<{ session?: AuthSession; error?: string }>;
  requestPasswordReset(email: string): Promise<{ accepted: boolean; message: string }>;
  signOut(): Promise<void>;
}

const SESSION_KEY = "pr-proof.control-plane.session";

function sessionFromInput(name: string, email: string): AuthSession {
  return {
    userId: "dev-user-001",
    email: email.trim().toLowerCase(),
    name: name.trim() || "Developer",
    organizationId: "org-atlas",
    role: "owner",
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    developmentOnly: true,
  };
}

function validSession(value: unknown): value is AuthSession {
  const session = value as Partial<AuthSession> | undefined;
  return Boolean(session && typeof session === "object" && typeof session.userId === "string" && typeof session.email === "string" && typeof session.name === "string" && typeof session.organizationId === "string" && typeof session.expiresAt === "string" && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now() && ["owner", "admin", "maintainer", "reviewer", "viewer", "billing_administrator"].includes(String(session.role)));
}

export function createDevelopmentAuthAdapter(storage: StorageLike): AuthAdapter {
  return {
    async getSession() {
      let raw: string | null;
      try { raw = storage.getItem(SESSION_KEY); } catch { return null; }
      if (!raw) return null;
      try {
        const session = JSON.parse(raw) as unknown;
        if (!validSession(session)) {
          storage.removeItem(SESSION_KEY);
          return null;
        }
        return session;
      } catch {
        storage.removeItem(SESSION_KEY);
        return null;
      }
    },
    async signIn({ email, password }) {
      if (typeof email !== "string" || !email.includes("@")) return { error: "Enter a valid email address." };
      if (typeof password !== "string" || password.length < 8 || password === "wrong-password") return { error: "The development sign-in was rejected. Use any 8+ character password other than the test failure value." };
      const session = sessionFromInput("Alex Morgan", email);
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); return { session }; } catch { return { error: "The local session store is unavailable." }; }
    },
    async signUp({ name, email, password }) {
      if (typeof name !== "string" || !name.trim()) return { error: "Enter your name." };
      if (typeof email !== "string" || !email.includes("@")) return { error: "Enter a valid email address." };
      if (typeof password !== "string" || password.length < 8) return { error: "Use at least 8 characters for the development password." };
      const session = sessionFromInput(name, email);
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); return { session }; } catch { return { error: "The local session store is unavailable." }; }
    },
    async requestPasswordReset(email) {
      if (typeof email !== "string" || !email.includes("@")) return { accepted: false, message: "Enter a valid email address." };
      return { accepted: true, message: "In production, the configured provider would send a reset link. No email was sent by this development adapter." };
    },
    async signOut() {
      try { storage.removeItem(SESSION_KEY); } catch { /* local preview sign-out is best effort */ }
    },
  };
}

export interface BillingProviderAdapter {
  readonly mode: "unavailable" | "test" | "production";
  getStatus(): Promise<{ status: BillingStatus; message: string }>;
  beginCheckout(planId: PlanId): Promise<{ status: "unavailable" | "started"; message: string; checkoutUrl?: string }>;
}

export function createUnavailableBillingProvider(): BillingProviderAdapter {
  return {
    mode: "unavailable",
    async getStatus() {
      return { status: "billing_unavailable", message: "No billing provider is configured for this environment." };
    },
    async beginCheckout() {
      return { status: "unavailable", message: "Checkout is disabled until a server-side billing provider is configured." };
    },
  };
}

export interface WebhookLedger {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

export function createWebhookLedger(): WebhookLedger {
  const ids = new Set<string>();
  return { has: (eventId) => ids.has(eventId), add: (eventId) => void ids.add(eventId) };
}

export function applyWebhookEventOnce<T>(ledger: WebhookLedger, eventId: string, apply: () => T): { applied: boolean; value?: T } {
  if (ledger.has(eventId)) return { applied: false };
  const value = apply();
  ledger.add(eventId);
  return { applied: true, value };
}

export interface ControlPlaneRunSummary {
  repository: string;
  verdict: Lowercase<Verdict>;
  generatedAt: string | null;
  commitSha: string;
  baseSha: string;
  findingCount: number;
  unknownCount: number;
  changedFiles: number | null;
  changedLines: number | null;
  coveragePercentage: number | null;
  mutantsKilled: number;
  mutantsTotal: number;
  limitationCount: number;
}

export function normalizeReportSummary(report: PrProofReport): ControlPlaneRunSummary {
  const unknownCount = report.findings.filter((finding) => finding.resolution === "unknown" || finding.baselineState === "unknown").length;
  return {
    repository: report.repository,
    verdict: report.verdict.toLowerCase() as Lowercase<Verdict>,
    generatedAt: report.generatedAt ?? null,
    commitSha: report.head,
    baseSha: report.base,
    findingCount: report.findings.length,
    unknownCount,
    // Report v1 does not contain changed-file or changed-line totals. Do not
    // relabel symbol/path counts as file/line usage in the control plane.
    changedFiles: null,
    changedLines: null,
    coveragePercentage: report.summary.changedLinesCoveredPercentage,
    mutantsKilled: report.summary.mutantsKilled,
    mutantsTotal: report.summary.mutantsTotal,
    limitationCount: report.limitations.length,
  };
}
