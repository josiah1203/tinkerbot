# ADR-0011: Hosted Production Closure and Differentiation Sequencing

## Status

Proposed

## Date

2026-08-21

## Owners

Factory core / platform team

## Refines

- [ADR-0009: Factory authority planes](./0009-factory-authority-planes.md)
- [ADR-0010: Durable Factory Spine Before Differentiation](./0010-durable-factory-spine.md)

## Decision summary

ADR-0010's application-level design and local implementation are treated as
the baseline. This ADR does not reopen the Factory Graph, Foreman, typed event,
projection, or verification-authority decisions. It closes the gap between
"the spine is implemented and locally verified" and "the spine is accepted as
production-authoritative" by making the remaining evidence gates explicit and
by sequencing differentiation work against the gates it actually depends on.

The active hosted coordination path is Queue → Foreman → `factory-runtime`.
The declared `FACTORY_RUN` Workflow binding is not a production capability
until it either implements the official Cloudflare Workflow entrypoint and
step contract with a real caller, or is removed from the deployment shape.

Differentiation may proceed incrementally as its specific prerequisites close.
It must continue to consume the existing command, projection, adapter,
route-contract, tenant-authorization, and runtime-capability boundaries.

## Context

ADR-0010 established the durable Factory Spine: single-writer lifecycle
authority through the Foreman command boundary, a disjoint typed event
vocabulary, digest-scoped verification, replayable projections, and
per-WorkOrder serialization. It deliberately gated differentiation until the
spine could be trusted.

The 2026-08-21 audit establishes meaningful local closure, but not hosted
production closure. The observed baseline is:

- Local `main` is `917a11b`; `origin/main` is `6357d73`. The canonical-tree
  cleanup is staged but not committed, so a fresh checkout does not yet
  reproduce the cleaned source tree.
- The local suite passes: 53 test files and 337 tests. The dedicated
  `tests/factory-adapter-conformance.test.ts` suite exists and currently
  exercises Memory, SQLite, and a D1 graph adapter fake, including rollback,
  projection checkpoints, and replay. That is strong local evidence, but it is
  not evidence that the deployed D1 resources behave identically.
- Typecheck, source-tree, Factory-tree, migration, schema-contract,
  release-dry-run, diff, and local release-gate checks pass in the current
  worktree. The release report remains `local_pass_external_pending`.
- The scheduled shadow-read mechanism exists and is read-only, but no accepted
  staging soak has been recorded.
- The supported hosted executor decision is self-hosted/GitHub Actions.
  Cloudflare Sandbox remains feature-gated and fails closed when unavailable.
  No complete hosted self-hosted lifecycle has been demonstrated in a real
  environment.
- `FACTORY_RUN` is declared in Wrangler, but the current
  `FactoryRunWorkflow` is a plain class, has no durable `step.do` boundary,
  and has no `FACTORY_RUN.create` caller. A successful local test run or
  `wrangler --dry-run` does not prove this platform entrypoint contract.
- `codex/release-source-recovery` has no unique commits relative to `main` and
  can be archived. `codex/software-factory-ux` has one unique commit and
  `codex/webui` has five unique commits; both require deliberate triage before
  the repository can be treated as a single release source.
- Public generic Slack, Linear, Jira, incident, support, and GitLab webhook
  paths currently use the deliberate single-tenant
  `INTEGRATION_ORGANIZATION_ID` binding. That is acceptable as a guarded
  bootstrap shape, but it is not a multi-tenant production integration
  contract. GitHub installation callbacks already resolve tenant ownership
  from authenticated sessions and installation records; the remaining
  provider paths need equivalent per-tenant binding before broad rollout.

These facts separate three claims that must not be conflated:

1. The lifecycle authority design is coherent.
2. The local implementation and conformance fixtures are green.
3. The deployed system has proven production authority under real resources,
   retries, provider identities, and release provenance.

This ADR governs the transition from claim 2 to claim 3. It also prevents
evidence-only release work from blocking every product capability indefinitely.

## Decision

### 1. Production-authority closure is an evidence program

The spine is production-authoritative only when the following evidence exists
for a reviewed release commit and a named staging/production environment:

- the source tree is reproducible from a clean checkout;
- Memory, SQLite, and deployed D1 produce equivalent graph-derived projections
  for the declared conformance fixtures;
- the graph-to-compatibility shadow read remains within the declared tolerance
  for the full soak window;
- one complete hosted lifecycle succeeds on the resolved executor path;
- retries, restarts, duplicate commands, projection failure, and late/out-of-
  order callbacks preserve authority and idempotency;
