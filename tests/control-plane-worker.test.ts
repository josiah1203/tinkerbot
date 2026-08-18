import worker, { roleHasCapability } from "../apps/control-plane-worker/src";
import { createHmac } from "node:crypto";

test("Cloudflare Worker exposes non-secret provider status and keeps local verification independent", async () => {
  const response = await worker.fetch(new Request("https://control.example/health"), { ENVIRONMENT: "staging", WORKER_NAME: "tinkerbot-staging" });
  expect(response.status).toBe(200);
  const body = await response.json() as { service: string; environment: string; providers: Array<{ provider: string; state: string; missing: string[] }> };
  expect(body.service).toBe("tinkerbot-control-plane");
  expect(body.environment).toBe("staging");
  expect(body.providers.find((provider) => provider.provider === "workos")?.state).toBe("unavailable");
  expect(JSON.stringify(body)).not.toContain("secret");
});

test("tenant RBAC capabilities are explicit and least-privilege", () => {
  expect(roleHasCapability("owner", "billing:manage")).toBe(true);
  expect(roleHasCapability("admin", "invitations:create")).toBe(true);
  expect(roleHasCapability("billing_administrator", "billing:manage")).toBe(true);
  expect(roleHasCapability("billing_administrator", "assurance:read")).toBe(false);
  expect(roleHasCapability("maintainer", "assurance:write")).toBe(true);
  expect(roleHasCapability("maintainer", "assurance:delete")).toBe(false);
  expect(roleHasCapability("reviewer", "assurance:read")).toBe(true);
  expect(roleHasCapability("reviewer", "assurance:write")).toBe(false);
  expect(roleHasCapability("viewer", "billing:read")).toBe(false);
});

