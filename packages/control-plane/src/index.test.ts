import type { PrProofReport } from "../../core/src/types";
import {
  PLAN_CATALOG,
  applyWebhookEventOnce,
  calculateEntitlements,
  canConnectPrivateRepository,
  containsPaidCapField,
  createDevelopmentAuthAdapter,
  createUnavailableBillingProvider,
  createWebhookLedger,
  effectivePlanId,
  getPlan,
  hasEntitlement,
  isBillableSeat,
  isOrganizationActionAllowed,
  isPlanId,
  modelForCostClass,
  normalizeBillingStatus,
  normalizeReportSummary,
  publicBillingCatalog,
  publicCapabilities,
  requiresAuthentication,
  safeReturnTo,
  usageRatio,
} from ".";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("development auth persists a session and rejects the documented failure value", async () => {
  const storage = memoryStorage();
  const auth = createDevelopmentAuthAdapter(storage);
  expect((await auth.signIn({ email: "alex@example.test", password: "wrong-password" })).error).toContain("rejected");
  const result = await auth.signIn({ email: "alex@example.test", password: "local-only-password" });
  expect(result.session?.developmentOnly).toBe(true);
  expect((await auth.getSession())?.email).toBe("alex@example.test");
  await auth.signOut();
  expect(await auth.getSession()).toBeNull();
});

test("safe redirects stay inside the control plane", () => {
  expect(safeReturnTo("/app/repositories")).toBe("/app/repositories");
  expect(safeReturnTo("https://example.com")).toBe("/app");
  expect(safeReturnTo("//example.com")).toBe("/app");
  expect(safeReturnTo("/app/overview\nSet-Cookie: leaked")).toBe("/app");
  expect(safeReturnTo("/".repeat(2050))).toBe("/app");
});

test("paid plans are per-active-seat, have no repository caps, and reject payment failure", () => {
  expect(PLAN_CATALOG.developer).toMatchObject({ price: { amountCents: 2000 }, annualPriceCents: 20000, billingUnit: "active_seat", paidSeatCap: "none", paidRepositoryCap: "none" });
  expect(PLAN_CATALOG.team).toMatchObject({ price: { amountCents: 4000 }, annualPriceCents: 40000, billingUnit: "active_seat", paidSeatCap: "none" });
  expect(PLAN_CATALOG.business).toMatchObject({ price: { amountCents: 6000 }, annualPriceCents: 60000, billingUnit: "active_seat", paidSeatCap: "none" });
  expect(PLAN_CATALOG.enterprise.selfHostedAvailable).toBe(false);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "active", activePrivateRepositories: 2, memberCount: 1 })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "active", activePrivateRepositories: 500, memberCount: 1 })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "past_due", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(canConnectPrivateRepository({ planId: "enterprise", billingStatus: "active", activePrivateRepositories: 500, memberCount: 1 })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "invalid" as never, billingStatus: "active", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(usageRatio(2, 3)).toBeCloseTo(2 / 3);
  expect(usageRatio(50, null)).toBeNull();
  expect(usageRatio(Number.NaN, 3)).toBeNull();
  expect(getPlan("developer").displayName).toBe("Developer");
  expect(() => getPlan("invalid" as never)).toThrow(/Unknown plan/);
});

test("development auth treats malformed or unavailable local storage as unknown", async () => {
  const throwingStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
    removeItem: () => { throw new Error("storage unavailable"); },
  };
  const auth = createDevelopmentAuthAdapter(throwingStorage);
  expect(await auth.getSession()).toBeNull();
  expect((await auth.signIn({ email: "alex@example.test", password: "local-only-password" })).error).toContain("unavailable");
  await expect(auth.signOut()).resolves.toBeUndefined();
});

