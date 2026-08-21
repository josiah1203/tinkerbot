# 2026-08-18 seat billing catalog

## Deleted prices

- Developer **$12 / month** (`1200` cents) and **$120 / year** (`12000` cents).
- Team **$18 / month** (`1800` cents) and **$180 / year** (`18000` cents).
- Business **$29 / month** (`2900` cents) and **$290 / year** (`29000` cents).

Replaced by Developer **$20 / $200**, Team **$40 / $400**, Business **$60 / $600** (annual billed as ten months).

## Deleted fields and fallbacks

- Paid-plan `memberLimit`, `seatLimit`, `privateRepositoryLimit`, `repositoryLimit`, `factoryLimit`, and per-repository / per-run / per-token prices in `STRIPE_PLANS_JSON`. Parser now **rejects** those keys.
- Stripe Checkout `trialPeriodDays` as the Team trial mechanism. Trial is a Tinkerbot `trial_records` row; conversion is a real Checkout session.
- Checkout response `{ checkout }` as the granted-entitlement shape. Mutations now return `{ pending, checkout, grantedFromRedirect: false }`.
- Minimum Stripe quantity of `1`. Quantity is `max(0, active human seats)`.
- `invoice.paid` forcing `active` while a Tinkerbot trial is still `trialing`.
- Production Wrangler `STRIPE_PLANS_JSON: "[]"`. Production fails closed until operators set live Price IDs.
- Client-submitted `priceId`, `quantity`, `organizationId`, and `entitlements` on checkout.
- Dashboard copy and docs that treated tokens or runs as the billing unit.

## Retained but quarantined

- D1 `member_limit` and `private_repository_limit` columns, written as `0` on entitlement snapshots. They are not product caps.
