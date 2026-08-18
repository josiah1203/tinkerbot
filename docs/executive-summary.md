# Tinkerbot executive summary

## Decision summary

Tinkerbot is a local-first change-assurance product with a substantial implementation base across a CLI, terminal UI, GitHub Action, GitHub App integration foundation, Cloudflare control plane, browser control-plane interface, billing contract, and release packaging scripts. It is **not ready for a production release**.

The source code provides a credible release candidate foundation, but the hosted product has not been deployed or validated with its required providers. Several browser surfaces still intentionally render local preview data or expose unavailable actions rather than claim a live capability. The release should remain blocked until the internal product gaps and external provider configuration/acceptance gates below are complete.

## Product and repository scope

Tinkerbot is designed to help teams assess a pull request or change through structured, source-minimized evidence: verification results, findings, coverage, impact, policy state, receipts, and explicit unknowns. It is intentionally advisory; it does not own merges, deployments, or source code.

The repository contains these principal surfaces:

| Surface | Role | Current state |
| --- | --- | --- |
| Core engine | Local change/verification evidence and reports | Implemented and tested as the underlying product foundation. |
| CLI (`tb`) | Local workflows plus hosted identity, organization, verification, and TUI entry points | Hosted commands are implemented but require an HTTPS control-plane URL and authenticated session token. A user-facing `tb login` flow is not yet shipped. |
| TUI | Terminal investigation and hosted verification experience | Implemented, renderable, and test-covered; live behavior cannot be accepted without a deployed authenticated control plane. |
| GitHub Action | Runs assurance in CI and posts a source-minimized bundle | Implemented; needs a real GitHub workflow/repository validation and production service authentication. |
| GitHub App foundation | Install/callback/webhook lifecycle and repository context | Server-side foundation exists; App registration, key/token minting, public URLs, installation, and live validation remain. |
| Cloudflare control plane | Hosted authorization, tenant, assurance, GitHub, WorkOS, Stripe, D1/R2 services | Worker endpoints and data contracts exist; no verified production deployment/configuration. |
| Browser control plane | Dashboard, report viewer, settings, team, billing, and assurance navigation | UI/routing is implemented. The local report viewer is usable locally; many hosted screens remain preview data or unpersisted controls. |
| Billing | Stripe checkout, portal, webhooks, entitlement persistence | Backend contract exists; live Prices, webhooks, secrets, reconciliation, and commercial approval remain. |
| Distribution | npm/Bun packaging, curl installer, Homebrew formula rendering, binary manifests | Scripts exist; binaries, signing/provenance, artifact host, registry, tap, and clean-machine release validation remain. |

## What is implemented

### Local product and client foundations

- A TypeScript monorepo with core analysis, CLI, terminal UI, control-plane types, and hosted-integration packages.
- CLI support for hosted identity/session inspection, sign-out, organization listing/switching, hosted verification, and terminal UI launch when the required hosted session is present.
- A full-screen OpenTUI terminal interface with overview, work items, evidence, policy, diff, repositories, runs, releases, command mode, filtering, refresh, cancellation, and recoverable error states.
- Local-first report/evidence exports and protections that reject source, full diffs, credentials, and secrets from hosted assurance ingestion.
- Automated tests across core, CLI, Worker, hosted integration, and TUI source areas.

### Control-plane foundations

- Cloudflare Worker routing for health/config status, WorkOS authorization callback/session/sign-out, tenant access and organizations, invitations, assurance ingest/summary/delete, billing, and provider webhooks.
- D1-backed session, tenant, entitlement, billing, and GitHub lifecycle contracts, with repository migrations.
- WorkOS integration primitives for authentication, organization/membership synchronization, roles, invitations, and replay-safe webhook processing.
- Stripe integration primitives for Checkout, customer portal, cancellation/reactivation, webhook signature handling, subscription persistence, and entitlement updates.
- GitHub webhook/callback handling with signature/replay protections and installation/repository lifecycle data.

### GitHub and release foundations

- A GitHub Action that produces an assurance bundle, supports hosted ingestion, and can create Check Run annotations and a maintained PR comment.
- GitHub App manifest/lifecycle documentation and ADRs that distinguish the App’s identity/webhook role from the Action’s execution role.
- Package build, archive, manifest, curl-install, and Homebrew-formula generation scripts.
- Release, distribution, Cloudflare, billing, GitHub Action, and architecture documentation, including a release-readiness contract and TODO list.

## Material incompleteness

### 1. Hosted service is not operating in production

The primary release blocker is operational rather than syntactic. The Worker has not been verified as a deployed production service with its storage bindings, routes, secrets, monitoring, and rollback posture. The available environment does not currently have an authenticated Wrangler session, so Cloudflare deployment, secret provisioning, D1 migration, and R2 validation have not been performed.

Required work:

- Authenticate the approved Cloudflare deployment identity.
- Confirm production Worker URL/domain, D1 and R2 bindings, migrations, retention policy, secrets, observability, alerting, backups, and restoration procedures.
- Run health, authorization, assurance, billing, and webhook acceptance tests against the deployed service.

### 2. Browser control plane is not a fully live web application

The browser interface is a well-developed UI shell, but it deliberately contains preview data and unavailable controls in many product areas. This is correct behavior for an unconfigured environment, but it means the web app is not complete as a release surface.

Required work:

- Replace development-preview browser authentication with the deployed WorkOS session flow.
- Read and persist authoritative hosted state for repositories, runs, findings, policies, baselines, change sets, releases, outcomes, integrations, settings, and organization selection.
- Wire live GitHub installation/synchronization state into the UI.
- Complete hosted billing, team/invitation, and notification user journeys.
- Run end-to-end, accessibility, responsive, and visual tests against the deployed application.

