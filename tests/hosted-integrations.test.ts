import { createHmac } from "node:crypto";
import {
  D1AuthSessionStore,
  D1BillingStore,
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  R2JsonEvidenceStore,
  StripeBillingProvider,
  WorkOSAuthProvider,
  hostedProviderConfig,
  providerStatuses,
  parseStripePlans,
  verifyWorkOSSignature,
  verifyStripeSignature,
} from "../packages/hosted-integrations/src";

test("WorkOS adapter keeps credentials server-side and normalizes AuthKit sessions", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new WorkOSAuthProvider({
    clientId: "client_test",
    apiKey: "workos_test_secret",
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ user: { id: "user_1", email: "alex@example.com", first_name: "Alex", email_verified: true }, organization_id: "org_1", access_token: "access_1", refresh_token: "refresh_1", authentication_method: "Password" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const authorizationUrl = provider.authorizationUrl({ redirectUri: "https://tinkerbot.example/auth/callback", state: "state_1" });
  expect(authorizationUrl).toContain("/user_management/authorize");
  expect(authorizationUrl).toContain("client_id=client_test");
  expect(authorizationUrl).toContain("state=state_1");
  const session = await provider.exchangeCode({ code: "auth_code" });
  expect(session.user).toMatchObject({ id: "user_1", email: "alex@example.com", firstName: "Alex" });
  expect(session.organizationId).toBe("org_1");
  expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer workos_test_secret" });
  expect(JSON.stringify(session)).not.toContain("workos_test_secret");
});

test("WorkOS membership sync uses bounded pagination and replay-safe signed webhooks", async () => {
  const requests: string[] = [];
  const provider = new WorkOSAuthProvider({
    clientId: "client_test",
    apiKey: "workos_test_secret",
    webhookSecret: "workos_webhook_secret",
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      if (new URL(url).pathname === "/events") return new Response(JSON.stringify({ data: [{ id: "event_1", event: "organization_membership.updated", data: { id: "om_1", user_id: "user_1", organization_id: "org_1", status: "active", role: { slug: "admin" }, updated_at: "2030-01-01T00:00:00.000Z" } }], list_metadata: { after: "event_1" } }), { status: 200 });
      const after = new URL(url).searchParams.get("after");
      const membership = { id: "om_1", user_id: "user_1", organization_id: "org_1", organization_name: "Atlas", status: "active", role: { slug: "admin" }, user: { id: "user_1", email: "alex@example.com", first_name: "Alex" }, updated_at: "2030-01-01T00:00:00.000Z" };
      return new Response(JSON.stringify({ data: after ? [] : [membership], list_metadata: after ? {} : { after: "page_2" } }), { status: 200 });
    },
  });
  const memberships = await provider.listOrganizationMemberships({ userId: "user_1", organizationId: "org_1" });
  expect(memberships).toMatchObject([{ userId: "user_1", organizationId: "org_1", organizationName: "Atlas", status: "active", roleSlugs: ["admin"], user: { email: "alex@example.com" } }]);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain("user_id=user_1");
  expect(requests[0]).toContain("organization_id=org_1");
  expect(requests[0]).toContain("statuses%5B%5D=active");
  expect(requests[0]).toContain("statuses%5B%5D=inactive");
  expect(requests[0]).toContain("statuses%5B%5D=pending");
  const eventPage = await provider.listEvents({ eventTypes: ["organization_membership.updated"], rangeStart: "2030-01-01T00:00:00.000Z" });
  expect(eventPage).toMatchObject({ after: "event_1", events: [{ id: "event_1", event: "organization_membership.updated" }] });
  expect(requests[2]).toContain("events%5B%5D=organization_membership.updated");
  expect(requests[2]).toContain("range_start=2030-01-01T00%3A00%3A00.000Z");

  const payload = JSON.stringify({ id: "event_1", event: "organization_membership.created", data: { user_id: "user_1", organization_id: "org_1" } });
  const timestamp = Date.now();
  const signature = createHmac("sha256", "workos_webhook_secret").update(`${timestamp}.${payload}`).digest("hex");
  expect(await verifyWorkOSSignature(payload, `t=${timestamp},v1=${signature}`, "workos_webhook_secret", 300, timestamp)).toBe(true);
  expect(await verifyWorkOSSignature(payload, `t=${timestamp},v1=${signature}`, "workos_webhook_secret", 300, timestamp + 300_001)).toBe(false);
  const seen = new Set<string>();
  const ledger = { has: async (id: string) => seen.has(id), record: async (id: string) => void seen.add(id) };
  let calls = 0;
  expect((await provider.handleWebhook(payload, `t=${timestamp},v1=${signature}`, ledger, async () => { calls += 1; }, { nowMilliseconds: timestamp })).duplicate).toBe(false);
  expect((await provider.handleWebhook(payload, `t=${timestamp},v1=${signature}`, ledger, async () => { calls += 1; }, { nowMilliseconds: timestamp })).duplicate).toBe(true);
  expect(calls).toBe(1);
  await expect(provider.handleWebhook(payload, "t=1,v1=bad", ledger, async () => undefined, { nowMilliseconds: timestamp })).rejects.toMatchObject({ code: "invalid_webhook_signature" });
});

