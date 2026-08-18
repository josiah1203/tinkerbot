import { Buffer } from "node:buffer";

const workerUrl = process.env.TINKERBOT_WORKER_URL?.trim();
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

const checks = [];
const missing = [];
for (const [name, value] of [
  ["TINKERBOT_WORKER_URL", workerUrl],
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
  const response = await fetch(url, init);
  const text = await response.text();
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
  let value;
  try {
    value = JSON.parse(stripePlansRaw ?? "");
  } catch {
    throw new Error("STRIPE_PLANS_JSON is not valid JSON.");
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error("STRIPE_PLANS_JSON must contain at least one plan.");
  const prices = [];
  for (const plan of value) {
    if (!plan || typeof plan !== "object" || typeof plan.id !== "string" || !plan.id) throw new Error("Every Stripe plan must have an id.");
    for (const key of ["privateRepositoryLimit", "memberLimit", "retentionDays"]) {
      if (!Number.isSafeInteger(plan[key]) || plan[key] < 0) throw new Error(`Stripe plan ${plan.id} has an invalid ${key}.`);
    }
    if (!plan.features || typeof plan.features !== "object" || Array.isArray(plan.features) || Object.values(plan.features).some((value) => typeof value !== "boolean")) throw new Error(`Stripe plan ${plan.id} must contain an explicit boolean features map.`);
    for (const key of ["monthlyPriceId", "annualPriceId"]) {
      if (plan[key] !== undefined) {
        if (typeof plan[key] !== "string" || !plan[key]) throw new Error(`Stripe plan ${plan.id} has an invalid ${key}.`);
        prices.push({ planId: plan.id, priceId: plan[key] });
      }
    }
    if (typeof plan.monthlyPriceId !== "string" || !plan.monthlyPriceId) throw new Error(`Stripe plan ${plan.id} is missing monthlyPriceId.`);
  }
  return { planCount: value.length, prices };
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
      const body = await jsonFetch(url, { headers: { accept: "application/json" } }, "Worker config status");
      const providers = Object.fromEntries((Array.isArray(body.providers) ? body.providers : []).map((item) => [item.provider, item]));
      const unavailable = ["workos", "stripe", "cloudflare"].filter((provider) => providers[provider]?.state !== "configured");
      const resources = body.resources && typeof body.resources === "object" ? body.resources : {};
      if (body.service !== "tinkerbot-control-plane" || unavailable.length > 0) throw new Error(`Worker provider configuration is incomplete: ${unavailable.join(", ") || "service identity"}.`);
      if (resources.d1 !== true || !Number.isInteger(resources.stripePlanCount) || resources.stripePlanCount < 1 || (requireR2 && resources.r2 !== true)) throw new Error("Worker storage or plan-catalog bindings are incomplete.");
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
      for (const { planId, priceId } of catalog.prices) {
        const price = await jsonFetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, { headers: stripeHeaders() }, `Stripe price ${planId}`);
        if (price.id !== priceId || price.active !== true || price.livemode !== account.livemode) throw new Error(`Stripe price for plan ${planId} is inactive, mismatched, or in the wrong mode.`);
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
