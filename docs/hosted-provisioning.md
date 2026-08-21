# Hosted provisioning checklist

Code in this repository cannot create live Stripe, WorkOS, Cloudflare, or GitHub App resources. Hosted production stays blocked until operators complete the items below in those accounts.

`database_id` values in [`apps/control-plane-worker/wrangler.jsonc`](../apps/control-plane-worker/wrangler.jsonc) are **placeholders** and are intentionally different per environment (`0000…` development, `1111…` staging, `2222…` production). Create three real D1 databases and replace those IDs before deploy. Do not reuse one D1 across staging and production.

## Cloudflare

- [ ] Create distinct D1 databases for development, staging, and production; paste real `database_id` values into wrangler; apply migrations to each.
- [x] Keep the Cloudflare Sandbox binding feature-gated and unsupported for the current release line. The Worker exports a placeholder class that returns `501`; hosted production execution uses the signed self-hosted contract instead. A future Sandbox implementation requires a separate ADR/amendment and stage proof.
- [ ] Confirm R2 evidence buckets, queues, Vectorize indexes, Browser Rendering, Workers AI, and DNS already differ for staging where required.
- [ ] Set core secrets: WorkOS, Stripe, and a distinct non-placeholder `SESSION_ENCRYPTION_KEY` of at least 32 UTF-8 bytes (production `/health` and `/config/status` stay degraded until session encryption is ready).
- [ ] If self-hosted workers are in scope, create the `SELF_HOSTED_WORK` queue and set a separate, non-placeholder `SELF_HOSTED_WORK_SECRET` of at least 32 UTF-8 bytes (required in production; never reuse `SESSION_ENCRYPTION_KEY`); the queue envelope is HMAC-signed and never carries provider credentials.
- [ ] If the customer worker runs outside this Cloudflare account, set `SELF_HOSTED_WORK_ENDPOINT` to its HTTPS intake URL instead of (or alongside) the queue producer. The endpoint receives the same signed, credential-free envelope; HTTP is accepted only for localhost development.
- [ ] If self-hosted workers are in scope, configure the worker to verify the dispatch envelope, execute the selected customer harness, and POST a signed completion to `/self-hosted/complete` with a branch/commit/PR reference. Completion never submits a verification verdict; it only resumes the normal deterministic `tb check` path.
- [ ] If enabling the optional GitHub adapter, set `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY`; otherwise no Tinkerbot GitHub App installation is needed. `GITLAB_WEBHOOK_SECRET` and evidence-export secrets are also optional (operator-only; never customer copy).
- [ ] Leave `WORKOS_EVENTS_SYNC_ENABLED` false until production WorkOS webhooks exist.
- [ ] In staging, set `FACTORY_SHADOW_READ_ORGANIZATION_ID` to the soak tenant and retain the scheduled `factory_projection_shadow_read` logs for the acceptance window; the sweep is read-only and must report zero unexplained divergence before promotion.
- [ ] Set `FACTORY_TELEMETRY_RETENTION_DAYS` (default `30`) and verify the scheduled non-authoritative command/operational-telemetry cleanup; it must not delete graph events, receipts, or projections.
- [ ] Set nonempty live `STRIPE_PLANS_JSON` per environment (no `price_REPLACE_*`). Empty catalog → `catalog_unavailable`; nobody can buy a seat.

## WorkOS

- [ ] Production application, redirects (`WORKOS_REDIRECT_URI`), webhooks, roles, invitation and org-switch.
- [ ] Customer login remains “Log in / Google, GitHub, or SSO”. Keep `/auth/workos/start` as the adapter.

## Stripe

- [ ] Live and test products; Checkout and Customer Portal; quantity = active human seats; `past_due` handling; webhooks.
- [ ] Seat-only catalog: `developer` / `team` / `business` with `monthlyPriceId` (optional `annualPriceId`). Do not include `memberLimit` or `privateRepositoryLimit`.
- [ ] Validate with `TINKERBOT_WORKER_URL`, `TINKERBOT_OPS_SESSION` (owner/admin session for `GET /config/status`), and Stripe/WorkOS env vars via `scripts/validate-live-providers.mjs`.

## Optional GitHub App and Action

- [ ] If the GitHub adapter is part of the launch scope, register the App, store PEM, and install on a test org/repo. Core factory use remains available without it.
- [ ] If GitHub Action publishing is enabled, configure OIDC only after JWKS verification is deployed; the repository must have an installation for that adapter path.
- [ ] Release tags must include built `dist/action/index.js` (root `dist/` is gitignored). Package the compiled Action in the tag; do not expect a source checkout to satisfy `action/index.js`.

## Distribution (P2)

- [ ] Signed clients, real download host, changelog and support.
- [ ] Playwright against live WorkOS/Stripe/App after a staging loop: login → checkout (test mode) → factory → Action OIDC → PR.

Local `tb check` / `tb run --local` remains shippable without Stripe.
