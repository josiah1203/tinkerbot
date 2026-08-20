import { expect, test } from "vitest";
import { calculateEntitlements, containsPaidCapField, modelForCostClass } from "../packages/control-plane/src";
import { parseStripePlans, validateStripePlans } from "../packages/hosted-integrations/src";
import { entitlementDenied, productionCatalogUnavailable, stripeStatus } from "../apps/control-plane-worker/src/billing";

test("Stripe plan JSON rejects paid-cap fields and unknown plan ids", () => {
  expect(parseStripePlans(JSON.stringify([{ id: "developer", monthlyPriceId: "price_dev" }]))).toHaveLength(1);
  expect(parseStripePlans(JSON.stringify([{ id: "team", monthlyPriceId: "price_team", memberLimit: 5 }]))).toEqual([]);
  expect(parseStripePlans(JSON.stringify([{ id: "business", monthlyPriceId: "price_biz", privateRepositoryLimit: 3 }]))).toEqual([]);
  expect(parseStripePlans(JSON.stringify([{ id: "enterprise", monthlyPriceId: "price_ent" }]))).toEqual([]);
  expect(containsPaidCapField({ memberLimit: 1 })).toBe(true);
  expect(containsPaidCapField({ monthlyPriceId: "price_x" })).toBe(false);
});

test("Stripe catalog validation rejects placeholders, duplicate prices, and incomplete production catalogs", () => {
  expect(parseStripePlans(JSON.stringify([{ id: "developer", monthlyPriceId: "price_REPLACE_DEVELOPER_MONTHLY" }]))).toEqual([]);
  expect(validateStripePlans(JSON.stringify([
    { id: "developer", monthlyPriceId: "price_dev", annualPriceId: "price_devy", catalogVersion: "seat-v1" },
    { id: "team", monthlyPriceId: "price_team", annualPriceId: "price_teamy", catalogVersion: "seat-v1" },
    { id: "business", monthlyPriceId: "price_biz", annualPriceId: "price_bizy", catalogVersion: "seat-v1" },
  ]), { requireAllPlans: true, requireAnnualPrices: true })).toMatchObject({ valid: true });
  expect(validateStripePlans(JSON.stringify([
    { id: "developer", monthlyPriceId: "price_dev", annualPriceId: "price_devy", catalogVersion: "seat-v1" },
    { id: "team", monthlyPriceId: "price_dev", annualPriceId: "price_teamy", catalogVersion: "seat-v1" },
    { id: "business", monthlyPriceId: "price_biz", annualPriceId: "price_bizy", catalogVersion: "seat-v2" },
  ]), { requireAllPlans: true, requireAnnualPrices: true })).toMatchObject({ valid: false });
  expect(validateStripePlans(JSON.stringify([
    { id: "developer", monthlyPriceId: "price_dev", annualPriceId: "price_devy", catalogVersion: "seat-v1", metadata: "must-not-ship" },
  ]), { requireAllPlans: true, requireAnnualPrices: true }).errors).toEqual(expect.arrayContaining([expect.stringContaining("unsupported field")]));
});

test("invoice.paid does not wipe a Tinkerbot trial, and production catalog fails closed", () => {
  expect(stripeStatus({ id: "evt", type: "invoice.paid", data: { object: {} } }, { organizationId: "org", planId: "team", status: "trialing", cancelAtPeriodEnd: false, lastEventCreatedAt: 1, updatedAt: "2030-01-01T00:00:00.000Z" })).toBe("trialing");
  expect(stripeStatus({ id: "evt", type: "invoice.payment_failed", data: { object: {} } })).toBe("past_due");
  expect(productionCatalogUnavailable("production", [])).toBe(true);
  expect(productionCatalogUnavailable("staging", [])).toBe(false);
  expect(productionCatalogUnavailable("production", [{ id: "team", monthlyPriceId: "price_team" }])).toBe(false);
});

test("entitlement denial fail-closes canceled and past-due premium mutations", () => {
  const canceled = calculateEntitlements({ planId: "developer", billingStatus: "canceled" });
  expect(entitlementDenied(canceled, "full_factory_pipeline", true)?.code).toBe("entitlement_required");
  const pastDue = calculateEntitlements({ planId: "business", billingStatus: "past_due" });
  expect(entitlementDenied(pastDue, "verification", true)).toBeNull();
  expect(entitlementDenied(pastDue, "sso", true)?.code).toBe("entitlement_required");
  const active = calculateEntitlements({ planId: "business", billingStatus: "active" });
  expect(entitlementDenied(active, "sso", true)).toBeNull();
  expect(modelForCostClass("standard", "triage")).toContain("glm-4.7-flash");
});

test("trial expiry and ineligible second trials are recorded in D1", async () => {
  const trials = new Map<string, { organization_id: string; state: string; ends_at: string }>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_trial_records") && query.includes("stripe_customer_id")) return { organization_id: "org_other" } as T;
          if (query.includes("FROM tinkerbot_trial_records")) return (trials.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_billing_accounts")) return { organization_id: "org_1", plan_id: "team", subscription_status: "trialing", stripe_customer_id: "cus_1", last_event_created_at: 1, updated_at: "2030-01-01T00:00:00.000Z" } as T;
          return null;
        },
        all: async <T>() => ({ results: [...trials.values()].filter((row) => row.ends_at <= String(args[0])) as T[] }),
        run: async () => {
          if (query.includes("tinkerbot_trial_records") && query.includes("INSERT")) trials.set(String(args[0]), { organization_id: String(args[0]), state: "trialing", ends_at: String(args[3]) });
          if (query.includes("SET state = 'expired'")) {
            const row = trials.get(String(args[0]));
            if (row) row.state = "expired";
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const { expireTrials, startTeamTrial } = await import("../apps/control-plane-worker/src/billing");
  expect((await startTeamTrial(database, "org_1", "user_1")).ok).toBe(false);
  trials.set("org_2", { organization_id: "org_2", state: "trialing", ends_at: "2000-01-01T00:00:00.000Z" });
  expect(await expireTrials(database, "2030-01-01T00:00:00.000Z")).toBe(1);
});
