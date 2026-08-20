# Release TODO

This is the remaining work required to make Tinkerbot a production release. It separates repository work from provider-owned work so that a local implementation or a placeholder variable is never mistaken for a completed launch gate.

## Internal product and engineering

### Hosted web application

- [ ] Replace the browser's development-preview authentication with the deployed WorkOS session flow.
- [ ] Live-validate Overview, Factories, Work orders, Findings, GitHub integrations, Usage, Billing, and Settings against the deployed Worker APIs.
- [ ] Implement and authorize the currently preview-only writes: repository connection/settings, policy assignment, hosted baseline state, settings persistence, and integration management.
- [ ] Persist organization selection in the web app and refresh all organization-scoped data after a switch.
- [ ] Connect GitHub App installation and repository-sync state to the Integrations and Repositories views.
- [ ] Complete live billing UX: checkout, portal, cancellation/reactivation, past-due recovery, and truthful status/error states.
- [ ] Define and implement a supported notifications delivery path, or remove unavailable notification controls from the release surface.
- [ ] Add browser end-to-end tests for authentication, authorization failures, organization switching, invitations, billing state, and sign-out.
- [ ] Perform responsive, keyboard, screen-reader, and visual QA against the deployed web app.

### Control plane and data model

- [ ] Confirm seat-based Stripe catalog (no private-repository or member caps) with live Price IDs; factory entitlements stay in `features_json`.
- [ ] Add scheduled Stripe reconciliation and alerting for missed or failed webhook processing.
- [ ] Verify all entitlement checks cover repository access, seat limits, retention, policy features, audit access, and assurance ingestion.
- [ ] Add production observability: structured error logging, request correlation, alerts, and an operational runbook.
- [ ] Define retention/deletion handling for D1 and R2 data, including organization offboarding.
- [ ] Test database migrations and rollback/forward-recovery on production-shaped data.
- [ ] Establish backup, restoration, and incident-response procedures for hosted metadata.

### Optional GitHub adapter and GitHub Action

- [ ] If the optional GitHub adapter is in launch scope, register the GitHub App using the Worker routes in `github-app/manifest.json` (homepage, callback, setup, webhook `/integrations/github/webhook`).
- [ ] If enabled, complete App authentication/token-minting configuration and restrict permissions to the minimum required scope.
- [ ] If enabled, test GitHub installation, uninstall, permission change, webhook retry, signature rejection, and replay rejection.
- [ ] If enabled, add repository synchronization and installation state to the hosted app.
- [ ] Configure customer workflows with `id-token: write` so the Action exchanges GitHub OIDC for a run token; do not paste a developer WorkOS session UUID.
- [ ] If enabled, run the Action in a real test repository for App-owned Checks, inline comments, retries, failures, and forked PR behavior (Action publish is fallback only).
- [ ] Publish and pin the versioned Action release (`v0.x.y` and major tag) only after live validation.

### CLI and dashboard

- [ ] Live-test `tb login`, `tb whoami`, `tb logout`, `tb org list`, `tb org switch`, `tb dashboard`, `tb factory`, `tb work`, `tb run`, and `tb verify` against production.
- [ ] Verify dashboard loading, server error, forbidden/entitlement, expired-session, and empty-state paths against the live API.
- [ ] Publish a clear local-versus-hosted command matrix and remove any command that looks available but is unsupported.
- [ ] Build all promised target binaries, including Darwin ARM64 and x64; add Linux targets if they are part of the supported release promise.
- [ ] Sign release binaries, produce checksums and provenance, and make the manifest attest to the actual signing state.
- [ ] Smoke-test fresh installation, upgrade, uninstall, and error recovery on each supported platform.

### Quality, security, and documentation

- [ ] Enforce the documented Vitest coverage bar: **94%** global statements, functions, and lines (`vitest.config.ts`). Do not claim 98% while measuring ~94%.
- [ ] Add branch thresholds to coverage configuration and remove exclusions that prevent the release metric from measuring shipped code.
- [ ] Run final lint, typecheck, complete test suite, coverage suite, CLI package build, and clean-install smoke tests on the release commit.
- [ ] Run security/dependency/license review and fix or accept findings through a documented release decision.
- [ ] Review all public documentation, CLI help, Action README, installation paths, architecture docs, ADRs, pricing, support contacts, and examples for consistency with the deployed product.
- [ ] Write release notes, a changelog entry, support escalation path, incident response/runbook, and rollback procedure.