- provider, secret, CI, and signing resources are real and verified; and
- the release commit and branch/worktree provenance are unambiguous.

Passing a local test, schema check, dry-run, or configuration parser is
necessary evidence but cannot substitute for the hosted evidence above.

### 2. Remaining closure gates

The gates below are the complete production-closure program. They are evidence
or provisioning gates, not invitations to redesign the spine.

#### Gate A — Resolve the Workflow binding

Before the hosted lifecycle proof, choose exactly one path:

- **Implement:** make `FactoryRunWorkflow` a real
  `WorkflowEntrypoint<Env, Params>` subclass, receive `WorkflowEvent` and
  `WorkflowStep`, execute the existing Queue/Foreman command path inside a
  named durable `step.do`, add a Worker-runtime smoke test, and add a real
  `FACTORY_RUN.create` caller. The implementation must use the same Foreman
  authority and must not create a second lifecycle writer. See the current
  [Cloudflare Workflow API](https://developers.cloudflare.com/workflows/build/workers-api/).
- **Remove:** remove the `FACTORY_RUN` binding and compatibility class, and
  document Queue → Foreman as the sole hosted delivery path until a separate
  Workflow use case is approved.

The current release disposition is **Queue → Foreman remains active;
`FACTORY_RUN` is not counted as a production dependency**. The decision must
be recorded before the lifecycle proof so the proof exercises the path that
will actually ship.

#### Gate B — Commit and reproduce the canonical source tree

- Review the staged duplicate cleanup and quarantine inventory.
- Commit it to `main` through the normal review path.
- From a fresh checkout of that commit, run `pnpm verify:tree`,
  `pnpm typecheck`, `pnpm test`, and `pnpm release:dry-run`.
- Record the commit, source-tree counts, package manifest, and diff check.

The staged index is not release provenance. A clean working tree and a
reproducible checkout are required.

#### Gate C — Prove persistence conformance against deployed D1

The local adapter suite is already present and green; this gate extends it to
the real hosted persistence boundary. Run the same ordered fixture against
Memory, SQLite, and the provisioned D1 database and compare:

- verification, review, approval, release, rollback, and outcome projections;
- aggregate sequence, command receipt, idempotency, and event ordering;
- projection checkpoint fingerprints and retry states; and
- replay after a clean process/Worker restart.

The schema-contract verifier proves columns, indexes, and migration ordering.
It does not prove this behavioral conformance and must not be used as a
substitute for it.

#### Gate D — Provision real staging resources

Provision and record the resource identifiers and migration results for:

- Cloudflare Worker, D1, R2, Queues, Durable Object namespaces, and any
  selected Workflow binding;
- WorkOS client, organization/membership data, webhook signing secret, and
  event-sync cursor;
- Stripe test-mode catalog, webhook secret, and billing account records;
- GitHub App/OIDC and GitLab signing resources if those adapters are enabled;
- self-hosted dispatch signing secret and callback endpoint; and
- CI identity and artifact-signing keys.

Placeholder identifiers and local `.dev.vars` values are not evidence. Apply
the ordered migrations and retain the migration output with the environment
record.

#### Gate E — Run the staging shadow-read soak

Point the existing scheduled shadow-read sweep at a provisioned staging
organization and run it for at least seven consecutive days, or the formally
approved equivalent tolerance window. The sweep must remain read-only and
record:

- events checked and skipped;
- compatibility/projection divergences;
- historical backfill explanations;
- checkpoint status and retry count; and
- the final zero-unexplained-divergence decision.

No automatic repair may hide a divergence. A divergence either receives a
durable explanation and disposition or keeps this gate open.

#### Gate F — Prove one complete hosted lifecycle

Demonstrate the selected hosted path end to end:

```text
admission
  → WorkOrder command/receipt
  → Foreman serialization
  → executor dispatch
  → signed self-hosted completion
  → deterministic tb check / OIDC evidence ingest
  → projection reconciliation
  → provider publication
  → human merge/release decision
  → release or rollback outcome
```

Every step must be traceable by WorkOrder ID, run ID, command ID,
correlation ID, event sequence, receipt, and evidence reference. The test must
use real staging providers and must show that the final verification verdict
comes from `tb check`, not from the executor, Workflow, AI, or dashboard.

#### Gate G — Exercise failure and concurrency modes

Against staging, record passing results for:

- Queue redelivery and duplicate delivery;
- Foreman/Durable Object restart or replacement;
- projection write failure followed by retry/rebuild;
- duplicate command and conflicting idempotency-key behavior;
- out-of-order or late self-hosted completion;
- release approval with a wrong digest, release ID, or target outcome;
- tenant mismatch on completion, evidence, and provider callback; and
- unavailable executor / Sandbox fail-closed behavior.

The expected result is no duplicate authority, no silent state repair, and a
graph-visible block or retry state where appropriate.

#### Gate H — Establish release provenance and branch closure

- Run the live CI matrix and record the green commit.
- Produce signed release artifacts and verify the signature/provenance from a
  clean checkout.
- Archive `codex/release-source-recovery` after preserving its inventory.
- Triage `codex/software-factory-ux` and `codex/webui`; retain useful changes
  only through reviewed commits, then archive or explicitly retain the refs.
- Make `main` the documented release source for the Factory Spine and these
  ADRs.

#### Gate I — Close release-quality maintainability gaps

This is not a new lifecycle authority decision, but it remains a release
quality gate:

- generate binding declarations with the Worker `types` script after config
  changes and replace hand-written platform event shapes;
- replace remaining internal payload casts with runtime-narrowed command
  schemas;
- keep the Worker and D1 façade decomposed by adapter boundary; and
- retain the local release report's explicit `local_pass_external_pending`
  state until all external gates are evidenced.

### 3. Differentiate incrementally as prerequisites close

Differentiation is not an all-or-nothing unlock. The authoritative dependency
table is:

| Differentiation area | Required closure gates | Additional rule |
| --- | --- | --- |
| Planning and capacity modeling | B, C | Reads and writes lifecycle-adjacent state only through Foreman commands and projections. |
| Outcome economics | C, F | Outcome events must attach to a proven release/run reference; economics never changes release authority. |
| Scorers and self-improvement | F, G | Scorers consume real execution/evidence data; proposals remain advisory until separately approved. |
| Per-tenant integration hardening | D, H | Must close provider identity, tenant binding, replay, and cross-tenant negative tests before broad enablement. |
| Dashboard/CLI/TUI/MCP expansion | Route-contract coverage and adapter boundary review | New surfaces may proceed when they consume graph-derived views and do not add a lifecycle writer. |
| Additional hosted executors or Sandbox | A–H plus a dedicated ADR/amendment | Each executor needs its own capability, isolation, artifact, cancellation, and failure proof. |

This lets low-risk contract, projection, and UI work proceed without waiting
for the slowest operational gate, while preventing a new execution or
lifecycle authority from entering through an informal side path.

### 4. Define per-tenant integration hardening

The current generic webhook bootstrap is deliberately single-tenant. Before
multi-tenant production exposure, harden every provider path with:

- a per-tenant integration connection record containing provider installation
  identity, organization ownership, status, and credential/key references;
- provider installation identity verified on every callback rather than inferred
  from a shared organization variable;
- replay ledgers and idempotency keys scoped to provider plus tenant;
- capability and authorization tests for each Worker and MCP mutation route;
- explicit repository/installation ownership checks for source-control events;
- signed callback and completion payloads that cannot name another tenant; and
- cross-tenant negative tests proving tenant A cannot read, mutate, dispatch,
  or publish against tenant B's WorkOrders.

Real WorkOS/Stripe/Cloudflare provisioning is required to test this boundary
against real identities, but tests must also use deterministic local fakes for
negative-path coverage.

### 5. Guard every differentiation change with the spine contracts

Any feature merged under this ADR must:

- enter lifecycle-adjacent state through the Foreman command boundary and the
  typed event vocabulary;
- use `route-contract.ts` or its successor for public WorkOrder/read-model
  response shapes;
- add persistence only through an existing or explicitly reviewed adapter
  boundary (graph, projection, artifact, operations, tenant, or telemetry);
- register a new executor/provider in `runtimeCapabilityDecision` so unsupported
  combinations fail closed with a typed reason;
- preserve tenant authorization, idempotency, provenance, and bounded request
  handling; and
- include a conformance, replay, or negative test proportional to the new
  authority risk.

If a capability cannot satisfy these constraints, the correct response is an
ADR amendment or a new ADR—not a second lifecycle writer.

## Sequencing

```text
0. Resolve the Workflow binding decision (Gate A)
1. Commit and reproduce the canonical tree (Gate B)
2. Run local + deployed persistence conformance (Gate C)
3. Provision staging and provider resources (Gate D)
4. Start and complete the shadow-read soak (Gate E)
5. Prove the complete hosted lifecycle (Gate F)
6. Exercise retries, restarts, and tenant/failure boundaries (Gate G)
7. Close CI/signing/branch provenance (Gate H)
8. Close Worker type and maintainability evidence (Gate I)
9. Unblock each differentiation area according to the dependency table
```

Gates B and H can proceed in parallel with provisioning. Gate C requires the
reviewed source contract and provisioned D1 for its hosted half. Gate E
depends on D and the deployed shadow-read configuration. Gate F depends on A,
D, and the successful conformance baseline. Gate G follows the deployed
lifecycle path and may run in parallel with the latter part of E. Gate I is
continuous and should be checked in every differentiation review.

## Acceptance criteria

- [ ] The Workflow binding has been implemented and exercised as a real
      `WorkflowEntrypoint`/`WorkflowStep` path with a caller, or removed with
      Queue → Foreman documented as the sole hosted path.
- [ ] The canonical-tree cleanup is committed and a fresh checkout of `main`
      has zero duplicate semantic paths and reproduces the release checks.
- [ ] The local Memory/SQLite/D1 conformance fixture remains green and the same
      behavioral fixture passes against provisioned D1 with matching projection
      fingerprints, receipts, ordering, and replay results.
- [ ] Real staging resources and provider identities are provisioned, ordered
      migrations are applied, and the environment record contains their
      non-placeholder identifiers and validation evidence.
- [ ] The staging shadow-read soak meets the declared minimum window with zero
      unexplained divergence and an archived report.
- [ ] One complete hosted self-hosted lifecycle is demonstrated from admission
      through publication and release/rollback, with graph-visible evidence at
      every stage.
- [ ] Queue redelivery, Foreman restart, projection retry, duplicate commands,
      conflicting idempotency, out-of-order completion, tenant mismatch, and
      unavailable executor behavior are recorded as passing staging tests.
- [ ] CI, artifact signing, release provenance, and the clean-checkout package
      manifest are verified from the release commit.
- [ ] `codex/release-source-recovery` is archived and the
      `codex/software-factory-ux` and `codex/webui` refs are triaged through
      reviewed changes or explicit discard records.
- [ ] Worker binding types, internal command schemas, and remaining module
      boundaries meet the release-quality checks in Gate I.
- [ ] ADR-0010 is updated to `Accepted` only after its production acceptance
      evidence is linked from this ADR and the release-readiness record.
- [ ] Every differentiation feature merged under this ADR passes review for
      Foreman command usage, route-contract usage, adapter persistence,
      capability registration, tenant scope, and appropriate negative tests.

## Explicitly deferred

- Cloudflare Sandbox implementation and additional hosted executor expansion;
  each requires a dedicated isolation, artifact, cancellation, recovery, and
  stage-proof decision.
- Broad multi-tenant Slack, Linear, Jira, GitHub, and GitLab webhook exposure
  until per-tenant provider identity and negative tests close.
- Outcome economics dashboards beyond the projection and contract surfaces
  required by the dependency table.
- Scorer activation, Factory Steward activation, and self-improvement loops
  that depend on real hosted execution/failure data.
- New dashboard, CLI, TUI, or MCP surface area that does not consume the
  existing graph-derived route contracts.

## Consequences

### Positive

- Production readiness becomes an auditable evidence program rather than an
  ambiguous claim based on local tests.
- The Workflow binding receives the same explicit capability treatment already
  applied to Sandbox.
- Differentiation can resume in dependency-sized increments without weakening
  the lifecycle authority boundary.
- Provider and tenant hardening becomes a concrete multi-tenant contract with
  negative tests, not a general future-security statement.

### Costs and risks

- Staging, provider, CI, and signing work requires operator access and cannot
  be completed from source changes alone.
- A seven-day shadow soak and a real hosted lifecycle add elapsed time before
  full release authority can be claimed.
- Incremental unblocking requires disciplined review; teams must not interpret
  one closed gate as permission to bypass the others.
- Keeping the Workflow binding unresolved is a release risk, so the decision
  must be made before hosted lifecycle evidence is accepted.

## Evidence references

- [Architecture map](../architecture-map.md)
- [Release readiness](../release-readiness.md)
- [Branch/source inventory](../repo-hygiene/branch-source-inventory.md)
- [Factory adapter conformance tests](../../tests/factory-adapter-conformance.test.ts)
- [Factory spine tests](../../tests/factory-spine.test.ts)
- [Release-gate verifier](../../scripts/verify-release-gates.mjs)