test("development auth validates signup inputs and clears malformed or expired stored sessions", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const auth = createDevelopmentAuthAdapter(storage);
  expect((await auth.signUp({ name: "", email: "alex@example.test", password: "local-only-password" })).error).toContain("name");
  expect((await auth.signUp({ name: "Alex", email: "invalid", password: "local-only-password" })).error).toContain("email");
  expect((await auth.signUp({ name: "Alex", email: "alex@example.test", password: "short" })).error).toContain("8 characters");
  expect((await auth.signUp({ name: " Alex ", email: "ALEX@EXAMPLE.TEST", password: "local-only-password" })).session).toMatchObject({ name: "Alex", email: "alex@example.test" });
  values.set("tinkerbot.control-plane.session", "not-json");
  expect(await auth.getSession()).toBeNull();
  expect(values.has("tinkerbot.control-plane.session")).toBe(false);
  values.set("tinkerbot.control-plane.session", JSON.stringify({ userId: "user", email: "a@example.test", name: "A", organizationId: "org", role: "owner", expiresAt: "2000-01-01T00:00:00.000Z" }));
  expect(await auth.getSession()).toBeNull();
  expect(values.has("tinkerbot.control-plane.session")).toBe(false);
  expect(await auth.requestPasswordReset("invalid")).toMatchObject({ accepted: false });
  expect(await auth.requestPasswordReset("alex@example.test")).toMatchObject({ accepted: true });
});