### Distribution

- [ ] Publish the approved package to the intended private npm registry and test both npm and Bun installation paths.
- [ ] Host signed archives and the signed manifest on the production HTTPS download origin.
- [ ] Test the curl installer from a clean machine and ensure it verifies checksums/signatures before execution.
- [ ] Publish the Homebrew tap/formula after both Darwin archives, checksums, and signatures are available.
- [ ] Test package/binary installation and upgrades from clean environments, not a workspace checkout.

See [hosted provisioning](./hosted-provisioning.md) for the operator checklist (Stripe, WorkOS, Cloudflare D1/Sandbox, and optional GitHub adapter). Code cannot provision those accounts.

### Cloudflare

- [ ] Authenticate the approved production deploy identity. Wrangler is currently unauthenticated in this environment.
- [ ] Create **separate** D1 databases for staging and production (wrangler currently uses placeholder `database_id` values; replace them with real IDs after `wrangler d1 create`). Never share one D1 across environments.
- [ ] Bind a real Cloudflare Sandbox implementation (`env.Sandbox`); the Worker stub returns 501 until the account has the container/SDK.
- [ ] Verify the newly enabled R2 account, create/confirm the evidence bucket, bind it as `EVIDENCE_BUCKET` in staging and production, apply required migrations, and configure R2 retention/lifecycle rules.
- [ ] Set Worker core secrets interactively or through the approved secret manager: WorkOS credentials, Stripe credentials, and session encryption key. Add GitHub webhook/App secrets only if that optional adapter is enabled.
- [ ] Set non-secret production variables, including the final `STRIPE_PLANS_JSON` catalog and approved WorkOS event-sync configuration.
- [ ] Validate `GET /health` (`ok`/`degraded` only) and authenticated `GET /config/status` after deployment. Never leave provider secret names on the public health route.

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

### Optional GitHub adapter

- [ ] If the optional adapter is in scope, register the production GitHub App with its final name, public homepage, callback URL, webhook URL, permissions, and events.
- [ ] If enabled, securely store the App ID, private key/token-minting material, and rotated webhook secret using the approved secret mechanism.
- [ ] If enabled, install the App in a dedicated production-like test organization and test repository.
- [ ] Create production Action secrets/variables and branch-protection expectations for the customer-facing workflow.
- [ ] Confirm Marketplace/public-distribution requirements if either the optional App or Action will be publicly listed.

### Registry, signing, download host, and Homebrew

- [ ] Provision registry publication credentials and decide package visibility/access.
- [ ] Provision an artifact signing and provenance solution, including key custody and verification instructions.
- [ ] Provision the HTTPS archive/manifest origin and configure immutable versioned paths.
- [ ] Create/authorize the Homebrew tap and configure its release automation or maintainer workflow.

## Release execution and acceptance

- [ ] Freeze a release candidate commit and verify a clean working tree.
- [ ] Obtain green GitHub CI on that exact commit.
- [ ] Deploy to staging and run the full cross-surface acceptance suite: dashboard, Worker, WorkOS, Stripe, CLI, and any optional adapters selected for launch (including GitHub Action/App if enabled).
- [ ] Verify that no source code, full diffs, credentials, or raw secrets can enter hosted assurance ingestion, logs, artifacts, or comments.
- [ ] Exercise failure paths: unavailable providers, invalid/replayed webhooks, unauthorized org access, expired sessions, failed billing, Action retry, and rollback.
- [ ] Produce and sign release artifacts; verify them independently on clean machines.
- [ ] Obtain explicit release-owner approval for pricing, legal/privacy posture, support ownership, and rollback readiness.
- [ ] Deploy production, run post-deploy smoke tests, publish release notes, and monitor the first production window.

## Completed source foundations (not release approvals)

- Factory contracts, D1 schema, Worker queue/workflow path, PKCE auth, dashboard APIs, OIDC exchange, GitHub App publisher, seat billing, and CLI factory/work/run commands are implemented in source.
- Worker routes for WorkOS, Stripe, GitHub lifecycle, tenant access, billing, and assurance are implemented.
- The GitHub Action emits an assurance bundle and supports OIDC ingest when configured; App publication is the intended Check identity.
- Dashboard pages call Worker factory/work/run APIs; live data still requires a deployed control plane.
- Distribution scripts, Homebrew formula rendering, a curl installer, and the Stripe catalog example are present, but publication and signing are not complete. The OpenTUI client has been retired.
