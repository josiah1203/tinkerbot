import { Buffer } from "node:buffer";

const workerUrl = process.env.TINKERBOT_WORKER_URL?.trim();
const opsSession = process.env.TINKERBOT_OPS_SESSION?.trim();
const workosApiKey = process.env.WORKOS_API_KEY?.trim();
const workosWebhookUrl = process.env.WORKOS_WEBHOOK_URL?.trim();
const replayStart = process.env.WORKOS_EVENTS_RANGE_START?.trim();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
const stripePlansRaw = process.env.STRIPE_PLANS_JSON?.trim();
const stripeWebhookUrl = process.env.STRIPE_WEBHOOK_URL?.trim();
const requireR2 = process.env.REQUIRE_R2 === "true";

const requiredWorkosEvents = [
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

const requiredStripeEvents = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
];

// Keep the provider-side catalog aligned with the source entitlement catalog.
// Price IDs are deployment inputs, but amounts, currency, and billing unit are
// product invariants and should fail closed if an operator points at the wrong
// Stripe Price.
const expectedStripePriceCents = Object.freeze({
  developer: Object.freeze({ month: 2_000, year: 20_000 }),
  team: Object.freeze({ month: 4_000, year: 40_000 }),
  business: Object.freeze({ month: 6_000, year: 60_000 }),
});

const checks = [];
const missing = [];
for (const [name, value] of [
  ["TINKERBOT_WORKER_URL", workerUrl],
  ["TINKERBOT_OPS_SESSION", opsSession],
  ["WORKOS_API_KEY", workosApiKey],
  ["WORKOS_WEBHOOK_URL", workosWebhookUrl],
  ["WORKOS_EVENTS_RANGE_START", replayStart],
  ["STRIPE_SECRET_KEY", stripeSecretKey],
  ["STRIPE_PLANS_JSON", stripePlansRaw],
  ["STRIPE_WEBHOOK_URL", stripeWebhookUrl],
]) {
  if (!value) missing.push(name);
}

function record(name, ok, details = {}) {
  checks.push({ name, ok, ...details });
}

async function jsonFetch(url, init = {}, label) {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error(`${label} returned an oversized response.`);
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return body;
}

function workosHeaders() {
  return { accept: "application/json", authorization: `Bearer ${workosApiKey}` };
}

function stripeHeaders() {
  const token = Buffer.from(`${stripeSecretKey}:`, "utf8").toString("base64");
  return { accept: "application/json", authorization: `Basic ${token}` };
}

