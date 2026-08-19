# Tinkerbot repository executive summary

## 1. Executive decision

Tinkerbot is a broad, mostly implemented software production operating system for change assurance. The repository contains a deterministic local verification engine, a `tb` command-line client, a tabbed terminal master, a Cloudflare control plane, a factory/work-order model, GitHub Action and GitHub App integrations, seat-based billing, evidence and release contracts, and a browser control tower.

The source implementation is substantial enough for a controlled staging pilot. It is **not yet a production release**. The remaining work is a mixture of high-impact security corrections, release packaging, configuration alignment, live-provider provisioning, and end-to-end validation. The repository itself should not be described as fully released merely because the local source tests pass.

This summary describes the tree at the audit snapshot:

- Commit: `e05a940` (`Refactor application structure and simplify implementation`)
- Working tree: clean at audit time
- Audit date: 2026-08-19
- Primary runtime: Node.js/TypeScript locally; Cloudflare Workers and D1/R2/Queues/Workflows in hosted mode
- Primary product name: `tinkerbot`; `tb` is the supported CLI name; `tinkerbot` is an alias; `pr-proof` is a deprecated compatibility alias

### Release recommendation

Hold the public production release until the P0/P1 items in section 10 are closed and verified in a real staging account. The most important technical blocker is that the Action OIDC exchange currently decodes JWT claims but does not verify the JWT signature against the issuer's JWKS. That is an authenticity failure at the boundary that grants a customer repository a hosted run token. It must be fixed before relying on the hosted admission path.

The second class of blocker is release integrity: most of the documented `.tinkerbot/` factory tree is ignored by Git, compiled `dist/` artifacts are not tracked in the checkout, the Action wrapper expects compiled files, and the production Stripe variable is still empty/placeholder-oriented. These are solvable release-engineering issues, but they make a source checkout materially different from the artifact a customer would consume.

## 2. Product definition and boundaries

Tinkerbot treats software change as a governed production flow:

```text
intent or event
  -> admission and normalization
  -> factory / production-line routing
  -> work-cell lease and specialist stages
  -> implementation in an isolated runner
  -> deterministic verification on the customer runner
  -> evidence, receipts, and change-contract assessment
  -> human or policy decision
  -> release assessment and deployment/outcome record
  -> governed factory improvement proposal
```

The conceptual hierarchy is:

```text
Organization
  Portfolio
    Product
      Factory
        Production line
          Work cell
            Work order
              Run -> stages -> evidence -> decision -> release -> outcome
```

The control plane coordinates this graph. It does not become the source of truth for repository verification: `tb check` on the customer runner remains the final authority for the verification verdict. Tinkerbot also deliberately does not:

- merge pull requests or own customer repository merge policy;
- use `pull_request_target` for untrusted code;
- execute `kubectl` or deploy directly into a customer cluster;
- bill by model tokens or by run count;
- let an agent rewrite a finding, evidence record, severity, or pass/fail verdict;
- let a Factory Steward silently activate its own policy or prompt changes;
- claim a release artifact is signed before the signing/provenance workflow exists.

The hosted product is an exception-first control tower at `/app`. The terminal interface remains available as `tb tui`; it is a client/operator surface, not a replacement for the hosted dashboard.

## 3. Repository map

The root package (`@tinkerbot/cli`, version `0.1.0`) owns the TypeScript build, the public binaries, release scripts, Action packaging, and the top-level test/coverage commands. The workspace includes `packages/*` and `apps/*`. Most functional packages are source modules compiled by the root TypeScript project rather than independently published npm packages.

| Area | Responsibility | Current role |
| --- | --- | --- |
| `packages/core` | Config, report schema, findings, verdicts, safety, common assurance types, tool version | Shared domain contract and local verdict model |
| `packages/git` | Safe Git revision/diff/file/worktree/command adapters | Repository and revision boundary |
| `packages/parser` | Source-language parsing and changed-symbol analysis | Structural change understanding |
| `packages/language-core`, `packages/language-validation` | Language front-end discovery and support validation | TypeScript/JavaScript, Python, Go, Rust, C, and C++ support paths |
| `packages/coverage` | LCOV, Istanbul, Go coverprofile, gcov, coverage.py, llvm-cov readers; changed-line coverage | Coverage evidence |
| `packages/test-integrity` | Test declarations, assertions, exclusions, non-vacuity, tolerance erosion | Determines whether tests are meaningful |
| `packages/mutation` | Mutation planning/execution/reporting | Detects tests that pass without detecting behavior changes |
| `packages/impact-analysis` | Direct, downstream, route, public API, dynamic, generated, and unknown impact | Test selection and risk explanation |
| `packages/baseline` | Existing/resolved/new/waived/expired/stale finding state | Prevents old findings from being silently treated as new passes |
| `packages/policy` | Policy and rule interpretation | Configurable decision inputs |
| `packages/contracts` | API/consumer contract analysis | Change compatibility checks |
| `packages/provenance` | Source/test provenance records | Evidence lineage |
| `packages/artifacts` | SARIF, JUnit, coverage, mutation, and generic evidence parsing | External artifact ingestion |
| `packages/fixtures` | Fixture-impact and fixture-integrity checks | Test-data safety |
| `packages/history` | Append/read/compare local histories | Local finding lifecycle and history |
| `packages/reporters` | Human, JSON, Markdown, SARIF and machine-readable output | Local and CI presentation |
| `packages/assurance` | Receipts, evidence contracts, change contracts, lifecycle events, graphs, release/outcome records, assurance bundles, agent admission | Cross-surface integrity layer |
| `packages/factory` | Factory definitions, stages, work orders, transitions, agent policy, Sandbox plan, OIDC claim helpers | Factory OS domain model and local orchestration helpers |
| `packages/control-plane` | Entitlement catalog, roles, plan capabilities, billing policy, browser-side adapters | Shared hosted control-plane contracts |
| `packages/hosted-integrations` | WorkOS, Stripe, D1, R2, GitHub publication, webhook, and hosted evidence adapters | Provider and storage boundary |
| `packages/github` | GitHub repository and assurance publication helpers | Checks, comments, dedupe, and repository integration |
| `packages/gitlab` | GitLab intake and OIDC/MR/issue integration | Optional GitLab path; no merge ownership |
| `packages/cli` | Command dispatch, auth/session storage, local check, hosted commands, reports, doctor, and TUI bridge | Public `tb` client |
| `packages/tui` | Terminal master, tabs, PTY/child process handling, chrome and agent detection | Interactive operator console |
| `apps/control-plane-worker` | Cloudflare Worker, D1 stores, auth, queues, workflow, billing, webhooks, hosted factory runtime | Production control plane source |
| `apps/control-plane` | Static dashboard shell, browser data model, local server for development | Browser control tower and local preview |
| `action` and `action.yml` | Customer-runner Action, local artifacts, OIDC exchange, hosted ingest, annotations/comments/check runs | CI execution and publication bridge |
| `github-app` | App manifest and protocol documentation | Registration/install contract for the GitHub App |
| `docs`, `docs/adr`, `scripts`, `fixtures`, `.github` | Operating model, ADRs, release tooling, security fixtures, examples, CI | Product and release governance |

