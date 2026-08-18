# Cloudflare hosted runtime and secrets

The hosted integration boundary is designed for a Cloudflare Worker while local `tb/pr-proof` verification remains independent. The staging Worker is deployed as `tinkerbot-control-plane-staging` on the account workers.dev subdomain, is bound to the provisioned D1 database, and has a 15-minute schedule. Provider secrets remain intentionally unseeded until rotated credentials are available; missing runtime resources return explicit `501` responses instead of fabricated hosted state.

## Current staging deployment

- Worker: `tinkerbot-control-plane-staging`
- Public URL: `https://tinkerbot-control-plane-staging.josiah-lee01.workers.dev`
- D1: `tinkerbot-control-plane`, migrations `0001` through `0004` applied; migration `0005` is implemented and awaiting deployment
- Schedule: `*/15 * * * *` (UTC)
- Initial replay window: `2026-08-11T00:00:00.000Z` (a conservative seven-day bootstrap window)
- WorkOS Events consumer: disabled until the webhook, API key, and replay readiness checks are complete
- R2: pending account-level R2 enablement; no bucket or R2 binding is claimed yet

## Secret names

The Worker declares these required secrets in [`apps/control-plane-worker/wrangler.jsonc`](../apps/control-plane-worker/wrangler.jsonc):

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SESSION_ENCRYPTION_KEY`

The repository contains only [`apps/control-plane-worker/.env.example`](../apps/control-plane-worker/.env.example). Copy it to `.dev.vars` locally and replace placeholders there; `.dev.vars` and environment-specific `.env.*` files are ignored by Git.

For deployed Worker secrets, use Wrangler’s interactive prompt from the Worker directory:

```sh
pnpm exec wrangler secret put WORKOS_CLIENT_ID --config apps/control-plane-worker/wrangler.jsonc
pnpm exec wrangler secret put WORKOS_API_KEY --config apps/control-plane-worker/wrangler.jsonc
pnpm exec wrangler secret put WORKOS_WEBHOOK_SECRET --config apps/control-plane-worker/wrangler.jsonc
pnpm exec wrangler secret put STRIPE_SECRET_KEY --config apps/control-plane-worker/wrangler.jsonc
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config apps/control-plane-worker/wrangler.jsonc
pnpm exec wrangler secret put SESSION_ENCRYPTION_KEY --config apps/control-plane-worker/wrangler.jsonc
```

Do not pass secret values as command arguments, place them in `vars`, or commit a secrets file. Cloudflare documents Worker secrets as encrypted bindings and supports required-secret declarations that fail deploys when a declared secret is missing. [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

The repository also provides [`scripts/cloudflare-secrets.sh`](../scripts/cloudflare-secrets.sh) for the same interactive workflow. For example, `bash scripts/cloudflare-secrets.sh put SESSION_ENCRYPTION_KEY production` opens Wrangler’s prompt without putting the value in shell history.

`STRIPE_PLANS_JSON` is a non-secret Worker variable containing the server-owned plan catalog and Stripe price IDs. It must be configured before checkout is enabled; the browser never supplies a price ID.

`WORKOS_EVENTS_SYNC_ENABLED` is `false` by default. Set it to `true` only after D1 and WorkOS API access are deployed; the Worker then uses its 15-minute Cron Trigger to consume bounded WorkOS Events API pages and persist the cursor at `workos:events:cursor`. Set the optional `WORKOS_EVENTS_RANGE_START` for the first replay window rather than assuming the first run is a complete historical import.

## Account-level Secrets Store

For centralized account-level management, create or select a Cloudflare Secrets Store and bind named secrets to the Worker only after the store ID and required permissions are known. The binding is intentionally not committed with a placeholder store ID. The supported shape is:

```jsonc
{
  "secrets_store_secrets": [
    {
      "binding": "WORKOS_API_KEY",
      "store_id": "<configured-store-id>",
      "secret_name": "TINKERBOT_WORKOS_API_KEY"
    }
  ]
}
```

The secret scope must include `workers`, and the deploy identity needs the permission to bind Secrets Store values. Cloudflare distinguishes account-level Secrets Store values from per-Worker secrets; the values are not readable back after creation. [Cloudflare Secrets Store Worker integration](https://developers.cloudflare.com/secrets-store/integrations/workers/) and [Secrets Store access control](https://developers.cloudflare.com/secrets-store/access-control/)

## Runtime boundary

The Worker currently exposes:

- `GET /health` and `GET /config/status`: non-secret provider and resource readiness only.
- `GET /auth/workos/start`: creates a short-lived OAuth state and redirects to WorkOS.
- `GET /auth/workos/callback`: validates state, exchanges the code server-side, encrypts provider tokens before D1 persistence, and returns a secure session cookie when D1 is bound.
- `GET /auth/session`: returns public session metadata and refreshes an expired WorkOS session server-side.
- `GET /tenant/access`: returns the server-resolved organization membership and entitlement snapshot.
- `POST /tenant/membership/sync`: same-origin, authenticated current-user reconciliation against the WorkOS session organization; it does not accept an arbitrary organization id.
- `GET /tenant/invitations`: returns provider-backed invitation state for an owner/admin when the server-side `team_invitations` entitlement is active.
- `POST /tenant/invitations`: validates the email and invite-safe role, enforces the feature and member-seat entitlement, creates the WorkOS invitation server-side, and records a D1 invitation/audit row without returning the invitation token.
- `POST /auth/signout`: revokes the local D1 session record and clears cookies.
- `POST /integrations/workos/webhook`: verifies the WorkOS signature, provisions or updates organization/membership/user rows, applies fail-closed role/status mapping, and ignores duplicate events.
- Scheduled `*/15 * * * *`: when `WORKOS_EVENTS_SYNC_ENABLED=true`, consumes up to ten 100-event WorkOS Events API pages per invocation, applies the same organization/membership handlers, and advances the D1 cursor only after each event is claimed and handled.
- `POST /billing/checkout`: creates a server-owned Stripe Checkout Session with an idempotency key after membership/role authorization.
- `GET /billing/summary`: returns billing state, entitlements, and public plan limits without returning Stripe Price IDs.
- `POST /billing/portal`: creates a Stripe customer portal session for the customer recorded by webhook state.
- `POST /billing/subscription/cancel`: requests cancellation at period end for the server-recorded subscription.
- `POST /billing/subscription/reactivate`: removes a pending period-end cancellation.
- `POST /billing/webhook`: verifies Stripe signatures, resolves invoice tenants from stored customer/subscription mappings, applies monotonic event ordering, and ignores replays.
- `GET /assurance/summary?repository=...`: returns an entitled repository's source-minimized assurance metadata or an explicit empty state.
- `POST /assurance/ingest`: accepts a bounded versioned assurance bundle for an authorized maintainer-level actor; source, full diffs, patches, secrets, and credentials are rejected.
- `POST /assurance/delete`: removes repository-scoped assurance metadata for an owner/admin and records the deletion audit event.

The Worker now performs organization membership and billing-role authorization from D1, provisions organization/user/membership/invitation state from signed WorkOS events, supports bounded current-user and Events API reconciliation, records entitlement snapshots from signed Stripe events, enforces the hosted assurance and invitation feature/seat checks server-side, and exposes a source-minimized assurance metadata boundary. Remaining gaps are the first live WorkOS/Stripe validation, full historical tenant bootstrap beyond the selected replay window, organization switching, repository/GitHub synchronization, verification-run orchestration, binary/artifact evidence ingestion, and R2 persistence. D1 is provisioned and migrated; R2 remains pending because the account must enable R2 in the Cloudflare Dashboard first.

The optional hosted Team and Billing UI reads `meta[name="tinkerbot-api-base"]` (or `window.__TINKERBOT_CONTROL_PLANE_API__`) and calls provider-backed routes only when that API base is explicitly configured. The default local preview remains accountless and does not fake invitations or billing state.

## Cloudflare resources still required

- A Worker name/environment approved by the release owner.
- A D1 database bound to the Worker and migrations applied for sessions, organization metadata, billing state, invitations, and the idempotency ledger. The staging database is already provisioned and migrated.
- An R2 bucket bound to the Worker for structured evidence bundles, with retention/deletion policy.
- A Secrets Store and `workers`-scoped bindings if account-level centralized secrets are preferred.
- A server-owned `STRIPE_PLANS_JSON` catalog with real test/staging/production price IDs.
- A deliberate `WORKOS_EVENTS_RANGE_START` replay window before enabling the scheduled WorkOS Events consumer.
- WorkOS webhook registration and rotated provider credentials before enabling the scheduled Events consumer or hosted administrative mutations.
- Explicit staging and production credentials, rotated from any values pasted into chat.

To register the WorkOS endpoint idempotently after the public URL is reachable, provide a rotated key through the environment and run the repository helper. It never prints the webhook secret; set `WORKOS_WEBHOOK_SECRET_FILE` if a local 0600 file is preferred for secure handoff:

```sh
WORKOS_API_KEY="<rotated-key>" \
WORKOS_WEBHOOK_URL="https://tinkerbot-control-plane-staging.josiah-lee01.workers.dev/integrations/workos/webhook" \
STRIPE_WEBHOOK_URL="https://tinkerbot-control-plane-staging.josiah-lee01.workers.dev/billing/webhook" \
WORKOS_WEBHOOK_SECRET_FILE="/secure/path/workos-webhook-secret" \
node scripts/register-workos-webhook.mjs
```

After the webhook secret is installed in the Worker, the following read-only check validates the public Worker configuration, the registered WorkOS endpoint and Events API access, and every configured Stripe monthly/annual price without creating provider state:

```sh
TINKERBOT_WORKER_URL="https://tinkerbot-control-plane-staging.josiah-lee01.workers.dev" \
WORKOS_WEBHOOK_URL="https://tinkerbot-control-plane-staging.josiah-lee01.workers.dev/integrations/workos/webhook" \
WORKOS_EVENTS_RANGE_START="2026-08-11T00:00:00.000Z" \
pnpm validate:providers
```

Supply `WORKOS_API_KEY`, `STRIPE_SECRET_KEY`, and the server-owned `STRIPE_PLANS_JSON` through the environment or an approved secret manager; the command reports provider metadata only and never prints credential values.
