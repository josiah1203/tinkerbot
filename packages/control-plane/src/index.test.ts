import type { PrProofReport } from "../../core/src/types";
import {
  PLAN_CATALOG,
  applyWebhookEventOnce,
  canConnectPrivateRepository,
  createDevelopmentAuthAdapter,
  createUnavailableBillingProvider,
  createWebhookLedger,
  getPlan,
  isOrganizationActionAllowed,
  normalizeReportSummary,
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
  expect(safeReturnTo("https://example.com")).toBe("/app/overview");
  expect(safeReturnTo("//example.com")).toBe("/app/overview");
  expect(safeReturnTo("/app/overview\nSet-Cookie: leaked")).toBe("/app/overview");
  expect(safeReturnTo("/".repeat(2050))).toBe("/app/overview");
});

test("entitlements block private repositories at the configured limit and on payment failure", () => {
  expect(PLAN_CATALOG.developer.privateRepositoryLimit).toBe(3);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "active", activePrivateRepositories: 2, memberCount: 1 })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "active", activePrivateRepositories: 3, memberCount: 1 })).toBe(false);
  expect(canConnectPrivateRepository({ planId: "developer", billingStatus: "past_due", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(canConnectPrivateRepository({ planId: "enterprise", billingStatus: "active", activePrivateRepositories: 500, memberCount: 1 })).toBe(true);
  expect(canConnectPrivateRepository({ planId: "invalid" as never, billingStatus: "active", activePrivateRepositories: 0, memberCount: 1 })).toBe(false);
  expect(usageRatio(2, 3)).toBeCloseTo(2 / 3);
  expect(usageRatio(50, null)).toBeNull();
  expect(usageRatio(Number.NaN, 3)).toBeNull();
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

test("organization actions are role-authorized by the server-side policy", () => {
  expect(isOrganizationActionAllowed("owner", "manage_billing")).toBe(true);
  expect(isOrganizationActionAllowed("billing_administrator", "manage_billing")).toBe(true);
  expect(isOrganizationActionAllowed("billing_administrator", "manage_policy")).toBe(false);
  expect(isOrganizationActionAllowed("viewer", "delete_metadata")).toBe(false);
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