## 4. Local verification engine

The local engine is the most mature and testable part of the repository. It creates a unified report from a base and head revision and can evaluate:

1. configuration and repository identity;
2. changed files, hunks, symbols, and language support;
3. test-integrity and non-vacuity signals;
4. changed-line and imported coverage data;
5. mutation outcomes;
6. impact analysis and bounded/unknown paths;
7. API/consumer contracts;
8. fixtures, artifacts, baseline state, provenance, and policy;
9. release and assurance contracts;
10. machine-readable and human-readable reports.

The verdict model is explicit: `PASS`, `FAIL`, `NEEDS_REVIEW`, or `UNKNOWN`. Unknowns are retained as evidence and are not converted into passes. The report schema deliberately distinguishes findings, limitations, evidence, baselines, and summary metrics instead of presenting a single opaque score.

The CLI exposes both narrow commands (`tb check`, `tb verify`, `tb test-integrity`, `tb impact`, `tb contracts`, `tb select-tests`, `tb baseline`, `tb policy`, `tb artifacts`, `tb history`) and hosted/factory commands (`tb factory`, `tb work`, `tb cell`, `tb product`, `tb skill`, `tb evolution`, `tb run`, `tb receipt`, `tb release`, `tb outcome`, `tb evidence`, `tb change`, `tb change-set`). `tb serve` is intentionally retired as a product surface and returns the documented exit code rather than impersonating the hosted control plane.

## 5. Assurance and evidence model

`packages/assurance` is the integrity spine between local verification, hosted orchestration, and release records. It provides:

- canonical serialization and stable identifiers;
- verification receipts with repository, base/head, tool, provider, harness, definition, input, and output references;
- evidence contracts and source-minimized evidence references;
- change contracts and their assessment;
- finding lifecycle events and freshness assessment;
- verification graphs and coverage comparisons;
- agent execution receipts and admission checks;
- change sets, release manifests, release-safety assessments, runtime outcomes, and decision records;
- assurance bundles for hosted ingestion and audit/export paths;
- reviewer calibration and advisory external evidence adapters.

The factory also has HMAC-style signed-record helpers for internal records. That is separate from release artifact signing. The generated client manifest currently records `signed: false`; checksums alone are not a production signing/provenance system.

## 6. Factory operating system

Factory-as-code is represented by `.tinkerbot/factory.yaml` plus the intended companion tree (`product.yaml`, `lines/`, `skills/`, `agents/`, `automations/`, `runners/`, `autonomy.yaml`, `evolution.yaml`, and the change-contract shape). Definitions are parsed, validated, canonicalized, and hashed. The digest is carried into work orders and receipts so a run can be related to the exact factory definition used.

The supported factory stages are:

```text
foreman -> triage -> specification -> architecture -> implementation
         -> test -> review -> security -> verification -> release -> outcome
```

The domain includes explicit work-order states, idempotent transitions, stage results, leases, human approvals, retry/cancel/steer/take/return operations, release candidates, rollback work orders, and outcome records. The Factory Steward may propose improvements, but proposals require a separate human approval/activation path.

The implementation boundary is intentionally split:

- Cloudflare Worker/Workflow/Queue coordinates and records the run.
- A Cloudflare Sandbox work cell is intended to perform implementation on a `tinkerbot/*` branch.
- GitHub Actions remains the customer-controlled verification runner and submits the `tb check` result through Action OIDC.
- Merge remains outside Tinkerbot's authority.

The source supports the Sandbox protocol, but the current `wrangler.jsonc` does not declare a `Sandbox` binding. The runtime therefore returns an incomplete/unknown implementation result when no binding is present. This is a real deployment prerequisite, not a documentation-only feature.

### Factory source-integrity issue

The current repository tracks only `.tinkerbot/factory.yaml`. The `.gitignore` rule `.tinkerbot/*` ignores the documented agents, skills, lines, autonomy, and evolution files. This means the documentation and starter model describe a richer factory tree than the main checkout actually carries. Before shipping factory-as-code as a reproducible product contract, either the intended files must be committed explicitly or the ignore rules and packaging model must be redesigned and tested.

## 7. Hosted control plane and dashboard

The Worker is configured as `tinkerbot-control-plane` with staging and production environments. The intended runtime uses:

- D1 for tenancy, sessions, billing, installations, factory definitions, work orders, runs, events, decisions, and provider ledgers;
- R2 for evidence and structured assurance payloads;
- Queues for factory event admission and retry;
- a Durable Object (`FOREMAN`) for serialized coordination;
- a Workflow (`FACTORY_RUN`) for multi-stage execution;
- Workers AI and an AI Gateway for specialist agents and Factory Steward work;
- Vectorize for factory memory;
- Browser Rendering binding for browser-oriented operations;
- Worker Assets for the dashboard shell;
- a scheduled reconciliation job every 15 minutes.

The Worker route surface includes:

