import {
  BILLING_CATALOG_VERSION,
  BILLING_POLICY,
  calculateEntitlements,
  isPlanId,
  publicBillingCatalog,
  type CalculatedEntitlements,
  type EntitlementKey,
  type PlanId,
  type TrialState,
} from "../../../packages/control-plane/src";
import {
  D1BillingStore,
  D1DatabaseLike,
  D1JsonMetadataStore,
  D1TenantStore,
  ProviderError,
  StripeBillingProvider,
  StripePlan,
  stripeCatalogComplete,
  StripeWebhookEvent,
  TenantBillingAccount,
  TenantEntitlement,
} from "../../../packages/hosted-integrations/src";

export const STRIPE_BILLING_EVENTS = new Set([
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
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

export interface CheckoutMapping {
  organizationId: string;
  planId: string;
  interval: "month" | "year";
  createdAt: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stripePriceIds(object: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const items = recordValue(object.items);
  const data = Array.isArray(items.data) ? items.data : [];
  for (const item of data) {
    const row = recordValue(item);
    const price = recordValue(row.price);
    if (typeof price.id === "string") ids.push(price.id);
  }
  const lineItems = recordValue(object.lines);
  const lines = Array.isArray(lineItems.data) ? lineItems.data : [];
  for (const item of lines) {
    const row = recordValue(item);
    const price = recordValue(row.price);
    if (typeof price.id === "string") ids.push(price.id);
  }
  if (typeof object.price === "string") ids.push(object.price);
  return ids;
}

function stripeSubscriptionId(event: StripeWebhookEvent): string | undefined {
  const object = event.data.object;
  if (event.type.startsWith("customer.subscription.")) return stringField(object.id);
  return stringField(object.subscription) ?? stringField(recordValue(object.parent).subscription_details && recordValue(recordValue(object.parent).subscription_details).subscription);
}

export function configuredStripePlan(object: Record<string, unknown>, plans: StripePlan[], checkoutMapping?: CheckoutMapping | null): { plan?: StripePlan; interval?: "month" | "year" } {
  for (const priceId of stripePriceIds(object)) {
    const plan = plans.find((candidate) => candidate.monthlyPriceId === priceId || candidate.annualPriceId === priceId);
    if (plan) return { plan, interval: plan.annualPriceId === priceId ? "year" : "month" };
  }
  const plan = checkoutMapping ? plans.find((candidate) => candidate.id === checkoutMapping.planId) : undefined;
  return plan && checkoutMapping ? { plan, interval: checkoutMapping.interval } : {};
}

export function stripeStatus(event: StripeWebhookEvent, existing?: TenantBillingAccount | null): string {
  if (event.type === "customer.subscription.deleted") return "canceled";
  if (event.type === "invoice.payment_failed") return "past_due";
  if (event.type === "invoice.payment_action_required" || event.type === "invoice.finalization_failed") return "payment_required";
  if (event.type === "customer.subscription.paused") return "paused";
  if (event.type === "customer.subscription.resumed") return stringField(event.data.object.status) ?? "active";
  if (event.type.startsWith("customer.subscription.")) {
    const status = stringField(event.data.object.status);
    if (status === "canceled" && event.data.object.cancel_at_period_end === true) return "canceled_at_period_end";
    return status ?? "unknown";
  }
  if (event.type === "invoice.paid") return existing?.status === "trialing" ? "trialing" : existing?.status ?? "active";
  return existing?.status ?? "incomplete";
}

export async function loadTrial(database: D1DatabaseLike, organizationId: string): Promise<{ state: TrialState; endsAt?: string; startedAt?: string } | null> {
  const row = await database.prepare("SELECT state, ends_at, started_at FROM tinkerbot_trial_records WHERE organization_id = ?1 AND trial_type = 'team'").bind(organizationId).first<{ state: string; ends_at?: string | null; started_at?: string | null }>();
  if (!row) return null;
  return { state: row.state as TrialState, endsAt: row.ends_at ?? undefined, startedAt: row.started_at ?? undefined };
}

export async function loadEnterpriseGrants(database: D1DatabaseLike, organizationId: string, now: string): Promise<Array<{ key: EntitlementKey; expiresAt?: string }>> {
  const statement = database.prepare("SELECT entitlement_key, expires_at FROM tinkerbot_enterprise_entitlement_grants WHERE organization_id = ?1").bind(organizationId);
  if (typeof statement.all !== "function") return [];
  const rows = (await statement.all<{ entitlement_key: string; expires_at?: string | null }>()).results ?? [];
  return rows.flatMap((row) => row.expires_at && Date.parse(row.expires_at) <= Date.parse(now) ? [] : [{ key: row.entitlement_key as EntitlementKey, expiresAt: row.expires_at ?? undefined }]);
}

export async function entitlementsForOrganization(database: D1DatabaseLike, organizationId: string, fallback?: TenantEntitlement | null, now = new Date().toISOString()): Promise<CalculatedEntitlements> {
  const billing = await new D1BillingStore(database).getByOrganization(organizationId);
  const trial = await loadTrial(database, organizationId);
  const grants = await loadEnterpriseGrants(database, organizationId, now);
  return calculateEntitlements({
    organizationId,
    planId: billing?.planId ?? fallback?.planId ?? "free",
    billingStatus: billing?.status ?? fallback?.billingStatus ?? "free",
    trialState: trial?.state,
    trialEndsAt: trial?.endsAt,
    enterpriseGrants: grants,
    now,
    catalogVersion: BILLING_CATALOG_VERSION,
  });
}

export function entitlementDenied(calculated: CalculatedEntitlements, feature: EntitlementKey, mutation = true): { error: string; code: string; feature: EntitlementKey; billingStatus: string } | null {
  const blocked = ["canceled", "deleted", "unpaid", "unknown", "incomplete", "billing_unavailable", "paused", "expired", "payment_required"];
  if (mutation && blocked.includes(calculated.billingStatus) && feature !== "hosted_account") {
    return { error: "Paid mutations are blocked until billing state is verified.", code: "entitlement_required", feature, billingStatus: calculated.billingStatus };
  }
  if (mutation && (calculated.billingStatus === "past_due" || calculated.billingStatus === "grace") && !["hosted_account", "verification", "receipts", "assurance_metadata", "basic_history", "basic_work_orders"].includes(feature)) {
    return { error: "New premium work is paused while payment is past due.", code: "entitlement_required", feature, billingStatus: calculated.billingStatus };
  }
  if (calculated.features[feature] !== true) {
    return { error: "The current server-side entitlement does not include this capability.", code: "entitlement_required", feature, billingStatus: calculated.billingStatus };
  }
  return null;
}

export async function snapshotEntitlements(database: D1DatabaseLike, organizationId: string, calculated: CalculatedEntitlements, updatedAt: string): Promise<void> {
  await new D1TenantStore(database).putEntitlements({
    organizationId,
    planId: calculated.planId,
    billingStatus: calculated.billingStatus,
    privateRepositoryLimit: 0,
    memberLimit: 0,
    retentionDays: "historyRetentionDays" in calculated.values ? calculated.values.historyRetentionDays : BILLING_POLICY.free.historyRetentionDays,
    features: Object.fromEntries(Object.entries(calculated.features).filter(([, value]) => value)) as Record<string, boolean>,
    updatedAt,
  });
}

export async function recordBillingAudit(database: D1DatabaseLike, input: { organizationId: string; actorId?: string; action: string; payload?: Record<string, unknown>; now?: string }): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await database.prepare("INSERT INTO tinkerbot_billing_audit_events (event_id, organization_id, actor_id, action, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), input.organizationId, input.actorId ?? null, input.action, JSON.stringify(input.payload ?? {}), now).run();
}

export async function recordSeatTransition(database: D1DatabaseLike, input: { organizationId: string; userId?: string; transition: string; quantityAfter: number; now?: string }): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await database.prepare("INSERT INTO tinkerbot_seat_ledger_events (event_id, organization_id, user_id, transition, quantity_after, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), input.organizationId, input.userId ?? null, input.transition, input.quantityAfter, now).run();
}

export async function syncStripeQuantity(input: { database: D1DatabaseLike; provider: StripeBillingProvider; organizationId: string }): Promise<{ expected: number; pending?: boolean }> {
  const expected = await new D1TenantStore(input.database).countSeatUsage(input.organizationId);
  const account = await new D1BillingStore(input.database).getByOrganization(input.organizationId);
  if (!account?.subscriptionId || ["canceled", "incomplete", "free"].includes(account.status)) return { expected };
  try {
    await input.provider.updateSubscriptionQuantity({ subscriptionId: account.subscriptionId, quantity: expected, idempotencyKey: `qty:${input.organizationId}:${expected}:${account.subscriptionId}` });
    return { expected };
  } catch {
    await input.database.prepare("INSERT INTO tinkerbot_reconciliation_runs (run_id, organization_id, status, expected_quantity, actual_quantity, notes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(crypto.randomUUID(), input.organizationId, "pending", expected, null, "stripe_quantity_update_failed", new Date().toISOString()).run();
    return { expected, pending: true };
  }
}

export async function applyStripeEvent(event: StripeWebhookEvent, metadata: D1JsonMetadataStore, billing: D1BillingStore, tenants: D1TenantStore, plans: StripePlan[], database?: D1DatabaseLike): Promise<void> {
  if (!STRIPE_BILLING_EVENTS.has(event.type)) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, receivedAt: new Date().toISOString() });
    return;
  }
  const object = event.data.object;
  const objectMetadata = recordValue(object.metadata);
  const subscriptionId = stripeSubscriptionId(event);
  const customerId = stringField(object.customer);
  const mapped = subscriptionId ? await billing.getBySubscription(subscriptionId) : customerId ? await billing.getByCustomer(customerId) : null;
  const checkoutId = event.type === "checkout.session.completed" ? stringField(object.id) : undefined;
  const checkoutMapping = checkoutId ? await metadata.get<CheckoutMapping>(`billing:checkout:${checkoutId}`) : null;
  const organizationId = mapped?.organizationId ?? checkoutMapping?.organizationId;
  if (!organizationId) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, reason: "organization_unresolved", receivedAt: new Date().toISOString() });
    return;
  }
  const claimedOrganizationId = stringField(objectMetadata.organization_id) ?? stringField(object.client_reference_id);
  if (claimedOrganizationId && claimedOrganizationId !== organizationId) {
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, ignored: true, reason: "organization_mismatch", receivedAt: new Date().toISOString(), organizationId });
    return;
  }
  if (event.type === "charge.refunded" || event.type.startsWith("charge.dispute.")) {
    if (database) await recordBillingAudit(database, { organizationId, action: event.type, payload: { eventId: event.id } });
    await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, review: "payment_review", receivedAt: new Date().toISOString(), organizationId });
    return;
  }
  const existing = mapped ?? await billing.getByOrganization(organizationId);
  const eventCreated = Number.isSafeInteger(event.created) && (event.created as number) >= 0 ? event.created as number : Math.floor(Date.now() / 1000);
  const updatedAt = new Date(eventCreated * 1000).toISOString();
  const configured = configuredStripePlan(object, plans, checkoutMapping);
  const plan = configured.plan;
  const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : existing?.currentPeriodEnd;
  const account: TenantBillingAccount = {
    organizationId,
    customerId: customerId ?? existing?.customerId,
    subscriptionId: subscriptionId ?? existing?.subscriptionId,
    planId: plan?.id ?? existing?.planId ?? "free",
    interval: configured.interval ?? existing?.interval,
    status: stripeStatus(event, existing),
    cancelAtPeriodEnd: typeof object.cancel_at_period_end === "boolean" ? object.cancel_at_period_end : existing?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: periodEnd,
    lastEventId: event.id,
    lastEventCreatedAt: eventCreated,
    updatedAt,
  };
  const applied = await billing.upsert(account);
  if (applied && database) {
    if (account.status === "active" || account.status === "trialing") {
      await database.prepare("UPDATE tinkerbot_trial_records SET state = 'converted', converted_at = ?2, updated_at = ?2 WHERE organization_id = ?1 AND trial_type = 'team' AND state IN ('trialing', 'trial_expiring')").bind(organizationId, updatedAt).run();
    }
    const calculated = await entitlementsForOrganization(database, organizationId, undefined, updatedAt);
    await snapshotEntitlements(database, organizationId, calculated, updatedAt);
  } else if (applied) {
    const calculated = calculateEntitlements({ planId: account.planId, billingStatus: account.status, now: updatedAt });
    await tenants.putEntitlements({ organizationId, planId: calculated.planId, billingStatus: calculated.billingStatus, privateRepositoryLimit: 0, memberLimit: 0, retentionDays: BILLING_POLICY.free.historyRetentionDays, features: Object.fromEntries(Object.entries(calculated.features).filter(([, value]) => value)) as Record<string, boolean>, updatedAt });
  }
  await metadata.put(`billing:event:${event.id}`, { id: event.id, type: event.type, stale: !applied, receivedAt: new Date().toISOString(), organizationId });
}