test("Stripe webhooks resolve invoice tenants, fail closed on payment failure, and ignore stale state", async () => {
  const webhooks = new Map<string, Record<string, unknown>>();
  let billing: Record<string, unknown> | null = null;
  let entitlement: Record<string, unknown> | null = null;
  const metadata = new Map<string, string>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhooks.has(`${String(args[1])}:${String(args[0])}`) ? { event_id: args[0] } : null) as T | null;
          if (query.includes("FROM tinkerbot_metadata")) return (metadata.has(String(args[0])) ? { value: metadata.get(String(args[0])) } : null) as T | null;
          if (query.includes("FROM tinkerbot_billing_accounts")) {
            if (!billing) return null;
            if (query.includes("organization_id =") && billing.organization_id !== args[0]) return null;
            if (query.includes("stripe_customer_id =") && billing.stripe_customer_id !== args[0]) return null;
            if (query.includes("stripe_subscription_id =") && billing.stripe_subscription_id !== args[0]) return null;
            return billing as T;
          }
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            const key = `${String(args[1])}:${String(args[0])}`;
            if (webhooks.has(key)) return { meta: { changes: 0 } };
            webhooks.set(key, { event_id: args[0], provider: args[1], status: "processing" });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_webhook_events")) {
            const row = webhooks.get(`${String(args[1])}:${String(args[0])}`);
            if (row) row.status = "processed";
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_webhook_events")) {
            webhooks.delete(`${String(args[1])}:${String(args[0])}`);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_billing_accounts")) {
            if (billing && Number(args[9]) < Number(billing.last_event_created_at)) return { meta: { changes: 0 } };
            billing = { organization_id: args[0], stripe_customer_id: args[1], stripe_subscription_id: args[2], plan_id: args[3], billing_interval: args[4], subscription_status: args[5], cancel_at_period_end: args[6], current_period_end: args[7], last_event_id: args[8], last_event_created_at: args[9], updated_at: args[10] };
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_entitlements")) {
            entitlement = { organization_id: args[0], plan_id: args[1], billing_status: args[2], private_repository_limit: args[3], member_limit: args[4], retention_days: args[5], features_json: args[6], updated_at: args[7] };
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_metadata")) {
            metadata.set(String(args[0]), String(args[1]));
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  metadata.set("billing:checkout:cs_1", JSON.stringify({ organizationId: "org_1", planId: "team", interval: "month", createdAt: "2030-01-01T00:00:00.000Z" }));
  const env = { STRIPE_SECRET_KEY: "stripe_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PLANS_JSON: JSON.stringify([{ id: "team", monthlyPriceId: "price_team", privateRepositoryLimit: 10, memberLimit: 5, retentionDays: 30, features: { team_invitations: true } }]), DB: database };
  const send = async (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");
    return worker.fetch(new Request("https://control.example/billing/webhook", { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload }), env);
  };
  expect((await send({ id: "evt_mismatched_checkout", type: "checkout.session.completed", created: 100, data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", client_reference_id: "org_attacker", metadata: { organization_id: "org_attacker" }, items: { data: [{ price: { id: "price_team" } }] } } } })).status).toBe(200);
  expect(billing).toBeNull();
  expect((await send({ id: "evt_checkout", type: "checkout.session.completed", created: 150, data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", client_reference_id: "org_1", metadata: { organization_id: "org_1" }, items: { data: [{ price: { id: "price_team" } }] } } } })).status).toBe(200);
  expect(billing).toMatchObject({ organization_id: "org_1", plan_id: "team", subscription_status: "incomplete" });
  expect((await send({ id: "evt_subscription", type: "customer.subscription.updated", created: 200, data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { organization_id: "org_1" }, items: { data: [{ price: { id: "price_team" } }] } } } })).status).toBe(200);
  expect(billing).toMatchObject({ organization_id: "org_1", plan_id: "team", subscription_status: "active" });
  expect(entitlement).toMatchObject({ plan_id: "team", billing_status: "active" });
  expect((await send({ id: "evt_failed", type: "invoice.payment_failed", created: 300, data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1", status: "open", lines: { data: [{ price: { id: "price_team" } }] } } } })).status).toBe(200);
  expect(billing).toMatchObject({ subscription_status: "past_due", last_event_id: "evt_failed" });
  expect(entitlement).toMatchObject({ billing_status: "past_due" });
  expect((await send({ id: "evt_stale_paid", type: "invoice.paid", created: 250, data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1", lines: { data: [{ price: { id: "price_team" } }] } } } })).status).toBe(200);
  expect(billing).toMatchObject({ subscription_status: "past_due", last_event_id: "evt_failed" });
  expect(entitlement).toMatchObject({ billing_status: "past_due" });
});

test("Cloudflare Worker creates a WorkOS start redirect only when server secrets exist", async () => {
  const unavailable = await worker.fetch(new Request("https://control.example/auth/workos/start"), { ENVIRONMENT: "development" });
  expect(unavailable.status).toBe(503);

  const configured = await worker.fetch(new Request("https://control.example/auth/workos/start"), { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret" });
  expect(configured.status).toBe(302);
  expect(configured.headers.get("location")).toContain("/user_management/authorize");
  expect(configured.headers.get("set-cookie")).toContain("HttpOnly");
  expect(configured.headers.get("location")).not.toContain("workos_test_secret");
});

test("Cloudflare Worker completes WorkOS session persistence and server-side Stripe checkout", async () => {
  const sessions = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, string>();
  const webhooks = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, Record<string, string>>([["user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" }]]);
  const entitlements = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_sessions")) return (sessions.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_metadata")) return (metadata.has(String(args[0])) ? { value: metadata.get(String(args[0])) } : null) as T | null;
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhooks.has(String(args[0])) ? { event_id: String(args[0]) } : null) as T | null;
          if (query.includes("FROM tinkerbot_memberships")) return (memberships.get(`${String(args[1])}:${String(args[0])}`) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_entitlements")) return (entitlements.get(String(args[0])) ?? null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_sessions")) {
            sessions.set(String(args[0]), { session_id: args[0], user_id: args[1], email: args[2], first_name: args[3], last_name: args[4], email_verified: args[5], organization_id: args[6], expires_at: args[7], authentication_method: args[8], token_ciphertext: args[9] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_sessions")) {
            sessions.delete(String(args[0]));
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_metadata")) {
            metadata.set(String(args[0]), String(args[1]));
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_entitlements")) {
            entitlements.set(String(args[0]), { organization_id: args[0], plan_id: args[1], billing_status: args[2], private_repository_limit: args[3], member_limit: args[4], retention_days: args[5], features_json: args[6], updated_at: args[7] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            if (webhooks.has(String(args[0]))) return { meta: { changes: 0 } };
            webhooks.set(String(args[0]), { event_id: args[0], status: "processing" });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_webhook_events")) {
            const row = webhooks.get(String(args[0]));
            if (row) row.status = "processed";
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.workos.com")) {
      if (url.includes("organization_memberships")) return new Response(JSON.stringify({ data: [{ id: "om_1", user_id: "user_1", organization_id: "org_1", organization_name: "Atlas", status: "active", role: { slug: "owner" }, user: { id: "user_1", email: "alex@example.com", email_verified: true }, updated_at: "2030-01-01T00:00:00.000Z" }], list_metadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ user: { id: "user_1", email: "alex@example.com", email_verified: true }, organization_id: "org_1", access_token: "access_secret", refresh_token: "refresh_secret", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.test/session" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const env = { ENVIRONMENT: "staging", WORKER_NAME: "tinkerbot-staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", STRIPE_SECRET_KEY: "stripe_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_test", SESSION_ENCRYPTION_KEY: "session-encryption-test-key", STRIPE_PLANS_JSON: JSON.stringify([{ id: "developer", monthlyPriceId: "price_month", privateRepositoryLimit: 3, memberLimit: 5, retentionDays: 30, features: { assurance_metadata: true } }]), DB: database };
    const start = await worker.fetch(new Request("https://control.example/auth/workos/start"), env);
    const state = decodeURIComponent(start.headers.get("set-cookie")!.match(/tinkerbot_oauth_state=([^;]+)/)![1]);
    const callback = await worker.fetch(new Request(`https://control.example/auth/workos/callback?code=auth_code&state=${encodeURIComponent(state)}`, { headers: { cookie: `tinkerbot_oauth_state=${encodeURIComponent(state)}` } }), env);
    expect(callback.status).toBe(200);
    expect(await callback.text()).not.toContain("access_secret");
    const sessionId = decodeURIComponent(callback.headers.get("set-cookie")!.match(/tinkerbot_session=([^;]+)/)![1]);

    const session = await worker.fetch(new Request("https://control.example/auth/session", { headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}` } }), env);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, organizationId: "org_1", user: { id: "user_1" } });
    const access = await worker.fetch(new Request("https://control.example/tenant/access", { headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}` } }), env);
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({ authorized: true, organizationId: "org_1", role: "owner" });
    const sync = await worker.fetch(new Request("https://control.example/tenant/membership/sync", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}` } }), env);
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ synchronized: true, authorized: true, organizationId: "org_1", role: "owner" });

    const crossOrigin = await worker.fetch(new Request("https://control.example/billing/checkout", { method: "POST", headers: { origin: "https://attacker.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ planId: "developer", interval: "month" }) }), env);
    expect(crossOrigin.status).toBe(403);

    memberships.set("user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "viewer", status: "active" });
    const insufficientRole = await worker.fetch(new Request("https://control.example/billing/checkout", { method: "POST", headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ planId: "developer", interval: "month" }) }), env);
    expect(insufficientRole.status).toBe(403);
    expect(await insufficientRole.json()).toMatchObject({ code: "insufficient_role" });
    memberships.set("user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" });

    const checkout = await worker.fetch(new Request("https://control.example/billing/checkout", { method: "POST", headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json", "idempotency-key": "checkout_1" }, body: JSON.stringify({ planId: "developer", interval: "month" }) }), env);
    expect(checkout.status).toBe(200);
    expect(await checkout.json()).toEqual({ checkout: { id: "cs_test", url: "https://checkout.stripe.test/session" } });
    expect(JSON.parse(metadata.get("billing:checkout:cs_test")!)).toMatchObject({ organizationId: "org_1", planId: "developer", interval: "month" });

    entitlements.set("org_1", { organization_id: "org_1", plan_id: "developer", billing_status: "active", private_repository_limit: 3, member_limit: 5, retention_days: 30, features_json: JSON.stringify({ assurance_metadata: true }), updated_at: "2030-01-01T00:00:00.000Z" });
    const assurance = { schemaVersion: 1, schemaId: "https://tinkerbot.dev/schemas/assurance/v1", receipts: [], graphs: [], lifecycleEvents: [], agentReceipts: [], changeSets: [], releaseManifests: [], releaseAssessments: [], outcomes: [], decisions: [], bindings: [], calibrationEvents: [], unknowns: ["runtime evidence not connected"] };
    const ingest = await worker.fetch(new Request("https://control.example/assurance/ingest", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ repository: "github.com/acme/service", assurance }) }), env);
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({ ingested: true, sourceUpload: "not_uploaded" });
    const summary = await worker.fetch(new Request("https://control.example/assurance/summary?repository=github.com%2Facme%2Fservice", { headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}` } }), env);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ state: "present", sourceUpload: "not_uploaded" });
    const sourceRejected = await worker.fetch(new Request("https://control.example/assurance/ingest", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ repository: "github.com/acme/service", assurance: { ...assurance, patch: "source must stay local" } }) }), env);
    expect(sourceRejected.status).toBe(400);
    const tooLarge = await worker.fetch(new Request("https://control.example/assurance/ingest", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json", "content-length": "1500001" }, body: "{}" }), env);
    expect(tooLarge.status).toBe(413);
    entitlements.set("org_1", { organization_id: "org_1", plan_id: "developer", billing_status: "canceled", private_repository_limit: 3, member_limit: 5, retention_days: 30, features_json: "{}", updated_at: "2030-01-01T00:00:00.000Z" });
    const canceled = await worker.fetch(new Request("https://control.example/assurance/summary?repository=github.com%2Facme%2Fservice", { headers: { cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}` } }), env);
    expect(canceled.status).toBe(403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare Worker provisions WorkOS memberships from verified, replay-safe events", async () => {
  const webhooks = new Map<string, Record<string, unknown>>();
  const organizations = new Map<string, Record<string, unknown>>();
  const users = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhooks.has(String(args[0])) ? { event_id: String(args[0]) } : null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            if (webhooks.has(String(args[0]))) return { meta: { changes: 0 } };
            webhooks.set(String(args[0]), { event_id: args[0], provider: args[1], status: "processing" });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_webhook_events")) {
            const row = webhooks.get(String(args[0]));
            if (row) row.status = "processed";
          }
          if (query.startsWith("INSERT INTO tinkerbot_organizations")) organizations.set(String(args[0]), { organization_id: args[0], name: args[1], status: args[2], updated_at: args[3] });
          if (query.startsWith("INSERT INTO tinkerbot_users")) users.set(String(args[0]), { user_id: args[0], email: args[1], first_name: args[2], last_name: args[3], updated_at: args[4] });
          if (query.startsWith("INSERT INTO tinkerbot_memberships")) memberships.set(`${String(args[0])}:${String(args[1])}`, { organization_id: args[0], user_id: args[1], role: args[2], status: args[3], updated_at: args[4] });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const payload = JSON.stringify({ id: "workos_event_1", event: "organization_membership.created", created_at: "2030-01-01T00:00:00.000Z", data: { id: "om_1", user_id: "user_1", organization_id: "org_1", organization_name: "Atlas", status: "active", role: { slug: "member" }, user: { id: "user_1", email: "alex@example.com", first_name: "Alex" }, updated_at: "2030-01-01T00:00:00.000Z" } });
  const timestamp = Date.now();
  const signature = createHmac("sha256", "workos_webhook_secret").update(`${timestamp}.${payload}`).digest("hex");
  const env = { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", WORKOS_WEBHOOK_SECRET: "workos_webhook_secret", DB: database };
  const headers = { "workos-signature": `t=${timestamp},v1=${signature}` };
  const first = await worker.fetch(new Request("https://control.example/integrations/workos/webhook", { method: "POST", headers, body: payload }), env);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ received: true, duplicate: false });
  expect(organizations.get("org_1")).toMatchObject({ name: "Atlas", status: "active" });
  expect(users.get("user_1")).toMatchObject({ email: "alex@example.com" });
  expect(memberships.get("org_1:user_1")).toMatchObject({ role: "viewer", status: "active" });

  const duplicate = await worker.fetch(new Request("https://control.example/integrations/workos/webhook", { method: "POST", headers, body: payload }), env);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({ received: true, duplicate: true });

  const deletedPayload = JSON.stringify({ id: "workos_event_2", event: "organization.deleted", created_at: "2030-01-02T00:00:00.000Z", data: { id: "org_1", name: "Atlas", updated_at: "2030-01-02T00:00:00.000Z" } });
  const deletedTimestamp = Date.now();
  const deletedSignature = createHmac("sha256", "workos_webhook_secret").update(`${deletedTimestamp}.${deletedPayload}`).digest("hex");
  const deleted = await worker.fetch(new Request("https://control.example/integrations/workos/webhook", { method: "POST", headers: { "workos-signature": `t=${deletedTimestamp},v1=${deletedSignature}` }, body: deletedPayload }), env);
  expect(deleted.status).toBe(200);
  expect(organizations.get("org_1")).toMatchObject({ status: "inactive" });

  const invalid = await worker.fetch(new Request("https://control.example/integrations/workos/webhook", { method: "POST", headers: { "workos-signature": `t=${timestamp},v1=invalid` }, body: payload }), env);
  expect(invalid.status).toBe(502);
  expect(await invalid.json()).toMatchObject({ code: "invalid_webhook_signature" });
});

test("Cloudflare Worker replays bounded WorkOS Events API pages from a D1 cursor", async () => {
  const metadata = new Map<string, string>();
  const webhooks = new Map<string, Record<string, unknown>>();
  const organizations = new Map<string, Record<string, unknown>>();
  const memberships = new Map<string, Record<string, unknown>>();
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_metadata")) return (metadata.has(String(args[0])) ? { value: metadata.get(String(args[0])) } : null) as T | null;
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhooks.has(String(args[0])) ? { event_id: String(args[0]) } : null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_metadata")) metadata.set(String(args[0]), String(args[1]));
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            if (webhooks.has(String(args[0]))) return { meta: { changes: 0 } };
            webhooks.set(String(args[0]), { event_id: args[0], provider: args[1], status: "processing" });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_webhook_events")) {
            const row = webhooks.get(String(args[0]));
            if (row) row.status = "processed";
          }
          if (query.startsWith("INSERT INTO tinkerbot_organizations")) {
            const existing = organizations.get(String(args[0]));
            organizations.set(String(args[0]), { organization_id: args[0], name: String(args[1]) === String(args[0]) && existing ? existing.name : args[1], status: args[2] });
          }
          if (query.startsWith("INSERT INTO tinkerbot_memberships")) memberships.set(`${String(args[0])}:${String(args[1])}`, { organization_id: args[0], user_id: args[1], role: args[2], status: args[3] });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const after = new URL(url).searchParams.get("after");
    if (!after) return new Response(JSON.stringify({ data: [{ id: "event_1", event: "organization.created", created_at: "2030-01-01T00:00:00.000Z", data: { id: "org_1", name: "Atlas", updated_at: "2030-01-01T00:00:00.000Z" } }], list_metadata: { after: "event_1" } }), { status: 200 });
    if (after === "event_1") return new Response(JSON.stringify({ data: [{ id: "event_2", event: "organization_membership.created", created_at: "2030-01-01T00:01:00.000Z", data: { id: "om_1", user_id: "user_1", organization_id: "org_1", status: "active", role: { slug: "member" }, updated_at: "2030-01-01T00:01:00.000Z" } }], list_metadata: { after: "event_2" } }), { status: 200 });
    return new Response(JSON.stringify({ data: [], list_metadata: {} }), { status: 200 });
  };
  try {
    await worker.scheduled({ cron: "*/15 * * * *" }, { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", WORKOS_EVENTS_SYNC_ENABLED: "true", WORKOS_EVENTS_RANGE_START: "2030-01-01T00:00:00.000Z", DB: database });
    expect(JSON.parse(metadata.get("workos:events:cursor")!)).toBe("event_2");
    expect(organizations.get("org_1")).toMatchObject({ name: "Atlas", status: "active" });
    expect(memberships.get("org_1:user_1")).toMatchObject({ role: "viewer", status: "active" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare Worker enforces invitation entitlements before calling WorkOS", async () => {
  const sessions = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, string>();
  const invitations = new Map<string, Record<string, unknown>>();
  const entitlements = new Map<string, Record<string, unknown>>([
    ["org_1", { organization_id: "org_1", plan_id: "team", billing_status: "active", private_repository_limit: 10, member_limit: 5, retention_days: 30, features_json: JSON.stringify({ team_invitations: true }), updated_at: "2030-01-01T00:00:00.000Z" }],
  ]);
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_sessions")) return (sessions.get(String(args[0])) ?? null) as T | null;
          if (query.includes("COUNT(*) AS count")) return { count: 1 } as T;
          if (query.includes("FROM tinkerbot_memberships")) return { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" } as T;
          if (query.includes("FROM tinkerbot_entitlements")) return (entitlements.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_invitations")) return (invitations.get(`${String(args[0])}:${String(args[1])}`) ?? null) as T | null;
          return null;
        },
        run: async () => {
          if (query.startsWith("INSERT INTO tinkerbot_sessions")) sessions.set(String(args[0]), { session_id: args[0], user_id: args[1], email: args[2], first_name: args[3], last_name: args[4], email_verified: args[5], organization_id: args[6], expires_at: args[7], authentication_method: args[8], token_ciphertext: args[9] });
          if (query.startsWith("INSERT INTO tinkerbot_invitations")) invitations.set(`${String(args[1])}:${String(args[2])}`, { invitation_id: args[0], organization_id: args[1], email: args[2], role: args[3], state: args[4], provider_invitation_id: args[5], inviter_user_id: args[6], accepted_user_id: args[7], expires_at: args[8], created_at: args[9], updated_at: args[10] });
          if (query.startsWith("INSERT INTO tinkerbot_metadata")) metadata.set(String(args[0]), String(args[1]));
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/authenticate")) return new Response(JSON.stringify({ user: { id: "user_1", email: "owner@example.com" }, organization_id: "org_1", access_token: "access_secret", refresh_token: "refresh_secret", expires_in: 3600 }), { status: 200 });
    if (path.endsWith("/invitations")) return new Response(JSON.stringify({ id: "invitation_1", email: "invitee@example.com", organization_id: "org_1", state: "pending", role_slug: "viewer", inviter_user_id: "user_1", expires_at: "2030-01-08T00:00:00.000Z", created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:00.000Z", token: "secret-token" }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    const env = { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", SESSION_ENCRYPTION_KEY: "session-encryption-test-key", DB: database };
    const start = await worker.fetch(new Request("https://control.example/auth/workos/start"), env);
    const state = decodeURIComponent(start.headers.get("set-cookie")!.match(/tinkerbot_oauth_state=([^;]+)/)![1]);
    const callback = await worker.fetch(new Request(`https://control.example/auth/workos/callback?code=auth_code&state=${encodeURIComponent(state)}`, { headers: { cookie: `tinkerbot_oauth_state=${encodeURIComponent(state)}` } }), env);
    const sessionId = decodeURIComponent(callback.headers.get("set-cookie")!.match(/tinkerbot_session=([^;]+)/)![1]);
    const invitation = await worker.fetch(new Request("https://control.example/tenant/invitations", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ email: "invitee@example.com", role: "viewer" }) }), env);
    expect(invitation.status).toBe(201);
    const invitationBody = await invitation.json() as Record<string, unknown>;
    expect(invitationBody).toMatchObject({ sent: true, invitation: { invitationId: "invitation_1", role: "viewer", state: "pending" } });
    expect(JSON.stringify(invitationBody)).not.toContain("secret-token");

    entitlements.set("org_1", { ...entitlements.get("org_1"), features_json: JSON.stringify({ team_invitations: false }) });
    const denied = await worker.fetch(new Request("https://control.example/tenant/invitations", { method: "POST", headers: { origin: "https://control.example", cookie: `tinkerbot_session=${encodeURIComponent(sessionId)}`, "content-type": "application/json" }, body: JSON.stringify({ email: "another@example.com", role: "viewer" }) }), env);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "entitlement_required", feature: "team_invitations" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