test("WorkOS invitation creation keeps provider invitation tokens out of the app contract", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const provider = new WorkOSAuthProvider({
    apiKey: "workos_test_secret",
    fetcher: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({ id: "invitation_1", email: "new@example.com", organization_id: "org_1", state: "pending", role_slug: "viewer", inviter_user_id: "user_1", token: "invite_token_should_not_escape", accept_invitation_url: "https://workos.example/invite" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const invitation = await provider.createInvitation({ email: "new@example.com", organizationId: "org_1", roleSlug: "viewer", inviterUserId: "user_1", expiresInDays: 7 });
  expect(invitation).toMatchObject({ id: "invitation_1", email: "new@example.com", organizationId: "org_1", state: "pending", roleSlug: "viewer" });
  expect(JSON.stringify(invitation)).not.toContain("invite_token_should_not_escape");
  expect(request?.url).toContain("/user_management/invitations");
  expect(String(request?.init?.body)).toContain("\"organization_id\":\"org_1\"");
  expect(String(request?.init?.body)).toContain("\"role_slug\":\"viewer\"");
});

test("Stripe adapter uses server-configured prices and idempotent requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new StripeBillingProvider({
    secretKey: "stripe_test_secret",
    webhookSecret: "whsec_test",
    plans: [{ id: "developer", monthlyPriceId: "price_month", annualPriceId: "price_year", privateRepositoryLimit: 3, memberLimit: 5, retentionDays: 30, features: {} }],
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      const path = new URL(String(input)).pathname;
      const body = path.includes("checkout") ? { id: "cs_test", url: "https://checkout.example/session" } : path.includes("portal") ? { id: "bps_test", url: "https://billing.example/session" } : { id: "sub_test", status: "canceled" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const checkout = await provider.createCheckoutSession({ planId: "developer", interval: "month", organizationId: "org_1", successUrl: "https://tinkerbot.example/success", cancelUrl: "https://tinkerbot.example/cancel", idempotencyKey: "checkout-org_1-developer-month" });
  expect(checkout.id).toBe("cs_test");
  expect(requests[0]?.init?.headers).toMatchObject({ "idempotency-key": "checkout-org_1-developer-month" });
  expect(String(requests[0]?.init?.body)).toContain("price_month");
  expect(String(requests[0]?.init?.body)).not.toContain("stripe_test_secret");
  expect((await provider.createPortalSession({ customerId: "cus_1", returnUrl: "https://tinkerbot.example/app/settings/billing", idempotencyKey: "portal-org_1" })).id).toBe("bps_test");
  expect((await provider.setSubscriptionCancellation({ subscriptionId: "sub_1", cancelAtPeriodEnd: true, idempotencyKey: "cancel-org_1" })).status).toBe("canceled");
});

test("Stripe webhook verification rejects replay and invalid signatures", async () => {
  const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", created: 1_700_000_000, data: { object: { id: "sub_1", status: "active" } } });
  const timestamp = 1_700_000_000;
  const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");
  expect(await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, "whsec_test", 300, timestamp)).toBe(true);
  expect(await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, "whsec_test", 300, timestamp + 301)).toBe(false);

  const provider = new StripeBillingProvider({ secretKey: "stripe_test_secret", webhookSecret: "whsec_test" });
  const seen = new Set<string>();
  const ledger = { has: async (id: string) => seen.has(id), record: async (id: string) => void seen.add(id) };
  let calls = 0;
  expect((await provider.handleWebhook(payload, `t=${timestamp},v1=${signature}`, ledger, async () => { calls += 1; }, { nowSeconds: timestamp })).duplicate).toBe(false);
  expect((await provider.handleWebhook(payload, `t=${timestamp},v1=${signature}`, ledger, async () => { calls += 1; }, { nowSeconds: timestamp })).duplicate).toBe(true);
  expect(calls).toBe(1);
  await expect(provider.handleWebhook(payload, "t=1,v1=bad", ledger, async () => undefined, { nowSeconds: timestamp })).rejects.toMatchObject({ code: "invalid_webhook_signature" });
});

test("Cloudflare secret bindings and portable metadata/evidence stores are provider-neutral", async () => {
  const config = await hostedProviderConfig({ ENVIRONMENT: "staging", WORKOS_CLIENT_ID: { get: async () => "client_test" }, WORKOS_API_KEY: { get: async () => "workos_test_secret" }, STRIPE_SECRET_KEY: "stripe_test_secret", CLOUDFLARE_ACCOUNT_ID: "account_test", WORKER_NAME: "tinkerbot-staging" });
  expect(providerStatuses(config)).toEqual([
    { provider: "workos", state: "unavailable", missing: ["WORKOS_WEBHOOK_SECRET"] },
    { provider: "stripe", state: "unavailable", missing: ["STRIPE_WEBHOOK_SECRET", "STRIPE_PLANS_JSON"] },
    { provider: "cloudflare", state: "configured", missing: [] },
  ]);
  expect(JSON.stringify(providerStatuses(config))).not.toContain("workos_test_secret");

  const values = new Map<string, string>();
  const database = { prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ first: async <T>() => query.startsWith("SELECT") ? (values.has(String(args[0])) ? { value: values.get(String(args[0])) } as T : null) : null, run: async () => { if (query.startsWith("INSERT")) values.set(String(args[0]), String(args[1])); else values.delete(String(args[0])); } }) }) };
  const metadata = new D1JsonMetadataStore(database);
  await metadata.put("org_1", { plan: "developer" });
  expect(await metadata.get("org_1")).toEqual({ plan: "developer" });
  await metadata.delete("org_1");
  expect(await metadata.get("org_1")).toBeNull();

  const objects = new Map<string, string>();
  const bucket = { put: async (key: string, value: string) => void objects.set(key, value), get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null, delete: async (key: string) => void objects.delete(key) };
  const evidence = new R2JsonEvidenceStore(bucket, "runs/");
  await evidence.put("run_1", { schemaVersion: 1, organizationId: "org_1" });
  expect(await evidence.get("run_1")).toEqual({ schemaVersion: 1, organizationId: "org_1" });
});

