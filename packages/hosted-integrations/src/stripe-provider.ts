import type {
  BillingProvider,
  CheckoutSessionInput,
  StripeConfig,
  StripePlan,
  StripeWebhookEvent,
  WebhookLedger,
} from "./index";
import { jsonRequest, ProviderError, recordValue, requiredSecret } from "./provider-core";

function formEntries(value: unknown, prefix: string, entries: Array<[string, string]>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => formEntries(item, `${prefix}[${index}]`, entries));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) formEntries(item, `${prefix}[${key}]`, entries);
    return;
  }
  if (value !== undefined && value !== null) entries.push([prefix, typeof value === "boolean" ? (value ? "true" : "false") : String(value)]);
}

function toFormBody(value: Record<string, unknown>): string {
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) formEntries(item, key, entries);
  return new URLSearchParams(entries).toString();
}

function basicAuth(value: string): string {
  return `Basic ${btoa(`${value}:`)}`;
}

function stripeSeatQuantity(value: number | undefined): number {
  const quantity = value == null ? 1 : value;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1_000_000) {
    throw new ProviderError("stripe", "Stripe seat quantity must be a non-negative integer no greater than 1000000 (zero is normalized to one).", { code: "invalid_quantity" });
  }
  return Math.max(1, quantity);
}

export async function verifyStripeSignature(payload: string, signatureHeader: string | null | undefined, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const values = new Map<string, string[]>();
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key && value) values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get("t")?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = `${timestamp}.${payload}`;
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expected)));
  const expectedHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return (values.get("v1") ?? []).some((candidate) => candidate.length === expectedHex.length && [...candidate].reduce((different, character, index) => different | (character.charCodeAt(0) ^ expectedHex.charCodeAt(index)), 0) === 0);
}

export class StripeBillingProvider implements BillingProvider {
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly plans: Map<string, StripePlan>;
  private readonly fetcher: typeof fetch;