export async function expireTrials(database: D1DatabaseLike, now = new Date().toISOString()): Promise<number> {
  const statement = database.prepare("SELECT organization_id, ends_at FROM tinkerbot_trial_records WHERE state IN ('trialing', 'trial_expiring') AND ends_at IS NOT NULL AND ends_at <= ?1").bind(now);
  const rows = typeof statement.all === "function" ? (await statement.all<{ organization_id: string; ends_at: string }>()).results ?? [] : [];
  for (const row of rows) {
    await database.prepare("UPDATE tinkerbot_trial_records SET state = 'expired', updated_at = ?2 WHERE organization_id = ?1 AND trial_type = 'team'").bind(row.organization_id, now).run();
    const billing = new D1BillingStore(database);
    const account = await billing.getByOrganization(row.organization_id);
    if (!account?.subscriptionId) {
      await billing.upsert({ organizationId: row.organization_id, planId: "free", status: "free", cancelAtPeriodEnd: false, lastEventCreatedAt: Math.floor(Date.parse(now) / 1000), updatedAt: now });
      const calculated = calculateEntitlements({ planId: "free", billingStatus: "free", trialState: "expired", now });
      await snapshotEntitlements(database, row.organization_id, calculated, now);
    }
  }
  return rows.length;
}

export function publicCatalogResponse(): { catalogVersion: string; currency: "USD"; billingUnit: string; plans: ReturnType<typeof publicBillingCatalog> } {
  return { catalogVersion: BILLING_CATALOG_VERSION, currency: "USD", billingUnit: "active_seat", plans: publicBillingCatalog() };
}

