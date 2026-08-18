# Control-plane billing

Billing is a first-class page at `/app/settings/billing`. The UI is built around provider-neutral plan and entitlement interfaces so Stripe or another provider can be added without changing the shell.

## Current server-owned plan shape

- Developer: `$12/month` or `$120/year` per active seat.
- Team: `$18/month` or `$180/year` per active seat.
- Business: `$29/month` or `$290/year` per active seat.
- Enterprise: contract-priced; it is not exposed as a self-serve Stripe plan.

Private-repository limits are not used as a billing metric for these paid plans. Stripe Price IDs, feature flags, retention, and entitlements remain server-owned configuration; no browser or Action input can select a price ID.

## Provider state

The default browser preview remains read-only when no hosted API base is configured. When configured, the billing page reads the server-authorized summary and can start Checkout, open the customer portal, schedule cancellation, or reactivate a pending cancellation. The Worker owns Stripe Price IDs, prevents duplicate nonterminal subscriptions, namespaces idempotency keys, verifies signed webhooks, and persists customer/subscription reverse mappings in D1. It does not collect card details or trust a browser-supplied price ID.

Required production work:

- D1 binding, migration `0005`, and a nonempty server-owned `STRIPE_PLANS_JSON` catalog with explicit limits and feature flags;
- Stripe webhooks remain the source of subscription truth; scheduled reconciliation is still required for missed events;
- scheduled Stripe reconciliation for missed events;
- server-side entitlement enforcement for repository connections, history retention, policy features, and audit access; assurance metadata, invitations, and invitation seat counts are already guarded by the current Worker;
- WorkOS webhook registration plus organization-wide membership reconciliation and organization-level authorization for billing mutations;
- confirmation UX for upgrade, downgrade, cancel, reactivate, and payment-method changes;
- payment-failure and past-due recovery paths;
- no raw card data in the application.

## Assurance entitlements

Hosted assurance metadata is an entitlement-controlled control-plane capability; the Worker requires an active/trialing billing state and an explicit `assurance_metadata: true` feature before returning or ingesting repository assurance data. The browser cannot activate the feature by changing plan state in local storage. Billing is by active seat, not by PR, commit, contributor, run, retry, token, or artifact.
