# Release TODO

This is the remaining work required to make Tinkerbot a production release. It separates repository work from provider-owned work so that a local implementation or a placeholder variable is never mistaken for a completed launch gate.

## Internal product and engineering

### Hosted web application

- [ ] Replace the browser's development-preview authentication with the deployed WorkOS session flow.
- [ ] Connect overview, repositories, runs, findings, policies, baselines, change sets, releases, outcomes, and integrations to authoritative hosted data rather than bundled preview data.
- [ ] Implement and authorize the currently preview-only writes: repository connection/settings, policy assignment, hosted baseline state, settings persistence, and integration management.
- [ ] Persist organization selection in the web app and refresh all organization-scoped data after a switch.
- [ ] Connect GitHub App installation and repository-sync state to the Integrations and Repositories views.
- [ ] Complete live billing UX: checkout, portal, cancellation/reactivation, past-due recovery, and truthful status/error states.
- [ ] Define and implement a supported notifications delivery path, or remove unavailable notification controls from the release surface.
- [ ] Add browser end-to-end tests for authentication, authorization failures, organization switching, invitations, billing state, and sign-out.
- [ ] Perform responsive, keyboard, screen-reader, and visual QA against the deployed web app.

### Control plane and data model

- [ ] Reconcile the paid-plan repository-limit policy across the control-plane catalog, hosted-integration schema, UI copy, and the Stripe catalog before launch. The current product catalog describes unlimited paid repositories while the deployable Stripe schema requires explicit numeric limits.
- [ ] Add scheduled Stripe reconciliation and alerting for missed or failed webhook processing.
- [ ] Verify all entitlement checks cover repository access, seat limits, retention, policy features, audit access, and assurance ingestion.
- [ ] Add production observability: structured error logging, request correlation, alerts, and an operational runbook.
- [ ] Define retention/deletion handling for D1 and R2 data, including organization offboarding.
- [ ] Test database migrations and rollback/forward-recovery on production-shaped data.
- [ ] Establish backup, restoration, and incident-response procedures for hosted metadata.

### GitHub App and GitHub Action

- [ ] Replace GitHub App manifest placeholder URLs with canonical production URLs.
- [ ] Complete App authentication/token-minting configuration and restrict permissions to the minimum required scope.
- [ ] Test GitHub installation, uninstall, permission change, webhook retry, signature rejection, and replay rejection.
- [ ] Add repository synchronization and installation state to the hosted app.
- [ ] Configure the Action with an appropriate short-lived production service credential; do not rely on a developer's personal session token.
- [ ] Run the Action in a real test repository for PR Checks, annotations, sticky comments, retries, failures, and forked PR behavior.
- [ ] Decide and document the public check identity: Action-owned check versus GitHub-App-owned check.
- [ ] Publish and pin the versioned Action release (`v0.x.y` and major tag) only after live validation.

### TUI and CLI

- [ ] Implement a supported interactive/device/browser login flow for `tb login`, or document and ship a secure alternative credential-bootstrap workflow.
- [ ] Live-test `tb whoami`, `tb logout`, `tb org list`, `tb org switch`, `tb tui`, and `tb verify` against production.
- [ ] Verify the TUI’s loading, refresh, cancellation, server error, forbidden/entitlement, expired-session, empty-state, and verification-submission paths against the live API.
- [ ] Publish a clear local-versus-hosted command matrix and remove any command that looks available but is unsupported.
- [ ] Build all promised target binaries, including Darwin ARM64 and x64; add Linux targets if they are part of the supported release promise.
- [ ] Sign release binaries, produce checksums and provenance, and make the manifest attest to the actual signing state.
- [ ] Smoke-test fresh installation, upgrade, uninstall, and error recovery on each supported platform.

### Quality, security, and documentation

- [ ] Raise and enforce **unified** coverage to at least 98% for branches, functions, lines, and statements across all packages, including TUI sources.
- [ ] Add branch thresholds to coverage configuration and remove exclusions that prevent the release metric from measuring shipped code.
- [ ] Run final lint, typecheck, complete test suite, coverage suite, TUI build, CLI package build, and clean-install smoke tests on the release commit.
- [ ] Run security/dependency/license review and fix or accept findings through a documented release decision.
- [ ] Review all public documentation, CLI help, Action README, installation paths, architecture docs, ADRs, pricing, support contacts, and examples for consistency with the deployed product.
- [ ] Write release notes, a changelog entry, support escalation path, incident response/runbook, and rollback procedure.

### Distribution