  constructor(config: StripeConfig) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
    this.plans = new Map((config.plans ?? []).map((plan) => [plan.id, plan]));
    this.fetcher = config.fetcher ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const secretKey = requiredSecret(this.secretKey, "STRIPE_SECRET_KEY", "stripe");
    return jsonRequest("stripe", this.fetcher, `${this.apiBaseUrl}${path}`, { method: "POST", headers: { accept: "application/json", authorization: basicAuth(secretKey), "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: toFormBody(body) });
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url?: string }> {
    const plan = this.plans.get(input.planId);
    if (!plan) throw new ProviderError("stripe", `Billing plan ${input.planId} is not configured on the server.`, { code: "plan_not_configured" });
    const price = input.interval === "year" ? plan.annualPriceId : plan.monthlyPriceId;
    if (!price) throw new ProviderError("stripe", `Billing interval ${input.interval} is not configured for plan ${input.planId}.`, { code: "price_not_configured" });
    const subscriptionData: Record<string, unknown> = { metadata: { organization_id: input.organizationId, plan_id: plan.id, billing_interval: input.interval } };
    if (input.trialPeriodDays && input.trialPeriodDays > 0) subscriptionData.trial_period_days = input.trialPeriodDays;
    const payload = await this.post("/v1/checkout/sessions", { mode: "subscription", success_url: input.successUrl, cancel_url: input.cancelUrl, client_reference_id: input.organizationId, customer: input.customerId, customer_email: input.customerEmail, "line_items": [{ price, quantity: stripeSeatQuantity(input.seatQuantity) }], "subscription_data": subscriptionData, metadata: { organization_id: input.organizationId, plan_id: plan.id } }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete checkout session.", { code: "provider_invalid_response" });
    return { id: payload.id, url: typeof payload.url === "string" ? payload.url : undefined };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ id: string; url?: string }> {
    const payload = await this.post("/v1/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete billing portal session.", { code: "provider_invalid_response" });
    return { id: payload.id, url: typeof payload.url === "string" ? payload.url : undefined };
  }

  async setSubscriptionCancellation(input: { subscriptionId: string; cancelAtPeriodEnd: boolean; idempotencyKey: string }): Promise<{ id: string; status?: string; cancelAtPeriodEnd?: boolean }> {
    const payload = await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, { cancel_at_period_end: input.cancelAtPeriodEnd }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription.", { code: "provider_invalid_response" });
    return { id: payload.id, status: typeof payload.status === "string" ? payload.status : undefined, cancelAtPeriodEnd: typeof payload.cancel_at_period_end === "boolean" ? payload.cancel_at_period_end : undefined };
  }

  async retrieveSubscription(subscriptionId: string): Promise<Record<string, unknown>> {
    const secretKey = requiredSecret(this.secretKey, "STRIPE_SECRET_KEY", "stripe");
    return jsonRequest("stripe", this.fetcher, `${this.apiBaseUrl}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET", headers: { accept: "application/json", authorization: basicAuth(secretKey) } });
  }

  async updateSubscriptionQuantity(input: { subscriptionId: string; quantity: number; idempotencyKey: string }): Promise<{ id: string; quantity?: number }> {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    const items = recordValue(subscription.items);
    const data = Array.isArray(items.data) ? items.data : [];
    const first = data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : undefined;
    const itemId = typeof first?.id === "string" ? first.id : undefined;
    if (!itemId) throw new ProviderError("stripe", "Stripe subscription has no billable item to update.", { code: "subscription_item_missing" });
    const payload = await this.post(`/v1/subscription_items/${encodeURIComponent(itemId)}`, { quantity: stripeSeatQuantity(input.quantity), proration_behavior: "create_prorations" }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription item.", { code: "provider_invalid_response" });
    return { id: payload.id, quantity: typeof payload.quantity === "number" ? payload.quantity : undefined };
  }

  async changeSubscriptionPrice(input: { subscriptionId: string; priceId: string; quantity: number; prorationBehavior: "create_prorations" | "none"; idempotencyKey: string }): Promise<{ id: string; status?: string }> {
    const subscription = await this.retrieveSubscription(input.subscriptionId);
    const items = recordValue(subscription.items);
    const data = Array.isArray(items.data) ? items.data : [];
    const first = data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : undefined;
    const itemId = typeof first?.id === "string" ? first.id : undefined;
    if (!itemId) throw new ProviderError("stripe", "Stripe subscription has no billable item to update.", { code: "subscription_item_missing" });
    const payload = await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
      items: [{ id: itemId, price: input.priceId, quantity: stripeSeatQuantity(input.quantity) }],
      proration_behavior: input.prorationBehavior,
      cancel_at_period_end: false,
    }, input.idempotencyKey);
    if (typeof payload.id !== "string") throw new ProviderError("stripe", "Stripe returned an incomplete subscription.", { code: "provider_invalid_response" });
    return { id: payload.id, status: typeof payload.status === "string" ? payload.status : undefined };
  }

  async handleWebhook(payload: string, signatureHeader: string | null | undefined, ledger: WebhookLedger, onEvent: (event: StripeWebhookEvent) => Promise<void>, options: { nowSeconds?: number; toleranceSeconds?: number } = {}): Promise<{ duplicate: boolean; event: StripeWebhookEvent }> {
    const secret = requiredSecret(this.webhookSecret, "STRIPE_WEBHOOK_SECRET", "stripe");
    if (!await verifyStripeSignature(payload, signatureHeader, secret, options.toleranceSeconds ?? 300, options.nowSeconds)) throw new ProviderError("stripe", "Stripe webhook signature verification failed.", { code: "invalid_webhook_signature" });
    let event: StripeWebhookEvent;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const data = recordValue(parsed.data);
      const object = recordValue(data.object);
      if (typeof parsed.id !== "string" || typeof parsed.type !== "string") throw new Error("invalid event");
      event = { id: parsed.id, type: parsed.type, created: typeof parsed.created === "number" ? parsed.created : undefined, data: { object } };
    } catch {
      throw new ProviderError("stripe", "Stripe webhook payload is invalid.", { code: "invalid_webhook_payload" });
    }
    const claimed = Boolean(ledger.claim);
    if (ledger.claim) {
      if (!await ledger.claim(event.id)) return { duplicate: true, event };
    } else if (await ledger.has(event.id)) {
      return { duplicate: true, event };
    }
    try {
      await onEvent(event);
      await ledger.record(event.id);
    } catch (error) {
      if (claimed && ledger.release) await ledger.release(event.id);
      throw error;
    }
    return { duplicate: false, event };
  }
}