function parsePlans() {
  if (typeof stripePlansRaw !== "string" || stripePlansRaw.length > 1_000_000) throw new Error("STRIPE_PLANS_JSON exceeds the 1 MB configuration limit.");
  let value;
  try {
    value = JSON.parse(stripePlansRaw ?? "");
  } catch {
    throw new Error("STRIPE_PLANS_JSON is not valid JSON.");
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error("STRIPE_PLANS_JSON must contain at least one plan.");
  if (value.length !== 3) throw new Error("STRIPE_PLANS_JSON must contain exactly developer, team, and business plans.");
  const ids = new Set();
  const priceIds = new Set();
  const versions = new Set();
  const prices = [];
  const allowedFields = new Set(["id", "monthlyPriceId", "annualPriceId", "catalogVersion"]);
  for (const plan of value) {
    if (!plan || typeof plan !== "object" || typeof plan.id !== "string" || !plan.id) throw new Error("Every Stripe plan must have an id.");
    for (const key of Object.keys(plan)) if (!allowedFields.has(key)) throw new Error(`Stripe plan ${plan.id} contains unsupported field ${key}.`);
    for (const key of ["memberLimit", "seatLimit", "privateRepositoryLimit", "repositoryLimit", "additionalRepositoryPrice", "perRepositoryPrice", "perRunPrice", "perTokenPrice", "factoryLimit"]) {
      if (Object.prototype.hasOwnProperty.call(plan, key)) throw new Error(`Stripe plan ${plan.id} must not include ${key}. Seat-only catalogs omit paid caps.`);
    }
    if (!["developer", "team", "business"].includes(plan.id)) throw new Error(`Stripe plan ${plan.id} is not in the seat catalog.`);
    if (ids.has(plan.id)) throw new Error(`Duplicate Stripe plan ${plan.id}.`);
    ids.add(plan.id);
    if (typeof plan.catalogVersion !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(plan.catalogVersion)) throw new Error(`Stripe plan ${plan.id} has an invalid catalogVersion.`);
    versions.add(plan.catalogVersion);
    for (const key of ["monthlyPriceId", "annualPriceId"]) {
      if (typeof plan[key] !== "string" || !/^price_[A-Za-z0-9]+$/.test(plan[key]) || String(plan[key]).includes("REPLACE")) throw new Error(`Stripe plan ${plan.id} has an invalid ${key}.`);
      if (priceIds.has(plan[key])) throw new Error(`Stripe price ${plan[key]} is reused.`);
      priceIds.add(plan[key]);
      prices.push({ planId: plan.id, priceId: plan[key], interval: key === "annualPriceId" ? "year" : "month" });
    }
  }
  if (versions.size !== 1) throw new Error("Stripe plans must share one catalogVersion.");
  for (const id of ["developer", "team", "business"]) if (!ids.has(id)) throw new Error(`Stripe catalog is missing ${id}.`);
  return { planCount: value.length, prices, catalogVersion: [...versions][0] };
}

async function run() {
  if (missing.length > 0) {
    console.log(JSON.stringify({ ok: false, missing, checks: [] }));
    process.exitCode = 1;
    return;
  }

  await (async () => {
    try {
      const url = new URL("/config/status", workerUrl);
      const body = await jsonFetch(url, { headers: { accept: "application/json", authorization: `Bearer ${opsSession}`, cookie: `tinkerbot_session=${encodeURIComponent(opsSession)}` } }, "Worker config status");
      const providers = Object.fromEntries((Array.isArray(body.providers) ? body.providers : []).map((item) => [item.provider, item]));
      const unavailable = ["workos", "stripe", "cloudflare"].filter((provider) => providers[provider]?.state !== "configured");
      const resources = body.resources && typeof body.resources === "object" ? body.resources : {};
      if (body.service !== "tinkerbot-control-plane" || unavailable.length > 0) throw new Error(`Worker provider configuration is incomplete: ${unavailable.join(", ") || "service identity"}.`);
      if (resources.d1 !== true || resources.sessionEncryption !== true || !Number.isInteger(resources.stripePlanCount) || resources.stripePlanCount < 1 || (requireR2 && resources.r2 !== true)) throw new Error("Worker storage, session encryption, or plan-catalog bindings are incomplete.");
      record("worker_config", true, { environment: body.environment, providers: Object.keys(providers), resources });
    } catch (error) {
      record("worker_config", false, { error: error instanceof Error ? error.message : "request failed" });
    }
  })();

  await (async () => {
    try {
      const url = new URL("/webhook_endpoints?limit=100&order=desc", "https://api.workos.com");
      const body = await jsonFetch(url, { headers: workosHeaders() }, "WorkOS webhook listing");
      const endpoint = Array.isArray(body.data) ? body.data.find((item) => item?.endpoint_url === workosWebhookUrl) : undefined;
      if (!endpoint) throw new Error("Configured WorkOS webhook endpoint was not found.");
      const registered = Array.isArray(endpoint.events) ? endpoint.events : [];
      const absent = requiredWorkosEvents.filter((event) => !registered.includes(event));
      if (endpoint.status !== "enabled" || absent.length > 0) throw new Error(`WorkOS webhook is not ready${absent.length ? `; missing ${absent.length} event types` : "."}`);
      record("workos_webhook", true, { status: endpoint.status, eventCount: registered.length });
    } catch (error) {
      record("workos_webhook", false, { error: error instanceof Error ? error.message : "request failed" });
    }
  })();

  await (async () => {
    try {
      const url = new URL("/events", "https://api.workos.com");
      url.searchParams.set("limit", "1");
      url.searchParams.set("range_start", replayStart);
      for (const event of requiredWorkosEvents) url.searchParams.append("events[]", event);
      const body = await jsonFetch(url, { headers: workosHeaders() }, "WorkOS Events API");
      if (!Array.isArray(body.data)) throw new Error("WorkOS returned an invalid Events API response.");
      record("workos_events", true, { rangeStart: replayStart, sampledEvents: body.data.length });
    } catch (error) {
      record("workos_events", false, { error: error instanceof Error ? error.message : "request failed" });
    }
  })();

  await (async () => {
    try {
      const account = await jsonFetch("https://api.stripe.com/v1/account", { headers: stripeHeaders() }, "Stripe account");
      const catalog = parsePlans();
      for (const { planId, priceId, interval } of catalog.prices) {
        const price = await jsonFetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, { headers: stripeHeaders() }, `Stripe price ${planId}`);
        const recurring = price.recurring && typeof price.recurring === "object" ? price.recurring : {};
        const amount = typeof price.unit_amount === "number" ? price.unit_amount : 0;
        const expectedAmount = expectedStripePriceCents[planId]?.[interval];
        if (price.id !== priceId || price.active !== true || price.livemode !== account.livemode || price.type !== "recurring" || price.currency !== "usd" || price.billing_scheme !== "per_unit" || price.transform_quantity != null || recurring.usage_type !== "licensed" || amount !== expectedAmount || recurring.interval !== interval || (interval === "year" && recurring.interval_count !== 1) || (interval === "month" && recurring.interval_count !== 1)) {
          throw new Error(`Stripe price for plan ${planId} is inactive, mismatched, metered, transformed, or not ${expectedAmount} cents per licensed seat for ${interval} billing.`);
        }
      }
      record("stripe_catalog", true, { livemode: account.livemode === true, planCount: catalog.planCount, priceCount: catalog.prices.length });
    } catch (error) {
      record("stripe_catalog", false, { error: error instanceof Error ? error.message : "request failed" });
    }
  })();

  await (async () => {
    try {
      const body = await jsonFetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: stripeHeaders() }, "Stripe webhook listing");
      const endpoint = Array.isArray(body.data) ? body.data.find((item) => item?.url === stripeWebhookUrl) : undefined;
      if (!endpoint) throw new Error("Configured Stripe webhook endpoint was not found.");
      const enabledEvents = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : [];
      const receivesAll = enabledEvents.includes("*");
      const absent = receivesAll ? [] : requiredStripeEvents.filter((event) => !enabledEvents.includes(event));
      if (endpoint.status !== "enabled" || absent.length > 0) throw new Error(`Stripe webhook is not ready${absent.length ? `; missing ${absent.length} event types` : "."}`);
      record("stripe_webhook", true, { status: endpoint.status, eventCount: enabledEvents.length });
    } catch (error) {
      record("stripe_webhook", false, { error: error instanceof Error ? error.message : "request failed" });
    }
  })();

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, checks }));
  if (!ok) process.exitCode = 1;
}

await run();