- WorkOS PKCE start/callback, session refresh, sign-out, organization listing/switching, invitations, and event/webhook reconciliation;
- Stripe plan/summary, checkout, portal, subscription, and billing webhook/reconciliation paths;
- GitHub App installation, webhook admission, repository tracking, Check Runs, inline comments, and deduplication;
- GitLab intake and webhook paths;
- factory create/list/show/update;
- work-order list/show/create and retry/approve/cancel/steer/take/return actions;
- product, work-cell, skill, evolution, release, outcome, run, event, usage, and integration views;
- Action OIDC exchange followed by assurance-bundle/evidence ingest;
- health/config/provider status routes.

The dashboard is intentionally exception-first: operators should see blocked, failed, unknown, awaiting approval, and release-relevant work before a generic activity feed. It has a static SPA shell and local development server; production data and authentication require the Worker and configured providers.

### Hosted authorization findings

The Worker currently uses a small `TenantCapability` union. Factory and work-order endpoints authorize with `tenant:read`, including mutation paths. Although many individual operations perform organization-ID checks, the role/capability model does not express a separate factory/work-order mutation capability. That is too coarse for least privilege and should be corrected before a multi-tenant production launch.

The run-detail route checks that a run exists but does not perform the same explicit organization ownership check used by work orders. This is a cross-tenant data-isolation risk and should be covered by a negative authorization test and a store query constrained by organization ID.

## 8. Authentication, integrations, and execution surfaces

### WorkOS

The Worker implements server-side WorkOS PKCE, encrypted/expiring sessions, organization membership/role checks, invitations, webhook signature validation, bounded event replay, and a scheduled reconciliation path. The browser control-plane package also has a development-only auth adapter; that adapter must never be treated as production authentication.

### Stripe billing

Billing is per active human seat:

| Plan | Monthly | Annual | Included policy |
| --- | ---: | ---: | --- |
| Free | $0 | — | Hosted public-repository allowance and limited history |
| Developer | $20/seat | $200/seat | Private repositories, full factory pipeline, 90-day history |
| Team | $40/seat | $400/seat | Shared policies/baselines, repository assurance, priority queue, 1-year history |
| Business | $60/seat | $600/seat | Advanced RBAC, SSO/SCIM, hosted API, Change Sets, audit export, 2-year history |
| Enterprise | Contract | Contract | Contract-defined entitlements and retention |

Paid plans intentionally have no seat or repository cap. Team has a 14-day cardless trial. `past_due`/grace keeps verification reads available while blocking premium mutations. AI tokens and run counts are internal fair-use/COGS telemetry, not invoice units.

The source catalog is in `packages/control-plane/src/entitlements.ts`. The JSON configuration is intentionally limited to plan IDs, monthly/annual Stripe Price IDs, and `catalogVersion`. The checked-in example still contains placeholder Price IDs, and `wrangler.jsonc` currently sets `STRIPE_PLANS_JSON` to `[]` in the default/staging variables. Real IDs and a nonempty production variable are external release requirements.

There is also an internal contract drift: `scripts/validate-live-providers.mjs` still expects legacy fields (`privateRepositoryLimit`, `memberLimit`, `retentionDays`, and a boolean `features` map), while the current billing catalog and example JSON explicitly removed those fields. The provider validation script must be brought into agreement with the seat-based catalog before it can be a trustworthy release gate.

### GitHub Action

The Action runs on the customer runner. It prefers GitHub OIDC (`id-token: write`) and keeps `session-token` as a deprecated fallback. It:

1. builds/locates the local CLI;
2. executes deterministic verification;
3. writes local report/SARIF/receipt/evidence artifacts;
4. strips token-like environment values before child execution;
5. exchanges OIDC for a short-lived hosted run token when configured;
6. submits the assurance bundle/evidence;
7. optionally publishes Check Runs, annotations, and comments.

Fork pull requests remain write-disabled. Customer workflows should use `pull_request`, not `pull_request_target`.

The repository's `action/index.js` is only a wrapper that requires `dist/action/index.js`. `dist/` is generated and not tracked in the checkout. A GitHub Action tag consumed by an external repository must therefore include compiled `dist/action` and `dist/packages` artifacts, or the action will fail before producing a report. This must be tested from a clean tagged artifact, not only from a local build.

### GitHub App and GitLab

The GitHub App is a publisher/admission integration: webhook validation, installation/repository association, Check Runs, inline comments, publication dedupe, and control-plane callbacks are present in source. It is not a merge bot. The App still requires registration, production keys, webhook/callback URLs, permissions, installation, and an organization-level smoke test.

GitLab supports intake/webhook and OIDC/MR/issue-shaped paths. It is optional for the initial GitHub-centered release and likewise does not own merge.

### CLI and TUI

The current TUI is a master console implemented in `packages/tui` and bridged from `packages/cli`:

- `tb tui` starts an interactive TTY master;
- `tb tui --once` renders a non-interactive/CI-friendly snapshot;
- tabs cover Check, Work, nested Claude, Gemini, Codex, Cursor, and Shell sessions;
- slash commands include `/check`, `/work`, `/factory`, `/dashboard`, `/tab`, `/help`, and `/exit`;
- `/merge`, `/pass`, `/fail`, and `/approve-verdict` are forbidden;
- nested vendor CLIs own their own OAuth; Tinkerbot does not store vendor tokens.

The TUI is not currently a separate globally published package, and visual QA is not covered by the unit suite. A real TTY smoke test and a scripted `--once`/resize/error-path test should be part of release validation.

## 9. Distribution and documentation

The root package exposes `tb`, `tinkerbot`, and `pr-proof` bins. Release scripts build a Node archive, generate checksums and a manifest, render a Homebrew formula for Darwin architectures, and provide an HTTPS curl installer. npm publication is intended for an approved private registry. Homebrew and curl consume the same release manifest.

The current distribution contract has three important limitations:

1. `manifest.json` deliberately says `signed: false` until signing/provenance exists.
2. Homebrew requires both `darwin-arm64` and `darwin-x64` signed/reproducible archives, but the current packaging script produces only the Node archive unless additional native artifacts are supplied.
3. The curl installer expects a hosted `manifest.json` and archive directory; no approved production release host is represented in this checkout.

The documentation set is unusually broad. Important sources of truth include:

- [`docs/architecture.md`](./architecture.md) for the factory OS and authority boundaries;
- [`docs/control-plane.md`](./control-plane.md) for routes and hosted data flow;
- [`docs/factories.md`](./factories.md) for factory-as-code;
- [`docs/tui.md`](./tui.md) and [`docs/tui-architecture.md`](./tui-architecture.md) for terminal behavior;
- [`docs/billing.md`](./billing.md) and ADR 0004 for the seat catalog;
- [`docs/github-action.md`](./github-action.md) and ADR 0002 for CI/App behavior;
- [`docs/distribution.md`](./distribution.md) and ADR 0003 for client artifacts;
- [`docs/security.md`](./security.md), [`docs/privacy.md`](./privacy.md), and [`docs/release-runbook.md`](./release-runbook.md) for operating constraints;
- [`docs/implementation-status.md`](./implementation-status.md) and [`docs/release-readiness.md`](./release-readiness.md) for declared status and gates.

The official coverage bar is **94%** statements/functions/lines in `vitest.config.ts`, matching measured Vitest output. Do not claim 98% overall.

## 10. Security and integrity assessment

### Positive controls already present

- deterministic verification is separated from agent output;
- unknown and unavailable evidence remain explicit rather than becoming passes;
- agent prompts treat repository/user text as untrusted;
- receipts and evidence are source-minimized and credential-like values are rejected/redacted;
- work-order transitions are explicit and idempotency keys are used;
- Sandbox branch pushes are constrained to `tinkerbot/*` and merge is forbidden;
- Action fork workflows disable GitHub writes;
- CSRF/origin checks are applied to hosted mutation paths;
- webhook ledgers and publication dedupe reduce replay/duplicate publication risk;
- customer-cluster deployment is outside the Worker boundary;
- WorkOS/Stripe webhook signatures and replay handling are represented in source;
- providers and missing configuration fail closed or return explicit unavailable/unknown states in local tests.

### Release-blocking findings

| Priority | Finding | Consequence | Required closure |
| --- | --- | --- | --- |
| P0 | Action OIDC exchange uses `decodeJwtPayload` plus claim comparison; no JWT signature/JWKS verification is performed | A forged token with acceptable-looking claims could obtain a hosted run token | Verify issuer signature, JWKS rotation, `exp`/`nbf`/`iat`, nonce/run binding, and key-cache failure behavior; add forged-signature tests |
| P1 | Factory/work-order mutations are authorized by broad `tenant:read` | Viewer/reviewer role boundaries are not expressed at the capability layer | Add explicit factory/work-order read/write/approve/operate capabilities and negative role tests |
| P1 | Run-detail lookup is not visibly constrained by organization ID | A known run ID may expose another tenant's run/stages | Make the query organization-scoped and test cross-tenant access |
| P1 | No `Sandbox` binding is declared in `wrangler.jsonc` | Implementation stage cannot execute in the deployed Worker | Provision/configure the supported binding and run a staging work-order through implementation |
| P1 | `.tinkerbot/*` ignores most factory definition files | Factory definitions are not reproducible from the main Git checkout | Commit the intended tree or change packaging/ignore rules; add a clean-checkout digest test |
| P1 | Action wrapper requires untracked `dist/action` and `dist/packages` | External `uses: owner/tinkerbot@v1` can fail even when source is correct | Build, package, inspect, and smoke-test the exact release tag |
| P1 | Stripe provider validator expects removed legacy plan fields | Live-provider gate can reject the current valid seat catalog or provide false confidence | Update validator and add catalog/Stripe API contract tests |
| P1 | Coverage ratchet is 94% statements/functions/lines | Matches Vitest; not a 98% all-metrics gate | Keep CI at 94%; do not document 98% |
| P2 | Release artifacts are unsigned | Supply-chain provenance is not established | Add signing, provenance, key custody, verification, and revocation steps |
| P2 | Browser/TUI visual and live integration paths are not covered by the local suite | Layout, auth redirects, provider callbacks, and real App publication can regress unnoticed | Run Playwright, TTY smoke/resize tests, and staging cross-surface scenarios |

The first finding is the one that changes the security posture of the hosted admission path. It should be treated as a release stop even if all local tests remain green.

## 11. Measured quality status

The following commands were run against the audit snapshot:

| Check | Result | Interpretation |
| --- | --- | --- |
| `pnpm build` | Passed | TypeScript compilation succeeds |
| `pnpm test` | Passed: 34 test files, 218 tests | Local unit/integration suite is green; several stderr notices are intentional negative-path fixtures |
| `pnpm test:coverage` | Failed at coverage ratchet | Tests pass, but the checked-in baseline was regressed in CLI, factory, selection, and hosted integrations |
| Coverage overall | 94.80% statements, 79.47% branches, 98.05% functions, 94.80% lines | This is not 98% across all metrics |
| Coverage thresholds in `vitest.config.ts` | 94% statements/functions/lines; branches are reported but not thresholded there | The configuration does not implement an all-metrics 98% gate |
| `scripts/verify-coverage.mjs` | Baseline/long-term ratchet with warnings | It compares package baselines and currently reports regressions |
| Playwright/browser E2E | Not run in this audit | Requires browser installation and a running/valid application target |
| Live provider validation | Not run successfully | Requires real Worker URL, WorkOS, Stripe, webhooks, and nonempty production plan IDs |

Selected measured package results:

| Package/surface | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `packages/core` | 98.3% | 89.0% | 100% | 98.3% |
| `packages/cli` | 94.3% | 81.7% | 97.2% | 94.3% |
| `packages/factory` | 97.5% | 79.9% | 97.6% | 97.5% |
| `packages/hosted-integrations` | 93.6% | 71.1% | 93.9% | 93.6% |
| `apps/control-plane-worker` | 85.2% | 61.4% | 97.9% | 85.2% |
| `action/run.ts` | 99.6% | 54.9% | 100% | 99.6% |

The suite demonstrates meaningful negative-path behavior—invalid configuration, unavailable providers, fork write restrictions, malformed evidence, missing artifacts, invalid webhook signatures, and unsafe filesystem outputs—but passing tests do not remove the live security and configuration gates above.

## 12. External release blockers

These are actions that cannot be completed from a source-only checkout without the corresponding accounts, keys, domains, or release authority:

### Cloudflare

- confirm account/project ownership and DNS for control-plane domains;
- apply all D1 migrations to isolated staging and production databases;
- provision and verify R2 evidence buckets, Queue, Durable Object, Workflow, Workers AI, Vectorize, Browser Rendering, Worker Assets, and the supported Sandbox binding;
- configure secrets and environment-specific vars without committing them;
- validate queue retries, Workflow alarms, R2 lifecycle/retention, observability, and backup/restore procedures;
- deploy staging and production Worker and run health/config/resource checks.

### WorkOS

- create/verify the production client and redirect URI;
- configure organization and membership roles used by the Worker;
- register webhook endpoint and all required event types;
- store webhook secret/API credentials in Cloudflare;
- replay a bounded event range and verify membership/invitation reconciliation;
- exercise login, callback, organization switch, invitation, expiry, and sign-out flows.

### Stripe

- create live and test products/prices for Developer, Team, and Business monthly/annual seat billing;
- replace every placeholder Price ID and populate a nonempty `STRIPE_PLANS_JSON` for the target environment;
- align `validate-live-providers.mjs` with the current catalog schema;
- configure Checkout, Customer Portal, subscription quantity updates, trial, proration, `past_due` grace, cancellation, and webhook replay;
- register and verify all required Stripe webhook events in both test and live modes;
- confirm the server-side active-human-seat count is the only billable quantity.

### GitHub

- register the GitHub App with production callback/webhook URLs and least-privilege permissions;
- create and protect the App private key and webhook secret;
- install the App in a controlled organization and associate repositories;
- verify webhook admission, repository identity, Action OIDC exchange, Check Runs, inline comments, dedupe, fork behavior, and no-merge behavior;
- publish a compiled Action tag containing `dist/action` and `dist/packages` and test it from a clean external repository.

### Release/distribution authority

- decide the approved npm/private registry, archive host, Homebrew tap, and curl base URL;
- build all advertised target archives or narrow the advertised matrix to what actually exists;
- add signing/provenance and verification before changing `signed` to `true`;
- perform a clean install test for npm, Homebrew, and curl on each supported OS/architecture;
- publish changelog, support/security contact, rollback instructions, and the exact release commit/tag.

## 13. Recommended closure sequence

1. **Fix the hosted admission boundary:** implement real GitHub/GitLab OIDC signature validation with JWKS caching/rotation and claim lifetime checks; add forged-token and replay tests.
2. **Close tenant authorization:** introduce dedicated factory/work-order/run capabilities and organization-scoped store methods; add cross-tenant negative tests.
3. **Make source and configuration reproducible:** resolve `.tinkerbot` tracking, commit/package the intended factory tree, align Stripe catalog and provider validator, and make production variable requirements fail early.
4. **Keep the Vitest coverage bar at 94%** statements/functions/lines in CI. Do not claim 98% overall.
5. **Build a real release artifact:** compile Action and CLI outputs, run `pnpm release:dry-run`, inspect the archive contents, and test the Action from a clean tag.
6. **Provision staging:** deploy Worker resources, apply migrations, configure WorkOS/Stripe/GitHub, attach Sandbox, and run provider validation.
7. **Run cross-surface acceptance:** WorkOS login → dashboard → factory creation → work order → Sandbox implementation → customer Action `tb check` → evidence ingest → human approval → release/outcome; repeat for fork, failure, unknown, replay, and past-due cases.
8. **Perform visual and operational QA:** Playwright dashboard checks, TTY TUI smoke/resize/error tests, accessibility review, queue/Workflow retry tests, R2 retention checks, observability alarms, and rollback drill.
9. **Sign and canary:** produce signed manifests and platform artifacts, publish a canary/private pilot, monitor, then promote the exact tested commit.

## 15. Recommended product and lifecycle evolution

The attached lifecycle proposal is an additive evolution of this repository, not a replacement architecture. The current factory already has the durable objects needed to support it: WorkOrders, production lines, risk/autonomy, receipts, evidence contracts, Change Sets, release manifests, Runtime Outcomes, Scorers, benchmark tables, Vectorize bindings, and Factory Steward proposals. What is missing is a consistent runtime/profile layer and a set of feedback loops that connect those objects across the entire lifecycle.

The target loop is:

```text
estimate -> intake -> triage -> specify -> approve -> implement
  -> checkpoint -> review -> verify -> merge/release
  -> observe -> compare -> learn -> propagate
```

The current implementation is strongest from local verification through release readiness. It is weakest at duplicate/conflict detection before intake, upfront planning/cost transparency, implementation checkpoints, post-merge observation, and turning evaluation/history into reusable factory knowledge.

### 15.1 Runtime foundation (implemented)

`schemaVersion: v1alpha2` adds `runtime` on the factory definition (collaboration, controlPlane, pipeline, runner, inference credentialRef, approval, sync). Older schemas parse with hosted defaults. There is no solo billing tier. Local execution uses `packages/local-runtime` (SQLite-shaped store, Docker runner, BYOK refs) via `tb run --local`, `tb factory plan`, and `tb eval`. `tb check` is unchanged. Hosted P0/P1 items (OIDC JWKS, tenant RBAC, Action `dist/`, Stripe) remain independent.

The YAML shape is:

```yaml
runtime:
  collaboration: solo           # solo | team
  controlPlane: local           # local | hosted
  pipeline: adaptive            # single_agent | adaptive | multi_agent
  approval: inline_self_review  # or human_async
  runner:
    type: docker                # process | docker | cloudflare_sandbox | github_actions
  inference:
    mode: byok                  # local | byok | managed
    provider: anthropic
    credentialRef: env:ANTHROPIC_API_KEY
  sync: offline                 # offline | manual | hosted
```

This belongs in a new runtime/execution document or schema section, not in `autonomy.yaml`. Autonomy answers what a run is allowed to do; the runtime profile answers where it runs, how many agents it uses, how it authenticates, and how it synchronizes.

The current substrate and required changes are:

- `packages/factory/src/warp.ts` already has bounded Foreman actions, heuristic stage skipping, conversations, scoring, and self-improvement hooks. Add a deterministic execution planner that consumes diff size, changed paths, impact, repository history, prior outcomes, and policy.
- `packages/factory/src/index.ts` already models stages, budgets, autonomy, WorkOrder transitions, and `executeFactoryRun`. Add a persisted `ExecutionPlan`, pipeline mode, approval mode, runtime origin, and cost estimate. Keep verification mandatory and keep restricted paths from being auto-skipped.
- `packages/factory/src/definition.ts` already parses runners and agent defaults, but runners are Linux/Cloudflare-oriented and self-hosted workers are rejected. Add process/Docker/local runner types and provider-neutral inference references.
- `apps/control-plane-worker/src/factory-runtime.ts` currently chooses Workers AI models and an optional Cloudflare Sandbox. Refactor it behind runner and inference adapters so the same run can execute locally, with BYOK, or in the hosted Worker.
- `packages/cli/src/index.ts` currently keeps `tb check` and factory validation local while hosted factory/work/run commands require an HTTPS session. Add a local orchestrator path (`tb run --local`, `tb eval`, and a local state store) without making WorkOS a prerequisite.
- `packages/control-plane/src/entitlements.ts` currently marks `selfHostedAvailable` false and reserves `private_execution` for Enterprise. Add separate `local_execution`, `byok_inference`, `portable_eval_suites`, and `offline_assurance` capabilities. Do not conflate free local execution with dedicated hosted private execution.

Billing can remain per active human seat. A one-person organization should use the same identity and role model as a team. BYOK provider spend should remain external to Tinkerbot invoices, while managed inference can continue to show estimated COGS and usage telemetry.

### 15.2 Intake

#### Existing substrate

The Worker and factory domain already normalize GitHub issues/PRs, Dependabot, code and secret scanning, GitLab issues/MRs, Slack, Linear, Jira, MCP, incidents, support, roadmap, scheduled work, and manual work orders. Webhook ledgers and GitHub publication dedupe provide replay protection. WorkOrder IDs and source IDs are recorded.

#### Missing capability

There is no general duplicate/overlap detector before a new WorkOrder is created. Source delivery dedupe is not the same as semantic conflict detection: two valid issues or PRs can target the same file, symbol, API, migration, or release surface. The Foreman decision has a summary but no requester-facing confidence and rationale contract. Sentry/error-tracker, CI-failure, and on-call-specific adapters are not present; `incident` is currently a normalized category, not a full external incident integration.

#### Recommended change

Add an intake admission stage that computes:

- a stable intent/scope fingerprint;
- affected repository/package/symbol/API surfaces;
- related open WorkOrders, PRs, incidents, and recent outcomes;
- duplicate, overlap, supersession, and conflict relationships;
- a confidence score with an explanation and explicit UNKNOWN state.

Persist the result as an `IntakeAssessment` linked to the WorkOrder. If a conflict is likely, do not silently merge requests; present the existing item and require the requester to link, supersede, or proceed with an explanation. Add adapters for Sentry, CI failure webhooks, and on-call/incident systems behind the same bounded intake contract, with provider-specific signatures, rate limits, and idempotency keys.

### 15.3 Triage

#### Existing substrate

Production lines, product/service metadata, path-sensitive risk, autonomy modes, policy packs, parser impact analysis, Change Sets, and repository-scoped assurance graphs already exist. `WorkOrder.risk` and `autonomyMode` are persisted.

#### Missing capability

The risk field is not a structured explanation of why the change is risky. Triage is not yet informed by a dependency graph spanning repositories outside the factory's configured repository list. Local history and hosted runs exist, but similar-work retrieval and outcome history are not part of the Foreman context. The Vectorize binding and memory table are storage foundations, not a complete retrieval/curation policy.

#### Recommended change

Introduce a risk vector rather than a single opaque class:

```text
blast radius, security sensitivity, data/migration impact, hot-path impact,
contract/API impact, dependency risk, operational risk, uncertainty, history
```

Store the reasons and evidence references for every classification. Build a bounded cross-repository context service from Change Sets, architecture bindings, package/API relationships, and explicitly connected repositories. Add similar-work retrieval using finding fingerprints, WorkOrder metadata, and Runtime Outcomes, with tenant/factory/repository scopes and retention boundaries. Triage should state both its confidence and what missing context could change the decision.

### 15.4 Specification

#### Existing substrate

Specification is a distinct stage with default human approval. Change Contracts already capture intent, expected surfaces, allowed/forbidden paths, required tests, evidence, reviewers, documentation, rollback, risk-sensitive areas, and release dependencies. The factory stores acceptance criteria and policy versions.

#### Missing capability

The current specification path produces one summary and waits for approval. It does not show precedent from similar repository changes, estimate cycle/cost before approval, or present multiple viable approaches for ambiguous work.

#### Recommended change

Make the specification artifact include:

- one to three explicit options for ambiguous requests;
- tradeoffs, risk vector, affected surfaces, and expected rollback;
- precedent references and a clear explanation when the proposal differs from prior patterns;
- projected stages, provider/model, duration, and cost range;
- selected option and the acceptance criteria that the later `tb check` must verify.

Add a `SpecOption`/`SpecAssessment` contract and expose it in the dashboard, TUI, and CLI before approval. Inline solo self-review may replace asynchronous approval for low-risk work, but the reviewed diff/spec digest must still be recorded.

### 15.5 Implementation

#### Existing substrate

Cloudflare Sandbox planning, `tinkerbot/*` branch restrictions, implementation PR creation, work-cell leases, sandbox logs in R2, agent receipts, dependency/impact analysis, and rollback references on release candidates are present. The `SandboxPort` abstraction is reusable for a local runner.

#### Missing capability

Implementation is currently treated as a single leased run that returns a branch/PR result. There are no durable intermediate snapshots/checkpoints, no general dependency/license gate, no second-opinion consultation protocol, and no generic evidence adapters for backend changes such as query plans, load-test deltas, or API response comparisons. The existing security stage is mainly an assurance checkpoint; it is not consistently an independent security-specialist pass.

#### Recommended change

Add implementation checkpoints after meaningful steps, each containing a workspace/tree digest, branch/ref, changed-file set, test state, and rollback reference. Checkpoints must be recoverable without mutating the default branch and must preserve the assurance chain.

