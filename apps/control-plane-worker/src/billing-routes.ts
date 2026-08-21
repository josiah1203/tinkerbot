import {
  D1BillingStore,
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  StripeBillingProvider,
  hostedProviderConfig,
  type D1AuthSessionStore,
  type D1DatabaseLike,
  type HostedProviderConfig,
  type HostedSession,
  type TenantEntitlement,
  type TenantMembership,
} from "../../../packages/hosted-integrations/src";
import { D1FactoryStore } from "./factory-store";
import {
  applyStripeEvent,
  checkoutPlanAllowed,
  entitlementsForOrganization,
  expireTrials,
  productionCatalogUnavailable,
  publicCatalogResponse,
  recordBillingAudit,
  startTeamTrial,
  syncStripeQuantity,
  type CheckoutMapping,
} from "./billing";

export interface BillingRouteEnv extends Record<string, unknown> {
  DB?: D1DatabaseLike;
  ENVIRONMENT?: string;
}

export interface BillingAuthorizedSession {
  ok: true;
  current: { id: string; session: HostedSession };
  membership: TenantMembership;
  entitlements: TenantEntitlement | null;
}

export interface BillingAuthorizationFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type BillingAuthorizationResult = BillingAuthorizedSession | BillingAuthorizationFailure;

export async function reconcileBilling(env: BillingRouteEnv): Promise<void> {
  if (!env.DB) return;
  const now = new Date().toISOString();
  await expireTrials(env.DB, now);
  const metadata = new D1JsonMetadataStore(env.DB);
  await metadata.put("billing:reconcile:last", { at: now, catalogVersion: "2026-08-18.seat-v1" });
  const config = await hostedProviderConfig(env);
  if (!config.stripe.secretKey || config.stripe.plans.length === 0) return;
  const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, plans: config.stripe.plans });
  const statement = env.DB.prepare("SELECT organization_id FROM tinkerbot_billing_accounts WHERE stripe_subscription_id IS NOT NULL AND subscription_status NOT IN ('canceled', 'deleted', 'free')").bind();
  const rows = typeof statement.all === "function" ? ((await statement.all())?.results ?? []) as Array<{ organization_id: string }> : [];
  for (const row of rows) {
    const result = await syncStripeQuantity({ database: env.DB, provider, organizationId: row.organization_id });
    await env.DB.prepare("INSERT INTO tinkerbot_reconciliation_runs (run_id, organization_id, status, expected_quantity, actual_quantity, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(crypto.randomUUID(), row.organization_id, result.pending ? "pending" : "ok", result.expected, result.expected, result.pending ? "provider_update_pending" : "quantity_synced", now).run();
  }
}

export interface BillingRouteDependencies {
  json(value: unknown, status?: number, headers?: HeadersInit): Response;
  readBodyText(request: Request, maxBytes: number): Promise<string>;
  jsonBody(request: Request, maxBytes?: number): Promise<Record<string, unknown> | null>;
  sessionStore(env: BillingRouteEnv, config: HostedProviderConfig): D1AuthSessionStore | null;
  currentSession(request: Request, store: D1AuthSessionStore, env?: BillingRouteEnv): Promise<{ id: string; session: HostedSession } | null>;
  authorizeTenantSession(current: { id: string; session: HostedSession } | null, tenants: D1TenantStore, requiredCapability?: "billing:read" | "billing:manage"): Promise<BillingAuthorizationResult>;
  originAllowed(request: Request, env: BillingRouteEnv): boolean;
  safeReturnUrl(value: unknown, request: Request, env: BillingRouteEnv, path: string): string;
}

/**
 * Billing routes own provider/account state only. They deliberately do not
 * receive Factory command or transition functions; lifecycle mutations remain
 * behind the Foreman boundary in the Worker runtime.
 */