test("entitlement helpers reject invalid usage and protect only application routes", () => {
  expect(canConnectPrivateRepository({ planId: "free", billingStatus: "active", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "unpaid", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "expired", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(usageRatio(-2, 3)).toBe(0);
  expect(usageRatio(4, 0)).toBe(1);
  expect(usageRatio(0, 0)).toBe(0);
  expect(requiresAuthentication("/app")).toBe(true);
  expect(requiresAuthentication("/app/repositories")).toBe(true);
  expect(requiresAuthentication("/appetite")).toBe(false);
  expect(requiresAuthentication("/sign-in")).toBe(false);
});

test("organization actions are role-authorized by the server-side policy", () => {
  expect(isOrganizationActionAllowed("owner", "manage_billing")).toBe(true);
  expect(isOrganizationActionAllowed("billing_administrator", "manage_billing")).toBe(true);
  expect(isOrganizationActionAllowed("billing_administrator", "manage_policy")).toBe(false);
  expect(isOrganizationActionAllowed("viewer", "delete_metadata")).toBe(false);
});

test("server entitlements grant Team trial features, refuse paid caps, and route models by cost class", () => {
  const catalog = publicBillingCatalog();
  expect(catalog.find((plan) => plan.id === "team")?.trialAvailable).toBe(true);
  expect(catalog.find((plan) => plan.id === "developer")?.monthlyPriceCents).toBe(2000);
  expect(publicCapabilities("developer").premium_escalation).toBe("limited");
  expect(publicCapabilities("team").factory_improvement).toBe("limited");
  expect(isPlanId("business")).toBe(true);
  expect(isPlanId("hobby")).toBe(false);
  expect(normalizeBillingStatus("paid")).toBe("active");
  expect(normalizeBillingStatus("cancelled")).toBe("canceled");
  expect(normalizeBillingStatus("inactive")).toBe("free");
  expect(normalizeBillingStatus("not-a-status")).toBe("unknown");
  expect(effectivePlanId({ planId: "developer", trialState: "trial_expiring" })).toBe("team");
  expect(effectivePlanId({ planId: "developer", billingStatus: "deleted" })).toBe("free");
  const team = calculateEntitlements({ planId: "team", billingStatus: "trialing", trialState: "trialing" });
  expect(team.features.team_invitations).toBe(true);
  expect(team.features.sso).toBe(false);
  const expiredTrial = calculateEntitlements({ planId: "team", billingStatus: "trialing", trialState: "expired" });
  expect(expiredTrial.planId).toBe("free");
  const business = calculateEntitlements({ planId: "business", billingStatus: "active" });
  expect(business.features.sso).toBe(true);
  expect(business.features.service_credentials).toBe(true);
  const canceled = calculateEntitlements({ planId: "developer", billingStatus: "canceled" });
  expect(canceled.planId).toBe("free");
  const granted = calculateEntitlements({
    planId: "free",
    billingStatus: "active",
    now: "2030-01-01T00:00:00.000Z",
    enterpriseGrants: [
      { key: "sso" },
      { key: "scim", expiresAt: "2031-01-01T00:00:00.000Z" },
      { key: "audit_export", expiresAt: "2020-01-01T00:00:00.000Z" },
      { key: "not_a_feature" as never },
    ],
  });
  expect(granted.features.sso).toBe(true);
  expect(granted.features.scim).toBe(true);
  expect(granted.features.audit_export).toBe(false);
  const unknown = calculateEntitlements({ planId: "business", billingStatus: "billing_unavailable" });
  expect(hasEntitlement(unknown, "sso", { mutation: true })).toBe(false);
  expect(hasEntitlement(business, "sso", { mutation: true })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "payment_required" })).toBe(false);
  expect(isBillableSeat({ organizationId: "org", targetOrganizationId: "org", membershipStatus: "active", identityType: "human", accessState: "enabled" })).toBe(true);
  expect(isBillableSeat({ organizationId: "org", targetOrganizationId: "org", membershipStatus: "active", identityType: "service", accessState: "enabled" })).toBe(false);
  expect(isBillableSeat({ organizationId: "org", targetOrganizationId: "other", membershipStatus: "active" })).toBe(false);
  expect(isBillableSeat({ organizationId: "org", targetOrganizationId: "org", membershipStatus: "active", identityType: "bot", accessState: "disabled" })).toBe(false);
  expect(isOrganizationActionAllowed("not-a-role" as never, "manage_billing")).toBe(false);
  expect(containsPaidCapField(null)).toBe(false);
  expect(containsPaidCapField(["memberLimit"])).toBe(false);
  expect(modelForCostClass("economy", "implement")).toContain("glm-4.7-flash");
  expect(modelForCostClass("premium", "implement")).toContain("glm-5.2");
  expect(modelForCostClass("premium", "recovery")).toContain("glm-5.2");
  expect(modelForCostClass("steward", "steward")).toContain("qwen2.5-coder-32b-instruct");
  expect(modelForCostClass("standard", "implementation")).toContain("qwen2.5-coder-32b-instruct");
  expect(modelForCostClass("standard", "review")).toContain("gpt-oss-120b");
});

test("unavailable billing never claims checkout started", async () => {
  const provider = createUnavailableBillingProvider();
  expect(provider.mode).toBe("unavailable");
  expect((await provider.getStatus()).status).toBe("billing_unavailable");
  expect((await provider.beginCheckout("team")).status).toBe("unavailable");
});

test("webhook event application is idempotent", () => {
  const ledger = createWebhookLedger();
  let applied = 0;
  expect(applyWebhookEventOnce(ledger, "evt_1", () => ++applied).applied).toBe(true);
  expect(applyWebhookEventOnce(ledger, "evt_1", () => ++applied).applied).toBe(false);
  expect(applied).toBe(1);
});

test("report normalization preserves explicit unknown evidence", () => {
  const report: PrProofReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    repository: "acme/pr-proof",
    base: "base-sha",
    head: "head-sha",
    verdict: "UNKNOWN",
    summary: {
      assertionsWeakened: 0,
      newTests: 1,
      testsPassingOnBase: 1,
      changedLinesCoveredPercentage: null,
      mutantsKilled: 0,
      mutantsTotal: 0,
      changedSymbols: 0,
      downstreamConsumers: 0,
      impactedTests: 0,
      impactedPathsExecuted: 0,
      impactedPathsTotal: 0,
      unverifiedPaths: 0,
    },
    findings: [],
    limitations: ["Coverage artifact missing."],
  };
  const summary = normalizeReportSummary(report);
  expect(summary.verdict).toBe("unknown");
  expect(summary.unknownCount).toBe(0);
  expect(summary.limitationCount).toBe(1);
  expect(summary.changedFiles).toBeNull();
  expect(summary.changedLines).toBeNull();
  expect(summary.coveragePercentage).toBeNull();
});
