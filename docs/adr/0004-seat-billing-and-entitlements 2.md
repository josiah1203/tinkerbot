# ADR 0004: Seat billing and entitlements

- Status: Accepted
- Date: 2026-08-18

## Decision

Tinkerbot bills **active human seats**, not tokens, runs, repositories, or factories. The public catalog is Developer **$20**, Team **$40**, and Business **$60** per seat per month (annual is ten months: **$200 / $400 / $600**). Free is a hosted tier with public-repository limits. Team includes a **14-day trial owned by Tinkerbot**; checkout does not collect a card for the trial. Stripe `quantity` is the server-side count of active human memberships and is reconciled on join, leave, and a scheduled job.

Entitlements are **calculated in the Worker** from plan, billing status, trial state, and signed enterprise grants. Clients, GitHub Actions, and OIDC run tokens cannot submit price IDs, quantities, or feature flags. Paid plans have **no seat or repository cap**. Legacy `member_limit` and `private_repository_limit` columns remain in D1 as quarantined zeros until a later drop.

## Consequences

- Production must set a nonempty `STRIPE_PLANS_JSON` of Price IDs only. Cap fields in that JSON are rejected.
- `invoice.paid` does not convert a Tinkerbot trial into `active`.
- Past-due and unknown billing fail closed for paid mutations; verification and receipts remain readable during grace.
- AI model selection is an internal cost class. Usage pages must not present token totals as customer invoices.