test("D1 sessions encrypt provider tokens and webhook claims are replay-safe", async () => {
  const sessionRows = new Map<string, Record<string, unknown>>();
  const webhookRows = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_sessions")) return (sessionRows.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhookRows.has(`${String(args[1])}:${String(args[0])}`) ? { event_id: String(args[0]) } : null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_sessions")) {
            sessionRows.set(String(args[0]), { session_id: args[0], user_id: args[1], email: args[2], first_name: args[3], last_name: args[4], email_verified: args[5], organization_id: args[6], expires_at: args[7], authentication_method: args[8], token_ciphertext: args[9] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_sessions")) {
            sessionRows.delete(String(args[0]));
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            const key = `${String(args[1])}:${String(args[0])}`;
            if (webhookRows.has(key)) return { meta: { changes: 0 } };
            webhookRows.set(key, { event_id: args[0], provider: args[1], status: "processing" });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_webhook_events")) {
            const row = webhookRows.get(`${String(args[1])}:${String(args[0])}`);
            if (row) row.status = "processed";
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_webhook_events")) {
            webhookRows.delete(`${String(args[1])}:${String(args[0])}`);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };

  const store = new D1AuthSessionStore(database, "session-encryption-test-key");
  await store.put("session_1", { user: { id: "user_1", email: "alex@example.com" }, organizationId: "org_1", accessToken: "access_secret", refreshToken: "refresh_secret", expiresAt: "2030-01-01T00:00:00.000Z" });
  expect(String(sessionRows.get("session_1")?.token_ciphertext)).not.toContain("access_secret");
  expect(await store.get("session_1")).toMatchObject({ user: { id: "user_1" }, organizationId: "org_1", accessToken: "access_secret", refreshToken: "refresh_secret" });

  const ledger = new D1WebhookLedger(database);
  expect(await ledger.claim("evt_1")).toBe(true);
  expect(await ledger.claim("evt_1")).toBe(false);
  await ledger.record("evt_1");
  expect(webhookRows.get("stripe:evt_1")?.status).toBe("processed");
  const workosLedger = new D1WebhookLedger(database, "workos");
  expect(await workosLedger.claim("evt_1")).toBe(true);
  await workosLedger.release("evt_1");
  expect(await workosLedger.claim("evt_1")).toBe(true);
});

