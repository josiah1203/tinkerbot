# Release readiness

## Status: blocked on external release inputs

The source implementation has hosted CLI/TUI, GitHub Action, webhook lifecycle, billing contract, and client-distribution foundations. It is **not a production release** until the external requirements below are completed and independently validated. No provider state or publication is fabricated by this repository.

| Area | Source status | Release gate |
| --- | --- | --- |
| Hosted CLI and TUI | implemented and locally tested | approved control-plane URL and session issuance flow |
| GitHub Action PR output | implemented | authorized repository workflow validation |
| GitHub App lifecycle | webhook/callback contracts implemented | App registration, canonical URLs, secret, credentials/token minting |
| WorkOS | Worker contract implemented | rotated credentials, redirect URI, webhook registration, live validation |
| Stripe | server-owned catalog shape implemented | six real Price IDs and signed webhook/live checkout validation |
| Cloudflare | Worker config/migrations in source | authenticated deploy identity, production D1/R2 bindings, secrets, migrations |
| npm/Bun | private package and install documentation prepared | approved private registry and publication authorization |
| Homebrew | formula renderer prepared | approved tap and signed Darwin release archives |
| curl | checksum-verifying installer prepared | approved HTTPS download host, manifest, archives, signing/provenance |

## Required external inputs

1. Cloudflare authenticated release identity; production Worker URL, D1 binding/migrations, R2 bucket/retention, and all required Worker secrets including `GITHUB_WEBHOOK_SECRET`.
2. WorkOS client/API/webhook secrets, approved redirect URI, and registered webhook endpoint.
3. Stripe secret/webhook keys plus real monthly and annual Price IDs for Developer, Team, and Business; production `STRIPE_PLANS_JSON` must map those IDs server-side.
4. GitHub App ID, private key/token-minting path, webhook secret, approved public webhook/callback URLs, and installed test organization/repository.
5. Approved package registry, artifact signing identity/provenance mechanism, download host, and Homebrew tap.

## Release verification

Before a release owner publishes or deploys, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm tui:test
pnpm tui:build
pnpm release:dry-run
TINKERBOT_TUI_TARGETS=<approved-target-list> pnpm release:clients
```

Then verify each archive and the manifest on a clean host, render the Homebrew formula from the manifest, and perform live validation in an authorized GitHub test repository. Confirm login/session issuance, organization switch, hosted `tb verify`, Action Check Run/comment behavior, signed GitHub/WorkOS/Stripe webhooks, entitlement enforcement, and a rollback.

See [the runbook](./release-runbook.md) for authorized operations and [distribution](./distribution.md) for the artifact contract.
