# Tinkerbot Verify App protocol

This is the App-side assurance boundary, not a hosted Tinkerbot control plane.

1. An operator copies [`manifest.json`](./manifest.json), replaces the placeholder HTTPS URLs, and creates a private GitHub App with the listed least-privilege permissions.
2. On installation, the handler records only the installation ID, selected repository IDs/full names, permission state, and an audit event. Repository access is denied unless the installation explicitly includes the target repository.
3. Every webhook request is accepted only when `X-Hub-Signature-256` verifies against the configured App webhook secret. `X-GitHub-Delivery` is the idempotency key; duplicate deliveries return the prior outcome without repeating a publication.
4. Pull-request events are metadata triggers. The App does not clone, parse, or execute the pull-request checkout. The customer-owned `Tinkerbot Verify` Action checks out the repository with persisted credentials disabled and runs `tb check` on the runner.
5. The runner creates the deterministic report, canonical evidence contract, receipt, bounded annotations, and one summary. It attempts one `Tinkerbot Verify` Check Run and one sticky comment only when permissions allow.
6. Fork pull requests, suspended installations, missing repository access, missing `checks:write`, missing comment permissions, API timeouts, and duplicate/racing deliveries degrade to local artifacts plus explicit UNKNOWN/degraded status. They never become an implicit PASS and never trigger privileged execution.
7. Uninstallation or repository removal revokes the installation record and prevents future writes. GitHub remains authoritative for reviews, comments, approvals, branch protection, merge controls, permissions, and audit history.

The pure webhook admission, signature validation, installation/repository authorization, audit metadata, and mapping helpers used by this protocol live in [`packages/github/src/index.ts`](../packages/github/src/index.ts) and are covered by adversarial fixtures. The App is the authoritative Check Run and inline-comment publisher; the Action `publish()` path is a fork/degraded fallback only.