- [ ] Publish the approved package to the intended private npm registry and test both npm and Bun installation paths.
- [ ] Host signed archives and the signed manifest on the production HTTPS download origin.
- [ ] Test the curl installer from a clean machine and ensure it verifies checksums/signatures before execution.
- [ ] Publish the Homebrew tap/formula after both Darwin archives, checksums, and signatures are available.
- [ ] Test package/binary installation and upgrades from clean environments, not a workspace checkout.

## External accounts, credentials, and configuration

### Cloudflare

- [ ] Authenticate the approved production deploy identity. Wrangler is currently unauthenticated in this environment.
- [ ] Confirm the Cloudflare account, Worker names, production domain, route, and deployment approval path.
- [ ] Create/verify production D1 and R2 bindings; apply all required migrations; configure R2 retention/lifecycle rules.
- [ ] Set Worker secrets interactively or through the approved secret manager: WorkOS credentials, Stripe credentials, session encryption key, and GitHub webhook secret.
- [ ] Set non-secret production variables, including the final `STRIPE_PLANS_JSON` catalog and approved WorkOS event-sync configuration.
- [ ] Validate Worker health/config status and every protected endpoint after deployment.

### WorkOS

- [ ] Register the production application, callback URL, and webhook endpoint.
- [ ] Supply the rotated client/API/webhook credentials through Cloudflare secrets.
- [ ] Enable the required organization, membership, role, and invitation events.
- [ ] Test sign-in, callback validation, session refresh, sign-out, organization membership sync, invitations, and webhook replay handling.

### Stripe

- [ ] Create or verify the six live recurring Prices: Developer monthly/yearly, Team monthly/yearly, and Business monthly/yearly.
- [ ] Replace all `price_REPLACE_*` values in `config/stripe-plans.production.json.example` in the deployment catalog; never deploy the example unchanged.
- [ ] Confirm pricing, currency, tax behavior, trial/coupon policy, seat quantity behavior, customer portal configuration, and cancellation behavior with the commercial owner.
- [ ] Add the final JSON as the non-secret `STRIPE_PLANS_JSON` Worker variable.
- [ ] Store the rotated Stripe secret key and webhook signing secret in Cloudflare.
- [ ] Register the production Stripe webhook and test checkout completion, subscription updates, cancellation/reactivation, payment failures, duplicate delivery, and replay protection.

### GitHub

- [ ] Register the production GitHub App with its final name, public homepage, callback URL, webhook URL, permissions, and events.
- [ ] Securely store the App ID, private key/token-minting material, and rotated webhook secret using the approved secret mechanism.
- [ ] Install the App in a dedicated production-like test organization and test repository.
- [ ] Create production Action secrets/variables and branch-protection expectations for the customer-facing workflow.
- [ ] Confirm Marketplace/public-distribution requirements if either the App or Action will be publicly listed.

### Registry, signing, download host, and Homebrew

- [ ] Provision registry publication credentials and decide package visibility/access.
- [ ] Provision an artifact signing and provenance solution, including key custody and verification instructions.
- [ ] Provision the HTTPS archive/manifest origin and configure immutable versioned paths.
- [ ] Create/authorize the Homebrew tap and configure its release automation or maintainer workflow.

## Release execution and acceptance

- [ ] Freeze a release candidate commit and verify a clean working tree.
- [ ] Obtain green GitHub CI on that exact commit.
- [ ] Deploy to staging and run the full cross-surface acceptance suite: web app, Worker, WorkOS, Stripe, GitHub App, GitHub Action, CLI, and TUI.
- [ ] Verify that no source code, full diffs, credentials, or raw secrets can enter hosted assurance ingestion, logs, artifacts, or comments.
- [ ] Exercise failure paths: unavailable providers, invalid/replayed webhooks, unauthorized org access, expired sessions, failed billing, Action retry, and rollback.
- [ ] Produce and sign release artifacts; verify them independently on clean machines.
- [ ] Obtain explicit release-owner approval for pricing, legal/privacy posture, support ownership, and rollback readiness.
- [ ] Deploy production, run post-deploy smoke tests, publish release notes, and monitor the first production window.

## Completed source foundations (not release approvals)

- Hosted CLI/TUI adapters and source-minimized assurance ingestion are implemented.
- Worker routes for WorkOS, Stripe, GitHub lifecycle, tenant access, billing, and assurance are implemented.
- The GitHub Action emits an assurance bundle and supports hosted ingest when configured.
- Web routes and the local report viewer are implemented; many web screens remain preview data until the hosted wiring above is complete.
- Distribution scripts, Homebrew formula rendering, a curl installer, and the Stripe catalog example are present, but publication and signing are not complete.
