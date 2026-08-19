# Release runbook

This runbook is intentionally split between repository work and release-owner operations. It does not authorize publication, tags, deployment, secret mutation, or provider resource creation by itself.

## Repository gates

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm release:dry-run
git diff --check
```

Build artifacts only in an approved release environment:

```sh
pnpm release:clients
TINKERBOT_RELEASE_BASE_URL=https://<approved-download-host>/<version> \
pnpm release:homebrew
```

Inspect `dist/release/manifest.json`, artifact checksums, archive contents, and the rendered formula. The manifest is unsigned until an approved signing/provenance system records otherwise; that is a stop condition, not a warning to ignore.

## Release-owner operations

After all [external gates](./release-readiness.md) are satisfied and live validation passes:

1. Apply Cloudflare migrations/bindings and secrets; deploy the approved Worker URL.
2. Register WorkOS and GitHub callbacks/webhooks using that URL; configure Stripe’s signed webhook and server-owned plan catalog.
3. Test hosted session issuance, organization switching, billing entitlement changes, assurance ingest, and GitHub App lifecycle in a non-production organization.
4. Build, sign, and publish the approved archives and manifest to the approved HTTPS host.
5. Publish the package only to the approved private npm registry; publish the formula only to the approved tap.
6. Create an immutable source/client release tag and only then update the reviewed Action major tag.

## Rollback

Do not delete published artifacts or packages. Revoke or disable compromised sessions/credentials, stop the affected Worker route if necessary, move the Action major tag to the last known-good immutable commit, deprecate the affected private package version, and publish a corrected patch. Preserve webhook and deployment audit evidence for incident review.
