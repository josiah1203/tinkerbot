# Hosted provisioning checklist

Code in this repository cannot create live Stripe, WorkOS, Cloudflare, or GitHub App resources. Hosted production stays blocked until operators complete the items below in those accounts.

`database_id` values in [`apps/control-plane-worker/wrangler.jsonc`](../apps/control-plane-worker/wrangler.jsonc) are **placeholders** and are intentionally different per environment (`0000…` development, `1111…` staging, `2222…` production). Create three real D1 databases and replace those IDs before deploy. Do not reuse one D1 across staging and production.

## Cloudflare

- [ ] Create distinct D1 databases for development, staging, and production; paste real `database_id` values into wrangler; apply migrations to each.
- [ ] Attach the `Sandbox` Durable Object / platform Sandbox implementation in each environment. The Worker exports a placeholder `Sandbox` class until the account binding is live.
- [ ] Confirm R2 evidence buckets, queues, Vectorize indexes, Browser Rendering, Workers AI, and DNS already differ for staging where required.
- [ ] Set secrets: WorkOS, Stripe, `SESSION_ENCRYPTION_KEY`, GitHub App PEM and webhook secret, optional `GITLAB_WEBHOOK_SECRET` and evidence-export secrets (operator-only; never customer copy).
- [ ] Leave `WORKOS_EVENTS_SYNC_ENABLED` false until production WorkOS webhooks exist.
- [ ] Set nonempty live `STRIPE_PLANS_JSON` per environment (no `price_REPLACE_*`). Empty catalog → `catalog_unavailable`; nobody can buy a seat.

## WorkOS

- [ ] Production application, redirects (`WORKOS_REDIRECT_URI`), webhooks, roles, invitation and org-switch.
- [ ] Customer login remains “Log in / Google, GitHub, or SSO”. Keep `/auth/workos/start` as the adapter.

## Stripe

- [ ] Live and test products; Checkout and Customer Portal; quantity = active human seats; `past_due` handling; webhooks.
- [ ] Seat-only catalog: `developer` / `team` / `business` with `monthlyPriceId` (optional `annualPriceId`). Do not include `memberLimit` or `privateRepositoryLimit`.
- [ ] Validate with `TINKERBOT_WORKER_URL`, `TINKERBOT_OPS_SESSION` (owner/admin session for `GET /config/status`), and Stripe/WorkOS env vars via `scripts/validate-live-providers.mjs`.

## GitHub App and Action

- [ ] Register the App, store PEM, install on a test org/repo. Fail closed: OIDC exchange requires an installation for the repository.
- [ ] Enable OIDC only after JWKS verification is deployed.
- [ ] Release tags must include built `dist/action/index.js` (root `dist/` is gitignored). Package the compiled Action in the tag; do not expect a source checkout to satisfy `action/index.js`.

## Distribution (P2)

- [ ] Signed clients, real download host, changelog and support.
- [ ] Playwright against live WorkOS/Stripe/App after a staging loop: login → checkout (test mode) → factory → Action OIDC → PR.

Local `tb check` / `tb run --local` remains shippable without Stripe.