Add a dependency change assessment that reads lockfile/package-manager diffs and reports license policy, known advisory inputs, new transitive scope, and provenance. A finding can be UNKNOWN when no authoritative license/advisory source is available; it must not be silently cleared.

Add an optional `consult`/pairing action for difficult implementation decisions. The second model can advise, but it cannot modify the branch, approve the change, or override deterministic evidence. Record both model opinions and the exact context digest.

Generalize evidence adapters beyond screenshots. Supported evidence types should include visual captures, query-plan before/after records, load-test deltas, API response/schema diffs, migration plans, and other provider-backed artifacts. Every adapter needs producer/version, source reference, digest, privacy classification, freshness, and an explicit authority tier.

### 15.6 Review

#### Existing substrate

Review is a factory stage; policy packs support security-sensitive and database changes; `AgentPolicy` can require security review; review calibration events and `evaluateMergeReadiness` already preserve human authority. The factory model has a security stage and a review agent.

#### Missing capability

Review effort is not dynamically tied to the structured risk vector. Reviewer output is not modeled as multiple independent opinions with disagreement. The current runtime can record review summaries, but it does not consistently dispatch a dedicated security specialist with separate evidence and authority.

#### Recommended change

Create a `ReviewPlan` from the triage risk vector:

- lightweight review for bounded documentation/test-only changes;
- standard review for ordinary code changes;
- security sub-review for auth, secrets, permissions, injection, dependencies, or sensitive data;
- migration/API/operational sub-reviews when the corresponding risk dimensions are present.

Store each review as a separate opinion with reviewer identity, model/provider, evidence references, confidence, and requested changes. If opinions disagree, preserve both and surface a `review_disagreement` state to the human. Do not collapse disagreement into an artificial consensus or alter the `tb check` verdict.

### 15.7 Human handoff, merge, and release

#### Existing substrate

The repository has merge-readiness evaluation, human approval records, release candidates, release manifests, rollback references, deployment records, GitHub Check Runs/comments, and Runtime Outcome types for reverts, hotfixes, deployment failures, regressions, and successful releases. Tinkerbot does not merge or deploy to customer clusters.

#### Missing capability

The human currently has to assemble the decision from several views. Release records are primarily dispatch/metadata records; there is no complete staged-rollout state machine, feature-flag/canary integration, or post-merge watch window that automatically correlates telemetry and CI outcomes back to the change.

#### Recommended change

Generate a signed/source-minimized `MergeReadinessDigest` containing:

- intent and selected specification option;
- change/risk summary and affected surfaces;
- deterministic verdict and coverage/test delta;
- unresolved UNKNOWNs and review disagreements;
- approval state and required roles;
- estimated/actual cost and duration;
- release dependencies, rollback references, and documentation/runbook status.

Add rollout states such as `merged`, `canary`, `progressive`, `fully_released`, `watching`, `regressed`, and `rolled_back`. Integrations remain advisory and explicitly attributed: feature flags, deployment workflows, CI, metrics, traces, error trackers, and incident systems provide signals but do not invent causal claims. A watch window may open a revert/rollback WorkOrder, but automatic revert and auto-merge should remain disabled by default and policy-gated.

### 15.8 Measurement and improvement

#### Existing substrate

Usage and AI cost tables, dashboard COGS metrics, Scorers, benchmark suites/results, conversation transcripts, Factory Analyst reports, self-improvement tasks, improvement proposals, benchmark deltas, and human activation checks already exist. Self-improvement cannot auto-merge and the Steward cannot self-approve.

#### Missing capability

The current evaluator is primarily a conversation scorer and aggregate benchmark store. It cannot run a user's representative task suite across model/provider/harness combinations, compare real diffs and deterministic outcomes, or create trend alerts. Cross-factory comparison and semantic behavior change from prompt/instruction edits are not persisted.

#### Recommended change

Add portable evaluation objects:

```text
EvalSuite -> EvalTask -> EvalAttempt -> diff/tests/tb check/rubric/cost/latency
```

Store the factory definition digest, model/provider/harness, runner, prompt/instruction hashes, output diff reference, deterministic evidence, human labels, and baseline comparison. Add cross-factory views only for authorized metadata and source-minimized evidence. Keep task suites exportable in `.tinkerbot/evals/` so a solo benchmark can become a team benchmark without migration.

Add trend rules for cost per WorkOrder, revision cycles, review disagreement, time-to-merge, failure/regression rate, UNKNOWN rate, and post-merge incidents. Alerts should link to the underlying evidence and produce a reviewable Factory Steward proposal rather than silently changing a factory.

For self-improvement PRs, show both the textual instruction diff and the expected behavioral delta: affected eval tasks, benchmark before/after, risk changes, and any verdict/standard impact. Activation still requires a distinct human approver.

### 15.9 Knowledge and context

The current repository has local history, R2 transcripts, a Vectorize binding, a `tinkerbot_memories` table, architecture bindings, and assurance graphs. These are useful foundations, but the factory does not yet maintain a governed, searchable knowledge base that is automatically consumed by every stage.

Add a scoped knowledge layer with:

- repository/factory/product/subsystem scope;
- provenance and authority tier;
- source digest and freshness/expiry;
- privacy and retention classification;
- human correction/deletion controls;
- retrieval reasons and evidence references;
- conflict handling when two historical records disagree.

Cross-work-item context should be retrieved by explicit relationship and scope, not by unbounded transcript dumping. Raw customer source remains local or explicitly authorized; hosted memory should prefer summaries, hashes, structured findings, and approved metadata.

### 15.10 Extensibility and control

Factory-as-code, skills, MCP, automations, evolution proposals, and the dashboard already provide an extension model. The missing controls are trust, simulation, explainability, and portable sharing.

Add:

- `tb factory plan` / dashboard dry-run to show stages, agents, runner, provider, approvals, estimated cost, and likely evidence before starting work;
- one-line reason and evidence references for every included/skipped stage;
- signed/versioned skill and agent bundles with compatibility, permissions, source, and review history;
- an import/export registry or marketplace with explicit trust levels, provenance, allowed tools, and human activation;
- simulation mode that never creates a WorkOrder, branch, PR, or external side effect;
- policy tests that prove a shared definition cannot grant merge, evidence rewrite, or verdict authority.