### 3. Identity, billing, and GitHub providers are unconfigured

Provider code is not provider readiness. Rotated secrets and account configuration must be supplied through the approved secret-management path and validated in live environments.

Required external configuration:

- **WorkOS:** production application, redirect URI, webhook endpoint, rotated client/API/webhook credentials, enabled organization/membership/invitation events.
- **Stripe:** six live recurring Price IDs (Developer, Team, Business; monthly and annual), secret key, webhook secret, portal/tax/seat/cancellation policies, and live webhook tests.
- **GitHub:** production App registration, canonical homepage/callback/webhook URLs, App ID, private key/token minting material, webhook secret, permissions/events, and installation in a test organization.

The Stripe catalog example is in `config/stripe-plans.production.json.example`. It is intentionally not deployable unchanged: all `price_REPLACE_*` identifiers must be replaced with approved live Price IDs. The product’s paid-repository-limit policy also needs reconciliation because one catalog describes unlimited paid repositories while the deployable hosted schema currently requires numeric limits.

### 4. GitHub integration is not yet a released bot experience

The intended pull-request experience is clear: a visible Tinkerbot Check Run, actionable annotations, and one maintained summary comment. Today, the Action can create that output using a workflow token. The separate GitHub App is not yet registered/configured, so it does not yet provide an installed bot identity, live repository authorization, or webhook lifecycle in production.

Required work:

- Register/configure/install the App and verify token minting, callback, webhook, replay, uninstall, and permission-change behavior.
- Configure the Action’s production URL and a short-lived service credential rather than a developer session token.
- Validate Checks, annotations, sticky comments, retries, failed runs, and forked PRs in a real test repository.
- Decide and document whether checks are Action-owned or App-owned in the public product experience.

### 5. CLI/TUI cannot yet be accepted as a hosted release client

The terminal UI launches in development and visibly reports its hosted configuration state. The supported release entry point correctly refuses to start without `TINKERBOT_CONTROL_PLANE_URL` and `TINKERBOT_SESSION_TOKEN`. This safeguards users, but the endpoint/session path is not a complete end-user onboarding flow.

Required work:

- Implement a supported interactive/device/browser login journey for `tb login`, or ship a secure documented credential bootstrap process.
- Validate terminal commands and TUI error/recovery/verification states against a real hosted tenant.
- Build all promised architecture binaries, including both Darwin ARM64 and x64; add Linux targets if they are claimed.
- Sign artifacts and publish checksums/provenance that reflect actual verification.

### 6. Quality gates do not meet the requested release threshold

The requested standard is at least 98% coverage for branches, functions, lines, and statements across every shipped package. The repository does not yet meet or enforce that standard globally:

- Existing global coverage configuration excludes TUI code and does not enforce a branch threshold.
- The recorded global baseline is below 98%, particularly branches.
- Latest isolated TUI coverage is approximately 98.61% lines and 95.05% functions; Bun does not provide the requested unified branch/statement report in that result.

Required work:

- Establish one unified coverage report that includes TUI and every shipped package.
- Add branch, function, line, and statement thresholds of 98%.
- Write tests to meet those thresholds without weakening exclusions or baselines.
- Run the complete quality suite on the exact release commit.

### 7. Distribution is scaffolded, not published

The repository can build release-client archives and render installers/formulae, but no complete signed release distribution has been produced.

Required work:

- Provision registry credentials and decide private/public package access.
- Publish and clean-install the package through npm and Bun.
- Produce signed multi-architecture archives, a truthful signed manifest, and provenance.
- Provision an HTTPS download host and validate curl installation on clean machines.
- Create/authorize the Homebrew tap and validate the formula with both Darwin architectures.

## Risk assessment

| Risk | Current posture | Required mitigation |
| --- | --- | --- |
| False production readiness | High | Keep release blocked until live end-to-end acceptance is complete. |
| Provider misconfiguration | High | Use approved secret management, staging validation, webhook tests, and production smoke tests. |
| Browser/UI overstatement | Medium-high | Remove or complete preview-only controls; retain truthful unavailable states until live wiring exists. |
| Billing entitlement mismatch | High | Reconcile plan policy/schema, configure real Prices, and test lifecycle/reconciliation. |
| GitHub trust/identity ambiguity | Medium-high | Register the App and explicitly define Action-versus-App check ownership. |
| Client onboarding friction | Medium | Ship terminal login/session bootstrap and clean-machine install tests. |
| Quality regression | High under the requested standard | Enforce unified 98% coverage in CI and run all final gates. |
| Artifact integrity | High | Sign binaries/manifests and independently verify fresh installations. |

## Recommended release sequence

1. Resolve internal policy/schema decisions, especially billing limits, check ownership, supported platforms, and login design.
2. Deploy a staging control plane and configure WorkOS, Stripe, and GitHub App test identities.
3. Wire and test the browser app against authoritative staging APIs.
4. Complete live acceptance across web, Worker, GitHub, Action, CLI, and TUI; exercise failures and rollback.
5. Meet the unified 98% coverage gate and green CI on a frozen release candidate.
6. Build, sign, host, and independently verify client artifacts and installers.
7. Obtain release-owner approval for pricing, privacy/legal, support, rollback, and production provider settings.
8. Deploy production, perform post-deploy smoke tests, and monitor the initial release window.

## Release recommendation

**Do not publish as a production release yet.** Continue implementation and integration work under a staging-first plan. The source demonstrates a strong foundation, but the product requires live provider configuration, browser/control-plane completion, security/operational validation, universal coverage enforcement, and signed distribution before it can make reliable hosted-product promises.

For the detailed execution checklist, see [Release TODO](./release-todo.md). For external release inputs and validation requirements, see [Release readiness](./release-readiness.md).