export async function handleBillingRoute(request: Request, env: BillingRouteEnv, config: HostedProviderConfig, dependencies: BillingRouteDependencies): Promise<Response | undefined> {
  const { json, readBodyText, jsonBody, sessionStore, currentSession, authorizeTenantSession, originAllowed, safeReturnUrl } = dependencies;
  const url = new URL(request.url);

  if (request.method === "POST" && (url.pathname === "/billing/webhook" || url.pathname === "/webhooks/stripe")) {
    if (!env.DB) return json({ error: "Stripe webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
    const payload = await readBodyText(request, 2_000_000);
    const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret });
    const ledger = new D1WebhookLedger(env.DB);
    const metadata = new D1JsonMetadataStore(env.DB);
    const tenants = new D1TenantStore(env.DB);
    const result = await provider.handleWebhook(payload, request.headers.get("stripe-signature"), ledger, (event) => applyStripeEvent(event, metadata, new D1BillingStore(env.DB!), tenants, config.stripe.plans, env.DB));
    return json({ received: true, duplicate: result.duplicate });
  }

  if (url.pathname === "/billing/catalog" && request.method === "GET") return json(publicCatalogResponse());
  if (!env.DB) return undefined;

  if (url.pathname === "/billing/summary" && request.method === "GET") {
    const store = sessionStore(env, config);
    const database = env.DB;
    if (!store) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "billing:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const account = await new D1BillingStore(database).getByOrganization(access.membership.organizationId);
    const calculated = await entitlementsForOrganization(database, access.membership.organizationId, access.entitlements);
    const seats = await new D1TenantStore(database).countSeatUsage(access.membership.organizationId);
    const catalog = publicCatalogResponse();
    const plan = calculated.planId === "developer" || calculated.planId === "team" || calculated.planId === "business" ? catalog.plans.find((item) => item.id === calculated.planId) : catalog.plans.find((item) => item.id === "free");
    return json({
      authorized: true,
      organizationId: access.membership.organizationId,
      catalogVersion: calculated.catalogVersion,
      planId: calculated.planId,
      interval: account?.interval ?? null,
      pricePerSeatCents: account?.interval === "year" ? plan?.annualPriceCents ?? null : plan?.monthlyPriceCents ?? 0,
      subscriptionState: calculated.billingStatus,
      activeBillableSeats: seats,
      paidSeatCap: plan?.paidSeatCap ?? "none",
      trialState: calculated.trialState ?? null,
      trialEndsAt: calculated.trialEndsAt ?? null,
      cancellation: { cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false, currentPeriodEnd: account?.currentPeriodEnd ?? null },
      paymentState: account?.status ?? "free",
      entitlements: calculated.features,
      limited: calculated.limited,
    });
  }

  if (url.pathname === "/org/seats" && request.method === "GET") {
    const store = sessionStore(env, config);
    if (!store) return json({ error: "Seat listing requires the D1 session store.", code: "billing_contract_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "billing:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    return json({ authorized: true, organizationId: access.membership.organizationId, activeBillableSeats: await new D1TenantStore(env.DB).countSeatUsage(access.membership.organizationId) });
  }

  const mutationPaths = ["/billing/checkout", "/billing/portal", "/billing/subscription/cancel", "/billing/subscription/reactivate", "/billing/subscription/change", "/billing/trial/start", "/billing/reconcile"];
  if (!mutationPaths.includes(url.pathname) || request.method !== "POST") return undefined;
  if (!originAllowed(request, env)) return json({ error: "Cross-origin billing mutation rejected.", code: "csrf_origin_rejected" }, 403);
  const store = sessionStore(env, config);
  if (!store) return json({ error: "Billing requires the D1 session store, membership store, and session encryption secret.", code: "billing_contract_not_configured" }, 501);
  const database = env.DB;
  const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "billing:manage");
  if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
  const organizationId = access.membership.organizationId;
  if (productionCatalogUnavailable(env.ENVIRONMENT, config.stripe.plans) && url.pathname !== "/billing/trial/start") return json({ error: "The production Stripe catalog is not configured.", code: "catalog_unavailable" }, 503);
  const billing = new D1BillingStore(database);
  const billingState = await billing.getByOrganization(organizationId);
  const provider = new StripeBillingProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, plans: config.stripe.plans });
  const body = await jsonBody(request);

  if (url.pathname === "/billing/trial/start") {
    const trial = await startTeamTrial(database, organizationId, access.current.session.user.id);
    if (!trial.ok) return json({ error: trial.error, code: trial.code }, 409);
    return json({ pending: false, trial: { state: "trialing", endsAt: trial.endsAt }, grantedFromRedirect: false });
  }
  if (url.pathname === "/billing/reconcile") {
    const result = await syncStripeQuantity({ database, provider, organizationId });
    await recordBillingAudit(database, { organizationId, actorId: access.current.session.user.id, action: "reconcile", payload: result });
    return json({ pending: Boolean(result.pending), expectedQuantity: result.expected });
  }
  if (!body && url.pathname !== "/billing/portal" && url.pathname !== "/billing/subscription/cancel" && url.pathname !== "/billing/subscription/reactivate") return json({ error: "A JSON request body is required.", code: "invalid_request" }, 400);

  if (url.pathname === "/billing/checkout") {
    const allowed = checkoutPlanAllowed(typeof body?.planId === "string" ? body.planId : "", body?.interval === "year" ? "year" : body?.interval === "month" ? "month" : "", config.stripe.plans);
    if (!allowed) return json({ error: "planId and interval must match the server catalog.", code: "invalid_billing_request" }, 400);
    if (["priceId", "quantity", "organizationId", "entitlements"].some((field) => Object.prototype.hasOwnProperty.call(body ?? {}, field))) return json({ error: "Client-submitted price, quantity, organization, and entitlement fields are ignored. Use planId and interval only.", code: "invalid_billing_request" }, 400);
    if (billingState?.subscriptionId && !["canceled", "cancelled", "incomplete_expired", "free"].includes(billingState.status)) return json({ error: "This organization already has a subscription. Change it in-app or in the billing portal instead.", code: "subscription_already_exists" }, 409);
    const requestKey = request.headers.get("idempotency-key")?.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120) || crypto.randomUUID();
    const seatQuantity = await new D1TenantStore(database).countSeatUsage(organizationId);
    await new D1FactoryStore(database).putSeatLedger(organizationId, new Date().toISOString().slice(0, 7), seatQuantity, new Date().toISOString());
    const checkout = await provider.createCheckoutSession({ planId: allowed.planId, interval: allowed.interval, organizationId, successUrl: safeReturnUrl(body?.successUrl, request, env, "/app/settings/billing"), cancelUrl: safeReturnUrl(body?.cancelUrl, request, env, "/app/settings/billing"), customerId: billingState?.customerId, customerEmail: access.current.session.user.email, seatQuantity, idempotencyKey: `checkout:${organizationId}:${allowed.planId}:${allowed.interval}:${requestKey}` });
    await new D1JsonMetadataStore(database).put(`billing:checkout:${checkout.id}`, { organizationId, planId: allowed.planId, interval: allowed.interval, createdAt: new Date().toISOString() } satisfies CheckoutMapping);
    await database.prepare("INSERT INTO tinkerbot_checkout_sessions (checkout_session_id, organization_id, plan_id, billing_interval, seat_quantity, idempotency_key, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)").bind(checkout.id, organizationId, allowed.planId, allowed.interval, seatQuantity, requestKey, new Date().toISOString()).run();
    return json({ pending: true, checkout, grantedFromRedirect: false });
  }
  if (url.pathname === "/billing/portal") {
    if (!billingState?.customerId) return json({ error: "No billing customer is associated with this organization yet.", code: "billing_customer_missing" }, 409);
    const portal = await provider.createPortalSession({ customerId: billingState.customerId, returnUrl: safeReturnUrl(body?.returnUrl, request, env, "/app/settings/billing"), idempotencyKey: `portal:${organizationId}:${crypto.randomUUID()}` });
    return json({ portal });
  }
  if (url.pathname === "/billing/subscription/change") {
    if (!billingState?.subscriptionId) return json({ error: "No active subscription is associated with this organization.", code: "billing_subscription_missing" }, 409);
    const allowed = checkoutPlanAllowed(typeof body?.planId === "string" ? body.planId : "", body?.interval === "year" ? "year" : body?.interval === "month" ? "month" : billingState.interval ?? "month", config.stripe.plans);
    if (!allowed) return json({ error: "planId and interval must match the server catalog.", code: "invalid_billing_request" }, 400);
    const currentRank = { developer: 1, team: 2, business: 3, free: 0, enterprise: 4 };
    const upgrade = currentRank[allowed.planId] >= currentRank[(billingState.planId as keyof typeof currentRank) ?? "developer"] && !(billingState.interval === "year" && allowed.interval === "month");
    const priceId = allowed.interval === "year" ? allowed.stripe.annualPriceId : allowed.stripe.monthlyPriceId;
    if (!priceId) return json({ error: "The requested interval is not configured.", code: "price_not_configured" }, 409);
    const quantity = await new D1TenantStore(database).countSeatUsage(organizationId);
    const changed = await provider.changeSubscriptionPrice({ subscriptionId: billingState.subscriptionId, priceId, quantity, prorationBehavior: upgrade ? "create_prorations" : "none", idempotencyKey: `change:${organizationId}:${allowed.planId}:${allowed.interval}` });
    await recordBillingAudit(database, { organizationId, actorId: access.current.session.user.id, action: "subscription_change", payload: { planId: allowed.planId, interval: allowed.interval, upgrade } });
    return json({ pending: true, subscription: changed, effective: upgrade ? "immediate" : "period_end" });
  }
  if (!billingState?.subscriptionId) return json({ error: "No active subscription is associated with this organization.", code: "billing_subscription_missing" }, 409);
  const cancelAtPeriodEnd = url.pathname === "/billing/subscription/cancel";
  const subscription = await provider.setSubscriptionCancellation({ subscriptionId: billingState.subscriptionId, cancelAtPeriodEnd, idempotencyKey: `${cancelAtPeriodEnd ? "cancel" : "reactivate"}:${organizationId}:${billingState.subscriptionId}` });
  return json({ pending: true, subscription });
}