The existing Foreman `summary` field is a starting point for explainable routing, but it is not yet a stable requester-facing contract. Make routing explanations part of the execution plan and assurance bundle.

## 16. Lifecycle data, API, and documentation changes

The recommended lifecycle capabilities require additive schema and API work:

### New or extended domain objects

- `IntakeAssessment`: scope fingerprint, related items, duplicate/conflict state, confidence, rationale, and missing context;
- `RiskAssessment`: structured risk dimensions, scores, reasons, evidence references, and confidence;
- `ExecutionPlan`: selected stages, skipped-stage reasons, escalation rules, runtime profile, provider/model/runner, approval mode, and cost estimate;
- `SpecOption` and `SpecAssessment`: alternatives, precedent references, tradeoffs, acceptance criteria, and selected option;
- `ImplementationCheckpoint`: tree/ref digest, stage, workspace, tests, evidence, and rollback reference;
- `ReviewOpinion` and `ReviewDisagreement`: independent reviewer outputs and unresolved conflicts;
- `MergeReadinessDigest`: compact human handoff record;
- `RolloutRecord` and `WatchWindow`: canary/progressive/full-release state and external signals;
- `EvalSuite`, `EvalTask`, `EvalAttempt`, `EvalMetric`, and `EvalBaseline`;
- `KnowledgeRecord` and `KnowledgeLink`: scoped, attributable, expiring context;
- `TrendAlert`: metric, baseline, threshold, evidence refs, and proposed action.

### Worker and local storage

Extend D1 migrations and the local store with organization/factory/repository keys on every new record. Add indexes for source fingerprints, affected surfaces, status, created time, and tenant scope. Keep an append-only event stream for plan changes, approvals, checkpoints, review opinions, rollout signals, and learning proposals. Add a local SQLite adapter and an offline outbox/sync protocol rather than making D1 the only state store.

### CLI/TUI/dashboard

Add additive commands and views:

```text
tb factory plan
tb work conflicts
tb work explain <id>
tb spec options <id>
tb run estimate <id>
tb run checkpoints <id>
tb review opinions <id>
tb release digest <id>
tb release watch <id>
tb eval init|add|run|compare|baseline|export
tb knowledge search
tb trends
```

The TUI should show the planned pipeline, skipped-stage reasons, cost/time estimate, checkpoints, review disagreement, and merge digest. The dashboard should add intake conflicts, risk rationale, precedent, rollout/watch state, trend alerts, eval comparisons, and knowledge provenance without changing the exception-first navigation model.

### Documentation and ADRs

Add ADRs for:

- runtime profiles and local/offline control-plane authority;
- provider-neutral inference and BYOK credential boundaries;
- adaptive pipeline planning and inline self-review;
- portable task evaluations and cross-factory comparison;
- post-merge observation and external-signal authority;
- knowledge retention, provenance, and privacy.

Update `docs/architecture.md`, `docs/factories.md`, `docs/control-plane.md`, `docs/tui.md`, `docs/billing.md`, `docs/security.md`, `docs/privacy.md`, `docs/implementation-status.md`, `docs/roadmap.md`, the factory schema documentation, and the assurance/evidence schemas. Explicitly mark which capabilities are local-only, hosted, advisory, deterministic, imported, human-confirmed, or unavailable.

## 17. Recommended implementation sequence for these lifecycle insights

1. **Close current release/security blockers first:** OIDC signature verification, tenant isolation/capabilities, reproducible factory files, Action artifacts, Stripe validator drift, and the chosen coverage gate remain prerequisites for hosted production.
2. **Add explainable planning:** implement `IntakeAssessment`, `RiskAssessment`, `ExecutionPlan`, duplicate detection, dry-run, confidence/rationale, and upfront cost/complexity estimates. This immediately improves trust for both solo and team users.
3. **Add adaptive execution:** implement single-agent fallback, risk-scaled review, inline low-risk self-review, optional security sub-review, and a preserved multi-agent escalation path.
4. **Add implementation integrity:** introduce checkpoints, rollback references, dependency/license assessment, pairing consultations, and typed evidence adapters.
5. **Add human handoff and observation:** generate the merge digest, rollout/watch records, external-signal adapters, and Runtime Outcome correlation. Keep merge/deploy/revert authority explicit and human/policy controlled.
6. **Add the local/offline runtime:** reuse the factory contracts with a local store, Docker runner, BYOK/local inference, and an offline assurance bundle. This enables a one-person product path without WorkOS or Cloudflare.
7. **Add portable evaluations and trends:** normalize benchmark tables into task/attempt records, expose `tb eval`, compare historical successful runs, alert on cost/rework/regression trends, and feed only reviewable proposals into Factory Steward evolution.
8. **Add governed knowledge and sharing:** introduce scoped memory retrieval, signed skill/agent bundles, marketplace trust metadata, and human activation.
9. **Validate the complete loop:** intake conflict → explainable plan → implementation checkpoint → risk-scaled review → deterministic verification → merge digest → canary/watch → outcome → eval/trend → proposal. Test local/offline, hosted, fork, unknown, conflict, rollback, and provider-unavailable paths.

The first six changes can be delivered without waiting for production Stripe, WorkOS, or GitHub App provisioning if they are developed against local adapters. Hosted rollout/watch integrations and cross-factory aggregation remain external-provider and privacy-sensitive work.

## 18. Bottom line

The repository is no longer just a TUI/CLI prototype. It is a coherent factory-OS codebase with a local assurance engine, hosted orchestration, billing contracts, browser control tower, Action/App publication, and a documented governance model. The implementation breadth is real and the local test suite is healthy, but the release claim must remain narrower than the product vision until hosted identity authenticity, tenant isolation, reproducible factory/action packaging, provider configuration, coverage policy, signing, and live end-to-end validation are closed.

No external account, key, billing catalog, deployment, or production release was changed during this audit. The changes made here are documentation-only: this summary records the measured state and the remaining closure work.