test("Stripe plan fixtures and D1 billing mappings fail closed and reject stale events", async () => {
  expect(parseStripePlans(JSON.stringify([{ id: "team", monthlyPriceId: "price_month", privateRepositoryLimit: 10, memberLimit: 5, retentionDays: 30, features: { team_invitations: true } }]))).toHaveLength(1);
  expect(parseStripePlans(JSON.stringify([{ id: "unsafe", monthlyPriceId: "price_bad", privateRepositoryLimit: 10, retentionDays: 30 }]))).toEqual([]);
  expect(parseStripePlans(JSON.stringify([{ id: "unsafe", monthlyPriceId: "price_bad", privateRepositoryLimit: -1, memberLimit: 5, retentionDays: 30, features: {} }]))).toEqual([]);

  let row: Record<string, unknown> | null = null;
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (!row) return null;
          if (query.includes("organization_id =") && row.organization_id !== args[0]) return null;
          if (query.includes("stripe_customer_id =") && row.stripe_customer_id !== args[0]) return null;
          if (query.includes("stripe_subscription_id =") && row.stripe_subscription_id !== args[0]) return null;
          return row as T;
        },
        run: async () => {
          const incomingCreated = Number(args[9]);
          if (row && incomingCreated < Number(row.last_event_created_at)) return { meta: { changes: 0 } };
          row = { organization_id: args[0], stripe_customer_id: args[1], stripe_subscription_id: args[2], plan_id: args[3], billing_interval: args[4], subscription_status: args[5], cancel_at_period_end: args[6], current_period_end: args[7], last_event_id: args[8], last_event_created_at: args[9], updated_at: args[10] };
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const billing = new D1BillingStore(database);
  expect(await billing.upsert({ organizationId: "org_1", customerId: "cus_1", subscriptionId: "sub_1", planId: "team", interval: "month", status: "active", cancelAtPeriodEnd: false, lastEventId: "evt_new", lastEventCreatedAt: 200, updatedAt: "2030-01-01T00:00:00.000Z" })).toBe(true);
  expect(await billing.upsert({ organizationId: "org_1", customerId: "cus_1", subscriptionId: "sub_1", planId: "free", status: "canceled", cancelAtPeriodEnd: false, lastEventId: "evt_old", lastEventCreatedAt: 100, updatedAt: "2029-01-01T00:00:00.000Z" })).toBe(false);
  expect(await billing.getByCustomer("cus_1")).toMatchObject({ organizationId: "org_1", planId: "team", status: "active", lastEventId: "evt_new" });
  expect(await billing.getBySubscription("sub_1")).toMatchObject({ organizationId: "org_1" });
});

test("D1 tenant access is organization-scoped and entitlements round-trip", async () => {
  const memberships = new Map([["user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" }]]);
  const entitlements = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_memberships")) return (memberships.get(`${String(args[1])}:${String(args[0])}`) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_entitlements")) return (entitlements.get(String(args[0])) ?? null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_entitlements")) entitlements.set(String(args[0]), { organization_id: args[0], plan_id: args[1], billing_status: args[2], private_repository_limit: args[3], member_limit: args[4], retention_days: args[5], features_json: args[6], updated_at: args[7] });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const tenants = new D1TenantStore(database);
  expect(await tenants.getMembership("user_1", "org_1")).toEqual({ organizationId: "org_1", userId: "user_1", role: "owner", status: "active" });
  expect(await tenants.getMembership("user_1", "org_2")).toBeNull();
  await tenants.putEntitlements({ organizationId: "org_1", planId: "developer", billingStatus: "active", privateRepositoryLimit: 3, memberLimit: 5, retentionDays: 30, features: { history: true }, updatedAt: "2030-01-01T00:00:00.000Z" });
  expect(await tenants.getEntitlements("org_1")).toEqual({ organizationId: "org_1", planId: "developer", billingStatus: "active", privateRepositoryLimit: 3, memberLimit: 5, retentionDays: 30, features: { history: true }, updatedAt: "2030-01-01T00:00:00.000Z" });
});

test("D1 tenant invitation state and seat usage are organization-scoped", async () => {
  const invitations = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("COUNT(*) AS count")) return { count: 2 } as T;
          if (query.includes("tinkerbot_invitations")) return (invitations.get(`${String(args[0])}:${String(args[1]).toLowerCase()}`) ?? null) as T | null;
          return null;
        },
        all: async <T>() => ({ results: [...invitations.values()].filter((row) => row.organization_id === args[0]) as T[] }),
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_invitations")) invitations.set(`${String(args[1])}:${String(args[2]).toLowerCase()}`, { invitation_id: args[0], organization_id: args[1], email: args[2], role: args[3], state: args[4], provider_invitation_id: args[5], inviter_user_id: args[6], accepted_user_id: args[7], expires_at: args[8], created_at: args[9], updated_at: args[10] });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const tenants = new D1TenantStore(database);
  await tenants.upsertInvitation({ invitationId: "inv_1", organizationId: "org_1", email: "invitee@example.com", role: "viewer", state: "pending", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" });
  expect(await tenants.countSeatUsage("org_1")).toBe(2);
  expect(await tenants.getPendingInvitation("org_1", "INVITEE@example.com")).toMatchObject({ invitationId: "inv_1", role: "viewer", state: "pending" });
  expect(await tenants.listInvitations("org_1")).toHaveLength(1);
  expect(await tenants.getPendingInvitation("org_2", "invitee@example.com")).toBeNull();
});