export function checkoutPlanAllowed(planId: string, interval: string, plans: StripePlan[]): { planId: PlanId; interval: "month" | "year"; stripe: StripePlan } | null {
  if (!isPlanId(planId) || (planId !== "developer" && planId !== "team" && planId !== "business")) return null;
  if (interval !== "month" && interval !== "year") return null;
  const stripe = plans.find((plan) => plan.id === planId);
  if (!stripe) return null;
  if (interval === "year" && !stripe.annualPriceId) return null;
  return { planId, interval, stripe };
}

export async function startTeamTrial(database: D1DatabaseLike, organizationId: string, actorId: string, now = new Date().toISOString()): Promise<{ ok: true; endsAt: string } | { ok: false; code: string; error: string }> {
  const existing = await loadTrial(database, organizationId);
  if (existing && existing.state !== "eligible") return { ok: false, code: "trial_not_eligible", error: "This organization is not eligible for another Team trial." };
  const billing = await new D1BillingStore(database).getByOrganization(organizationId);
  if (billing?.customerId) {
    const byCustomer = await database.prepare("SELECT organization_id FROM tinkerbot_trial_records WHERE stripe_customer_id = ?1 AND state IN ('trialing', 'converted', 'expired', 'blocked') LIMIT 1").bind(billing.customerId).first<{ organization_id: string }>();
    if (byCustomer) return { ok: false, code: "trial_not_eligible", error: "This organization is not eligible for another Team trial." };
  }
  const endsAt = new Date(Date.parse(now) + BILLING_POLICY.trialDays * 24 * 60 * 60 * 1000).toISOString();
  await database.prepare("INSERT INTO tinkerbot_trial_records (organization_id, trial_type, state, workos_organization_id, stripe_customer_id, started_at, ends_at, updated_at) VALUES (?1, 'team', 'trialing', ?1, ?2, ?3, ?4, ?3) ON CONFLICT(organization_id, trial_type) DO UPDATE SET state = 'trialing', started_at = excluded.started_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at").bind(organizationId, billing?.customerId ?? null, now, endsAt).run();
  await new D1BillingStore(database).upsert({ organizationId, customerId: billing?.customerId, subscriptionId: billing?.subscriptionId, planId: "team", interval: billing?.interval, status: "trialing", cancelAtPeriodEnd: false, currentPeriodEnd: endsAt, lastEventCreatedAt: Math.floor(Date.parse(now) / 1000), updatedAt: now });
  const calculated = calculateEntitlements({ planId: "team", billingStatus: "trialing", trialState: "trialing", trialEndsAt: endsAt, now });
  await snapshotEntitlements(database, organizationId, calculated, now);
  await recordBillingAudit(database, { organizationId, actorId, action: "trial_start", payload: { endsAt } });
  return { ok: true, endsAt };
}

export function productionCatalogUnavailable(environment: string | undefined, plans: StripePlan[]): boolean {
  return environment === "production" && !stripeCatalogComplete(plans);
}
