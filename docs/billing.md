# Control-plane billing

Billing is **per active human seat**. Developer is **$20**, Team **$40**, Business **$60** per seat per month. Annual is ten months: **$200 / $400 / $600**. Free is hosted with public-repository limits. Enterprise is contract. AI tokens and run counts are internal cost telemetry and fair-use signals — they are not invoiced.

Paid plans have **no seat or repository cap**. Entitlements (SSO, SCIM, Change Sets, audit export, hosted API, factory improvement, premium routing) are calculated from the in-source catalog plus billing status. Local execution, BYOK inference, portable evals, offline assurance, and cloud sync are included (or outside billing) on Free/Developer; `private_execution` remains Enterprise dedicated hosted execution. Stripe JSON may contain only Price IDs and `catalogVersion`.

Team includes a **14-day trial with no card**. Checkout conversion creates a Stripe subscription whose `quantity` equals the server-side active human seat count. Join and leave sync that quantity with prorations. Payment failure moves the account to `past_due` with a grace window for verification reads; premium mutations stay blocked until Stripe reports a healthy subscription.

Deploy production with a nonempty `STRIPE_PLANS_JSON` from [`config/stripe-plans.production.json.example`](../config/stripe-plans.production.json.example). Do not ship placeholder Price IDs. See [ADR 0004](./adr/0004-seat-billing-and-entitlements.md) and the [catalog changelog](./changelog/2026-08-18-seat-billing.md).
