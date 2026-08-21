# ADR-0010: Durable Factory Spine Before Differentiation

## Status

Proposed (Revision 26 — operational telemetry, executor, WorkOS, billing, GitHub, self-hosted completion, tenant routes, hosted assurance, artifact persistence, Factory operations metadata, workspace metadata, graph-derived read models, provider protocols, D1 projection, hosted D1 storage, evidence, and capability boundaries)

The application-level spine cutover is implemented and locally verified. This
ADR remains Proposed because the declared Cloudflare Workflow binding still
needs a valid durable entrypoint decision, and production shadow-read, hosted
lifecycle, source tree commit/fresh-checkout, provisioning, signing, and
executor proof gates still require durable release evidence. The local
application-level gates are complete and the unsupported hosted Sandbox path
fails closed.

## Date

2026-08-21

## Owners

Factory core / platform team

## Refines

[ADR-0009: Factory authority planes](./0009-factory-authority-planes.md)

## Companion artifact

[Factory lifecycle transition table](./0010-factory-lifecycle-transition-table.md)

## Relationship to ADR-0009

ADR-0009's four-plane ownership remains in force. In particular, `tb check` is
the sole producer of a deterministic verification verdict; workers and
Intelligence are advisory; and external systems are adapters. This ADR is
authoritative for the durable event vocabulary, Foreman command boundary,
transition rules, and ledger projections.

ADR-0010 does not move verification authority from the Assurance plane to the
Foreman. The Foreman validates scope, authorization, ordering, and idempotency
for a `verification.recorded` command, but it does not compute, override, or
reinterpret the verdict. Existing `reviewDecision`, `reviewAssessment`, and
`releaseDecision` fields are compatibility projections while consumers migrate;
they are not a second source of lifecycle truth.

## Context

Tinkerbot's differentiated value is built on a shared lifecycle: intent,
planning, execution, deterministic verification, review, release, and outcome.
The Control Plane, CLI, TUI, MCP server, integrations, and local runtime must
all answer the same question about a WorkOrder. They cannot do that reliably
while each surface can maintain or mutate its own interpretation of lifecycle
state.

The repository already contains most of the ingredients for a Factory Graph:
typed graph events, local SQLite persistence, hosted D1 persistence, legacy
WorkOrder/run/stage tables, and graph-backed views. They are not yet a fully
proven durable spine. Earlier implementations exposed several authority
failures:

- `verification_verdict`, `review_assessment`, and `release_decision` were
  mutable WorkOrder columns updated alongside graph events.
- Legacy decision paths could update a compatibility field and append a graph
  event without one transactional command result.
- Legacy `release.completed` and review/approval mappings blurred evidence,
  assessment, approval, and release authority.
- The in-memory ledger and the D1/SQLite stores did not yet share a complete
  restart, ordering, idempotency, and replay contract.
- Duplicate or stray files under `.tinkerbot/` could make loader behavior
  depend on filesystem state rather than on a reproducible definition tree.

The current implementation closes the application-level creation seam:
canonical review, verification, approval, release, and WorkOrder admission
commands use typed constructors and the command boundary; local and hosted
stores persist admission metadata with the create event, receipt, outbox, and
projection unit; and the compatibility projector only treats a legacy release
event with an explicit `RELEASE` outcome as released. The remaining work is to
commit the staged canonical source-tree cleanup, prove the hosted adapters
against real staging resources, and record production shadow-read evidence.

These are authority failures, not merely implementation complexity. An agent,
integration, migration, or surface may provide evidence or request an action,
but it must not become an alternate lifecycle writer. Building Sandbox,
multi-tenant integrations, outcome economics, or self-improvement on top of
two possible answers to “is this released?” would make every later capability
harder to trust and migrate.

The system therefore needs a durable base with four properties:

1. **One command authority** decides and serializes binding lifecycle
   transitions.
2. **One append-only ledger** is the durable source of lifecycle truth.
3. **Replayable projections** serve every product surface and can be rebuilt
   after restart, migration, or storage failure.
4. **Explicit contracts and invariants** make advisory evidence, human
   approval, and binding release decisions impossible to confuse.

The durable base is a boundary, not a new product surface and not a second
database. Differentiated capabilities consume it; they do not redefine it.

## Decision

### 1. Establish the Factory Spine as the product base

The durable Factory Spine is the minimum supported lifecycle substrate:

- stable identifiers and aggregate relationships for Organization, Factory,
  Intent, WorkOrder, Task, WorkerSession, ChangeSet, VerificationRun,
  EvidenceReceipt, ReviewAssessment, ApprovalDecision, Release, and Outcome,
  plus audit records derived from the same event stream;
- a versioned, append-only Factory Graph event envelope containing aggregate,
  tenant, actor, timestamp, correlation/causation, schema/policy version,
  provenance, and external references;
- a durable command boundary that validates authority, tenant scope, policy,
  transition legality, and idempotency before appending binding events;
- D1 and SQLite persistence adapters that store the same event contract;
- deterministic projections for lifecycle, assurance, audit, queue, outcome,
  economics, and client views; and
- replay, migration, restart, and integrity checks treated as part of the
  base's definition of done.

The Factory Spine must remain provider-neutral. GitHub, Slack, Jira, Linear,
MCP, customer harnesses, Workers AI, and local tools are adapters or clients;
none owns a parallel lifecycle model.

The authoritative flow is:

```text
typed command / evidence / request
              |
              v
     Foreman durable authority
     (serialized, authorized, idempotent)
              |
              v
    append-only Factory Graph ledger
              |
              v
      replayable projections
        (D1 | SQLite)
              |
              v
  CLI | TUI | dashboard | MCP | integrations
```

### 2. Make the Foreman the sole binding transition authority

The Foreman is the only component allowed to accept a command that changes
binding WorkOrder lifecycle state or to append a binding transition event. In
the hosted runtime this boundary is the `FOREMAN` Durable Object. In the local
runtime it is a serialized, durable equivalent backed by SQLite and the same
command/event contracts.

Serialization is **per WorkOrder aggregate**, keyed by `workOrderId`, rather
than per Factory or tenant. Hosted Durable Object addressing and local-runtime
coordination must use that key so unrelated WorkOrders can progress
concurrently while transitions for one WorkOrder remain ordered.

The Foreman must:

- validate organization and factory scope, actor authority, policy version,
  current projected state, and legal transitions;
- require an idempotency key for externally retried commands and a canonical
  payload fingerprint for that key. The same key with the same fingerprint
  returns the original result; the same key with a different fingerprint
  hard-fails with an idempotency conflict and appends no event;
- assign or validate per-aggregate ordering and causation; and
- append the event before reporting a binding transition as successful.

Dashboard, MCP, CLI, TUI, worker completion, integration callbacks, and legacy
migration code may submit typed commands or evidence to the Foreman. They may
not issue direct SQL updates to lifecycle fields, call a private binding append
path, or interpret a local write as authoritative.

Hosted adapters use the same WorkOrder coordinator for each binding path:
queue/workflow execution enters `/foreman/run`; graph commands enter
`/foreman/command`; compatibility transitions enter `/foreman/transition`;
spec approvals enter `/foreman/approval`; and deterministic verification
enters `/foreman/verification`. The local fallback uses the same command and
projection contracts when no Durable Object binding is present.

Self-hosted workers use the existing signed, credential-free dispatch and
completion protocol. The completion endpoint verifies the signature, tenant
and WorkOrder scope, worker identity, run identity, definition digest, and
idempotency before translating the completion into a Foreman command. A
self-hosted worker never appends a Factory Graph event directly, even when its
completion is valid.

Deterministic verification remains the only source allowed to record a
verification verdict. Workers and AI remain advisory and cannot verify,
approve, or release their own work. Human approval and release authority remain
separate from verification.

### 3. Use structurally disjoint event vocabularies

The canonical event model must distinguish evidence, assessment, approval,
request, and binding outcome. Event constructors use discriminated payload
types so an invalid state is unrepresentable at the call site.

The canonical lifecycle vocabulary is:

| Concern | Canonical event family | Binding meaning |
| --- | --- | --- |
| ChangeSet scope | `change.proposed` / `change.updated` | Requires `workOrderId`, `changeSetId`, and an immutable `changeSetDigest`; a new digest invalidates prior digest-bound verification, review, and release eligibility, while a same-digest replay does not reset the projection. It is a binding lifecycle command even when the payload is advisory worker evidence. |
| Verification evidence and verdict | `verification.recorded` | Records `PASS`, `FAIL`, or `UNKNOWN` for a specific ChangeSet digest; only deterministic verification may emit a binding verdict. |
| Review assessment | `review.recorded` | Records `NO_FINDINGS`, `FINDINGS`, or `ESCALATE`; never releases work and never uses `APPROVE` as a wire value. |
| Approval request | `approval.requested` | Requests a scoped human/designated checkpoint; does not grant authority. |
| Human or designated approval | `approval.recorded` | Records `scope: SPEC | RELEASE | ROLLBACK` and `outcome: GRANTED | DENIED`; a `RELEASE`-scope approval is additionally bound to `targetOutcome: RELEASE | HOLD` and the current ChangeSet digest, while a `ROLLBACK`-scope approval is bound to the active Release ID. It never substitutes for deterministic verification or a release decision. |
| Release request | `release.requested` | Records intent to release; does not change released state. |
| Release outcome | `release.decided` | Requires exactly one `RELEASE`, `HOLD`, or `ROLLBACK` outcome plus a typed reference to the specific matching `approval.recorded` event; it is the only event that changes release decision state. |
| Release execution | `release.executed` | Records execution after `release.decided { outcome: RELEASE }`; it does not independently authorize release. |
| Explicit rollback | `release.rolled_back` | Records rollback execution after a `release.decided { outcome: ROLLBACK }`; it does not independently authorize or change the release decision. |

Legacy `*.completed` events may be read during migration but cannot be emitted
by new code. A compatibility reader must not infer a release outcome from an
event name. In particular, `HOLD` must remain `HOLD` through append, replay,
projection, API response, and client rendering. Normalized control-plane views
may spell that canonical value as lowercase `hold`, but must not collapse it
into `RELEASE` or an unqualified release-authorization state.

Compatibility WorkOrder route transitions are binding graph events as well.
Where a transition already has a domain event (`task.queued`, `spec.created`,
`task.started`, `review.requested`, `verification.started`, `approval.requested`,
`release.requested`, `integration_candidate.assembled`, `task.blocked`,
`task.reworked`, or `release.executed`), that event carries the ordered
`fromState`, `toState`, `causeId`, and derived `currentStage`. States without a
domain-specific event, including `cancelled` and `unknown`, use the canonical
`work_order.transitioned` event with the same typed route payload. Every one of
these route event families is command-bound; a direct append cannot advance a
compatibility status column.

The canonical projection preserves these independent truths:

```text
verificationVerdict = PASS | FAIL | UNKNOWN  # for the current ChangeSet digest
reviewOutcome       = NO_FINDINGS | FINDINGS | ESCALATE  # event payload
reviewAssessment    = NOT_REVIEWED | CLEAR | NEEDS_HUMAN_REVIEW | REVISE
releaseDecision     = NOT_RELEASED | RELEASE | HOLD | ROLLBACK
outcomeStatus       = UNMEASURED | PENDING | POSITIVE | NEUTRAL | NEGATIVE | UNKNOWN
```

The canonical review event maps `NO_FINDINGS -> CLEAR`, `FINDINGS -> REVISE`,
and `ESCALATE -> NEEDS_HUMAN_REVIEW` for the `reviewAssessment` projection.
`reviewDecision` values such as `APPROVE` and `REQUEST_CHANGES` are legacy
compatibility values only and must not be used in new event payloads.

The event and payload types must use distinct tagged IDs for review and
approval. A `release.decided` payload contains a `ReleaseApprovalRef` whose
`kind` and `scope` can only reference an `approval.recorded` event for the
same WorkOrder and requested release scope. For `RELEASE` and `HOLD`, the
approval and reference must target the current ChangeSet digest and the same
requested outcome. For `ROLLBACK`, they must target the active Release ID and
its release digest. A `ReviewEventId` cannot satisfy that typed constructor.
All untrusted JSON, persisted legacy rows, and remote commands require the
corresponding runtime validation at the Foreman boundary as well.

No advisory payload may contain a field that the projector interprets as a
release outcome. No release decision may be constructed without an explicit
outcome, an authorized actor, and the matching typed approval reference.
Rollback execution is evidence of what happened after that decision, not a
second decision authority. The legal state transitions and their preconditions
are enumerated in the [companion transition table](./0010-factory-lifecycle-transition-table.md),
not left to convention.

### 4. Treat the ledger as the source of truth and stores as projections

The event ledger is the only durable source of lifecycle facts. WorkOrder
status columns and equivalent D1/SQLite read-model fields are compatibility
projections. They may be updated by the projection transaction or rebuilt from
the ledger, but no application path may treat them as an independent write
authority.

The projection contract is:

- the same ordered event fixture produces the same projection in D1 and
  SQLite;
- a projection can be discarded and rebuilt without losing lifecycle truth;
- a projection checkpoint records the last applied event/sequence; and
- a failed projection does not acknowledge the command as complete until the
  event is durably available for replay.

`ChangeSet` content digests are immutable verification scopes. Every
`verification.recorded` event carries the `changeSetId`, digest, and
`verificationRunId` it evaluates. When a new ChangeSet digest is recorded for a
WorkOrder, the current projected verdict resets to `UNKNOWN`, prior review and
release approvals for the old digest become ineligible, and old verification
results remain historical evidence only. For the current digest, the latest
accepted deterministic run in aggregate order is the projected verdict.

Late verification callbacks for an old digest may be retained as historical
evidence but cannot change the current WorkOrder projection. A callback for the
current digest after `release.decided` is accepted only when it is an identical
idempotent replay; a conflicting or new result is rejected as a closed-lifecycle
conflict and cannot reopen or rewrite the release decision.

`AuditEvent` is a projection of this same event stream, not a parallel ledger.
Nothing appends an AuditEvent independently of a command-boundary or lifecycle
event.

The ledger and projection implementation must enforce unique event IDs,
idempotent command keys, tenant isolation, monotonic aggregate ordering, and
raw-credential rejection. The Foreman is the authority boundary; D1 and SQLite
are durable storage targets, not competing authorities.

Compatibility mappings are explicit: the canonical `reviewAssessment` maps to
the legacy WorkOrder review field, and canonical `NOT_RELEASED`, `HOLD`, and
`ROLLBACK` values must not be presented as a legacy release success. The
compatibility mapping for the legacy `READY` value must be documented as a
read-model interpretation of release eligibility, not as a separate release
decision. A new digest always invalidates prior review and release eligibility,
including compatibility fields.

For a multi-event command, event append, command receipt, and the durable
outbox entry are one persistence unit where the adapter supports a transaction
or atomic batch. If a projection update fails after the ledger unit commits,
the command remains durably replayable and is not reported as fully projected;
the projection checkpoint and retry state must make that condition observable.

The current adapter contract makes this concrete: SQLite uses one `BEGIN` /
`COMMIT` unit for the receipt, graph events, and sync outbox rows; D1 uses one
transactional batch containing the receipt, graph events, and outbox rows. Both
adapters persist `tinkerbot_factory_projection_checkpoints` keyed by tenant and
aggregate. A checkpoint records the last event ID/aggregate sequence, a
fingerprinted projection snapshot, `APPLIED` or `RETRY_PENDING` status, retry
attempt count, and the last projection error. `rebuildFactoryProjection` and
`retryFactoryProjection` replay the authoritative graph and repair the
compatibility projection without client-side event repair. A failed projection
still rejects the command response after the ledger unit commits, so callers
cannot mistake durable availability for successful projection.

### 5. Make the definition tree reproducible

`.tinkerbot/` is a versioned source tree, not an ambient search path. The
factory loader must resolve one canonical semantic path for every agent, line,
skill, runner, automation, and factory definition.

CI must fail when:

- duplicate semantic paths exist, including space-suffixed variants;
- a file reachable by the loader is untracked or outside the declared tree;
- two definitions resolve to different content for the same semantic identity;
  or
- a loaded definition changes without a corresponding digest/version change.

This guard is part of the durable spine because replay and policy decisions are
not reproducible if the input definition tree is not reproducible.

### 6. Make repository and production closure evidence durable

Repository hygiene is a precondition for reproducible replay, but it is not a
license for destructive cleanup. Any file moved out of the tree during a
consolidation attempt must first be inventoried, diffed against its canonical
counterpart, and resolved as discarded, merged, or explicitly flagged for a
human decision. The current `.tinkerbot/` duplicate snapshot and content
hashes are recorded in the [factory-tree duplicate inventory](../repo-hygiene/factory-tree-duplicate-inventory.md).
The inventory and hashes must be stored in a durable, reviewable artifact; a
temporary directory must never be the only remaining copy of unique content.

`main` is the sole release source for the Factory Spine and these ADRs. Other
branches and worktrees may contain experiments, but they cannot be parallel
sources of truth. Useful changes are brought back through a reviewed change to
`main`; unreviewed changes to another ADR require a formal amendment or an
explicit discard decision.

The supported execution path is the signed self-hosted worker protocol. It is
the only executor this ADR treats as supported for hosted implementation
handoffs: the control plane emits a credential-free signed dispatch, the
customer worker executes inside its own hardened boundary, and the worker
returns through the signed completion and deterministic-verification path.
This decision is final for the current release line: Cloudflare Sandbox remains
feature-gated and explicitly unsupported. Enabling it requires a separate
ADR/amendment for its binding, isolation, artifact, cancellation, failure, and
stage-proof contract; it is not an alternate way to satisfy this ADR.
The supported self-hosted path must still complete one real hosted lifecycle
before it is described as production-ready:

```text
request → WorkOrder → approval → execution → tb check
  → evidence receipt → projection → publication
  → human merge decision → release or rollback
```

### 7. Gate differentiation on spine completion

Existing differentiated code may remain in the repository, but new scope that
depends on lifecycle truth is gated until the spine acceptance criteria are
green. The gate covers production provider proof, per-tenant integration
hardening, outcome/economics operations, scorers, and self-improvement. Sandbox
implementation is separately deferred because the selected production executor
contract is self-hosted.

This is a sequencing decision, not a reduction in product ambition. The
deterministic, replayable, vendor-independent, local/self-hosted, planning,
capacity, outcome, and economics capabilities remain part of the target
system. They resume on the same spine after the gate is met.

## Sequencing

0. **Resolve moved files and branch ambiguity.** Preserve unique content in a
   durable review artifact, triage divergent worktrees, and establish one
   release candidate on `main`.
1. **Freeze the spine contract.** Inventory lifecycle writes, event types,
   projections, migration paths, surface readers, and the companion transition
   table. Mark each path as command, event, projection, adapter, or deprecated
   compatibility code.
2. **Make the source tree reproducible.** Remove or quarantine duplicate
   semantic paths and add the loader/CI guard before using the tree as a replay
   fixture.
3. **Publish the transition table and typed event constructors.** Keep
   `reviewOutcome`, `reviewAssessment`, approval scope/target, and release
   outcomes disjoint. Stop emitting ambiguous legacy completion events.
4. **Close the command boundary.** Route every binding transition through the
   Foreman durable authority, including worker completion, integration
   callbacks, and legacy migration. Add idempotency, conflict handling, and
   ordering behavior.
5. **Cut over projections.** Rebuild D1 and SQLite lifecycle read models from
   canonical events. Backfill history with explicit migration events and retain
   compatibility fields only as derived views.
6. **Run adapter conformance.** Execute the same fixtures against Memory,
   SQLite, and D1 and compare verification, review, approval, release,
   rollback, outcome, and migration projections.
7. **Shadow-read production state.** Run the new projector alongside the
   legacy columns against production traffic and backfilled history. Record
   every diff and require zero unexplained divergence for a minimum seven-day
   soak before surface cutover.
8. **Prove durability.** Run replay, restart, duplicate-command,
   conflicting-idempotency-key, partial-projection, migration, late-callback,
   and closed-release tests, including `HOLD` and `ROLLBACK`.
9. **Cut over surfaces and production execution.** Remove direct lifecycle
   writes, select the supported executor, and make CLI, TUI, dashboard, MCP,
   harness, and integrations consume projections and submit commands.
10. **Unblock differentiation.** Resume deferred capability work only after
    the acceptance criteria below are enforced in CI.

## Acceptance criteria

- [x] All application binding lifecycle changes, including ChangeSet scope events, enter
      through the Foreman command boundary;
      no client, worker, or adapter path directly writes lifecycle columns or
      appends binding events. Explicit idempotent backfill SQL remains a
      migration-only historical import and is not an application writer.
- [x] `verificationVerdict`, `reviewAssessment`, `releaseDecision`, and
      `outcomeStatus` are projected from the ledger and remain independent.
- [x] `review.recorded` uses only `NO_FINDINGS`, `FINDINGS`, or `ESCALATE`;
      `reviewAssessment` is the canonical projection and legacy
      `reviewDecision` values are compatibility-only. Only a scoped
      `approval.recorded` event can grant authority. `release.decided` requires
      a tagged `ReleaseApprovalRef` for the exact current ChangeSet digest and
      matching `targetOutcome` (`RELEASE`/`HOLD`) or the active Release ID
      (`ROLLBACK`), and a review-event ID cannot satisfy that reference.
      Typed constructors enforce this at compile time for trusted callers;
      runtime validation enforces it for JSON, persisted, and remote inputs.
- [x] Verification/review/approval/release event constructors are structurally
      disjoint. A release decision requires exactly `RELEASE`, `HOLD`, or
      `ROLLBACK`; a `HOLD` event cannot project as `RELEASE`.
- [x] Every edge and illegal edge in the [companion transition table](./0010-factory-lifecycle-transition-table.md)
      is exercised through the transition command API; idempotent self-edges
      and fail-closed illegal edges are asserted, and domain-preconditioned
      edges fail closed until their required facts exist. Dedicated spine tests
      cover revision loops, release holds, rollback eligibility, and late
      verification callbacks.
- [x] Hosted and local command handling serializes per WorkOrder, not per
      Factory or tenant. Signed self-hosted completions are translated into
      Foreman commands and cannot append events directly.
- [x] Repeating a command with the same idempotency key returns the original
      result without duplicating an event or transition. The same key with a
      different canonical payload hard-fails with an idempotency conflict.
      Aggregate event order is deterministic across retries and restarts.
- [x] A process or Durable Object restart can reconstruct the same state from
      the ledger, and a failed projection can be rebuilt without a data repair
      performed by a client.
- [x] A new ChangeSet digest resets the current verification projection to
      `UNKNOWN` and invalidates prior-digest review/release eligibility; late
      old-digest evidence cannot mutate current state.
- [x] A fixed replay suite runs the same ordered event fixtures against Memory,
      SQLite, and D1 and produces identical verification, review, approval,
      release, rollback, outcome, and legacy-migration projections.
- [ ] The production shadow-read phase records zero unexplained projection
      divergence for the declared soak window, with historical backfill diffs
      accounted for before surfaces switch to the new projection.
- [x] Legacy mappings are explicit and non-overlapping. The graph projector
      maps legacy verification/review/release events in named branches; only
      `release.completed{decision: RELEASE}` can project a release, and no
      approval maps to review completion or `ready` to a release outcome.
- [x] `AuditEvent` is generated from the Factory Graph projection and has no
      independent append path; the Memory, SQLite, and D1 adapters expose only
      read-only audit projections.
- [x] CI rejects duplicate semantic `.tinkerbot/` paths, loaded untracked
      files, and definition digest drift.
- [x] A grep- or static-analysis-verifiable check finds no direct application
      write to lifecycle route fields (`status`, `current_stage`, `actor`) or
      decision fields (`verification_verdict`, `review_assessment`,
      `release_decision`) outside the projection/compatibility layer.
- [x] Every client surface reads the same graph projection for lifecycle state;
      provider adapters retain only external references, delivery status, and
      correlation metadata.
- [x] Secret/credential rejection, tenant isolation, actor authorization, and
      audit provenance remain enforced at the command and event boundary.
- [x] The companion transition table and Foreman legality checks are verified
      against the same executable transition contract; the transition contract
      test fails on snapshot drift and tests every legal/illegal command edge.
- [x] Any file moved during consolidation is resolved in a durable inventory
      as discarded, merged, or explicitly flagged before its staging location
      is cleaned up.
- [x] The supported hosted executor contract is explicit: signed self-hosted
      dispatch is the only production execution claim; the Cloudflare Sandbox
      binding is unsupported until implemented and stage-proven, and an absent
      executable binding fails closed with a graph-visible block.
- [ ] The declared `FACTORY_RUN` binding either has a real
      `WorkflowEntrypoint<Env, Params>` implementation with a durable
      `WorkflowStep`/`step.do` boundary and a runtime caller, or is removed until
      a Workflow use case is approved. Queue → Foreman remains the active hosted
      delivery path while this gate is open.
- [ ] `main` is the only release source for the Factory Spine and these ADRs;
      divergent worktrees are triaged and cannot remain parallel sources of
      truth.
- [ ] One complete hosted self-hosted lifecycle has been proven before the
      executor is called production-ready.
- [ ] This ADR changes to `Accepted` only after the adapter conformance suite
      and the declared production shadow-read soak pass, with duration,
      divergence count, and test evidence recorded here or in linked durable
      artifacts. Until then, the spine is not production-authoritative.

## Current implementation evidence

The current `main` worktree implements the local/hosted application durability
contract without treating this ADR as accepted:

- SQLite and D1 persist command receipts, ordered graph events, and graph
  outbox entries atomically when their adapter supports transactions/batches.
- Route/status fields (`status`, `current_stage`, and `actor`) are refreshed
  only by the replay projection transaction; transition timestamps advance from
  the same projected route event. Non-lifecycle metadata updates may still
  advance `updated_at` without changing route authority. Legacy transition
  calls emit a command-bound route event first, including the generic
  `work_order.transitioned` fallback for states without a domain event.
- Both adapters persist projection checkpoints with `APPLIED` and
  `RETRY_PENDING` states; `rebuildFactoryProjection` and
  `retryFactoryProjection` rebuild compatibility fields from the graph.
- Queue, API decision, ChangeSet, compatibility-transition, spec-approval,
  operator cell ownership, signed self-hosted completion, and OIDC
  verification paths share a canonical per-WorkOrder Foreman coordinator
  identity. Hosted views and factory activity/metrics prefer the replayed
  route projection and use compatibility columns only as fallback.
- WorkOrder creation uses `admitWorkOrder` in the Memory, SQLite, and D1
  adapters and in local/hosted command paths. `seedWorkOrder` is restricted to
  test and migration fixtures. The admission test covers the create event,
  receipt, replay, SQLite restart, and projected WorkOrder state.
- Shared local Factory operations live in
  `packages/local-runtime/src/factory-operations.ts`; `platform-mcp` no longer
  imports the CLI command module, so the former CLI/MCP package cycle is gone.
- Core WorkOrder list/detail/graph/mutation responses use the typed route
  contract in `packages/factory/src/route-contract.ts`; the Worker produces the
  list/detail/graph forms and CLI/TUI clients reject malformed successful
  responses instead of silently treating them as lifecycle state.
- Run responses and the core products/cells/skills/evolution/releases/outcomes
  collections use the same route-contract construction helpers; resource
  expansion remains additive and cannot redefine WorkOrder lifecycle authority.
- Self-hosted dispatch and the feature-gated Sandbox adapter now live behind
  `apps/control-plane-worker/src/factory-executor.ts`; `factory-runtime.ts`
  coordinates lifecycle decisions without embedding provider-specific executor
  behavior.
- Foreman Durable Object admission, typed decision handling, and bounded
  internal command request parsing now live behind
  `apps/control-plane-worker/src/foreman-routes.ts`; the runtime coordinator
  retains the lifecycle/run functions while the Worker entrypoint exposes the
  serialized coordinator as its own boundary.
- Shared bounded JSON request admission now lives behind
  `apps/control-plane-worker/src/factory-request.ts`, keeping MCP and Foreman
  payload limits consistent without duplicating parser logic.
- Scheduled Factory OS cell cleanup and maintenance dispatch now live behind
  `apps/control-plane-worker/src/factory-maintenance.ts`; maintenance emits a
  queue-shaped command and does not acquire lifecycle authority of its own.
- The Wrangler `FACTORY_RUN` binding is currently a configuration-only,
  unverified platform edge: `FactoryRunWorkflow` does not yet implement the
  official Workflow entrypoint/step contract and no source path calls
  `FACTORY_RUN.create`. The active hosted path is Queue → Foreman; this ADR
  does not count the Workflow binding as production authority until the
  contract is implemented and exercised, or the binding is removed.
- WorkOS membership, invitation, SCIM, and Events API reconciliation now live
  behind `apps/control-plane-worker/src/workos-sync.ts`; the Worker entrypoint
  keeps route/authentication concerns while the synchronization module owns
  tenant and identity updates without writing Factory lifecycle events.
- Session cookies, service credentials, tenant capability checks, invitation
  validation, and public tenant-session views now live behind
  `apps/control-plane-worker/src/tenant-auth.ts`; the Worker entrypoint passes
  the authorization boundary into route adapters without duplicating the role
  matrix or credential lookup logic.
- OAuth start/callback, session refresh, organization selection, membership
  reconciliation, invitation, and sign-out HTTP routes now live behind
  `apps/control-plane-worker/src/tenant-routes.ts`; the adapter receives
  response/body, origin, PKCE, redirect, and entitlement dependencies and
  cannot advance Factory lifecycle state directly.
- Hosted assurance summary, OIDC/run-token ingestion, receipt binding, evidence
  publication, and verification reconciliation now live behind
  `apps/control-plane-worker/src/assurance-routes.ts`; the Worker entrypoint
  supplies auth, entitlement, response, and queue dependencies while the route
  adapter keeps untrusted assurance input subordinate to the Factory command
  boundary.
- Factory definition validation, tree integrity checks, digest/version
  persistence, and automation replacement now live behind
  `apps/control-plane-worker/src/factory-definition-store.ts`; the graph store
  remains the lifecycle and command authority and does not own definition
  ingestion details.
- Stripe webhook, catalog, seat, checkout, subscription, trial, and scheduled
  reconciliation routes now live behind
  `apps/control-plane-worker/src/billing-routes.ts`. The module receives
  authentication/body/response dependencies and has no Factory dispatch or
  transition entrypoint, keeping provider/account state separate from the
  lifecycle spine.
- D1 graph command/domain composition remains in the
  `apps/control-plane-worker/src/factory-store.ts` façade; checkpoint writes,
  compatibility projection refresh, typed verification/decision recording,
  and read-only shadow audits now live behind
  `apps/control-plane-worker/src/factory-projection-store.ts`. The projection
  adapter is a host-owned persistence boundary, not a second lifecycle
  authority.
- D1 graph event, outbox, command-receipt, and replay persistence now live
  behind `apps/control-plane-worker/src/factory-graph-store.ts`; the enclosing
  `D1FactoryStore` façade still owns the `FactoryCommandBoundary` and remains
  the only Worker-facing lifecycle authority.
- D1 command and operational telemetry persistence now lives behind
  `apps/control-plane-worker/src/factory-telemetry-store.ts`; the main D1
  graph/domain store exposes only a façade so discardable telemetry cleanup
  cannot accidentally touch lifecycle tables.
- Hosted D1 metadata, tenant, billing, session, and webhook persistence now
  lives behind `packages/hosted-integrations/src/d1-stores.ts`; the provider
  protocol facade retains WorkOS/Stripe/configuration contracts without
  becoming the storage authority or a Factory lifecycle writer.
- R2 evidence persistence and optional customer HTTP replication now live
  behind `packages/hosted-integrations/src/evidence-store.ts`; replica
  failures remain discardable and cannot alter a deterministic verification
  verdict.
- GitHub webhook persistence and verification publication now live behind
  `apps/control-plane-worker/src/github-integrations.ts`; the Worker route
  entrypoint retains authentication and dispatch wiring without embedding
  provider-specific repository or Check Run behavior.
- Provider webhook admission, integration command dispatch, GitHub installation
  binding, and WorkOS webhook delivery now live behind
  `apps/control-plane-worker/src/integration-routes.ts`; provider intake remains
  subordinate to tenant/session boundaries and the Factory command boundary.
- Signed self-hosted completion verification, graph event translation, and
  resume dispatch now live behind
  `apps/control-plane-worker/src/self-hosted-routes.ts`; the Worker entrypoint
  supplies response/body and queue dependencies while the adapter preserves
  idempotent replay and keeps completion input subordinate to the Factory
  command boundary.
- Workspace environments, integrations, secret metadata, scorers,
  self-improvement records, and automation persistence now live behind
  `apps/control-plane-worker/src/factory-workspace-store.ts`; these are
  operator/read-model concerns and remain separate from graph events,
  command receipts, and lifecycle transitions.
- Graph-derived operator and WorkOrder views now live behind
  `apps/control-plane-worker/src/factory-read-model.ts`; the adapter rebuilds
  dashboard state from the D1 store and graph projection without becoming a
  second source of lifecycle authority.
- Run/stage, usage/cost, evidence, execution-plan, run-token, publication, and
  evaluation persistence now live behind
  `apps/control-plane-worker/src/factory-artifact-store.ts`; the adapter has no
  graph-event or command-boundary write path.
- Factory cells, products, skills, proposals, release candidates, deployments,
  outcomes, scorers, and self-improvement metadata now live behind
  `apps/control-plane-worker/src/factory-operations-store.ts`; organization
  checks are injected for proposal approval, and the adapter cannot append
  lifecycle graph events.
- WorkOS and Stripe protocol clients now live behind dedicated
  `packages/hosted-integrations/src/workos-provider.ts` and
  `packages/hosted-integrations/src/stripe-provider.ts` modules, with shared
  provider errors/request handling in `provider-core.ts`; the package index is
  a contract/configuration facade rather than a provider implementation hub.
- Runtime runner aliases and inference-provider aliases normalize into one
  canonical vocabulary in `packages/factory/src/runtime.ts`; unsupported
  hosted combinations produce typed capability codes, and the Worker reports
  those codes as graph-visible blocked outcomes. The local dashboard's
  in-memory backend is explicitly a preview fixture and is rejected when the
  static server runs with `CONTROL_PLANE_MODE=production`.
- The dashboard route loader rejects failed graph/list/detail/resource reads
  instead of substituting cached activity or preview state as authoritative
  lifecycle data. The package preparation step also removes all numeric-suffix
  generated artifacts before release packaging.
- `scripts/verify-schema-contract.mjs` checks the SQLite runtime DDL against the
  D1 graph, command, receipt, checkpoint, command-telemetry, and operational-
  telemetry migrations, including the tenant, aggregate-ordering, idempotency,
  receipt, retention, and projection-retry indexes. The verifier is part of
  `pnpm verify:tree` and the release build preflight.
- `D1FactoryStore.shadowReadOrganization` and the opt-in scheduled
  `FACTORY_SHADOW_READ_ORGANIZATION_ID` binding provide a bounded, read-only
  hosted comparison job. It emits divergence evidence and never repairs or
  rewrites compatibility state; the staging soak remains an external gate.
- D1 command dispatch retains the same payload-free telemetry envelope in
  `tinkerbot_factory_command_telemetry`; the ledger is explicitly
  non-authoritative and telemetry persistence failures are swallowed by the
  command boundary.
- The operational telemetry contract is typed separately from command
  telemetry. It covers queue delivery, Foreman coordination, projection
  shadow reads, self-hosted dispatch/completion, verification ingest, provider
  webhooks, and retention cleanup. SQLite and D1 expose bounded command
  telemetry cleanup, while D1 also persists the typed operational-signal
  ledger; all cleanup touches no graph, receipt, or projection table.
- `pnpm verify:release-gates` provides a repeatable local report and preserves
  the explicit `local_pass_external_pending` state; it is evidence collection,
  not ADR acceptance or production-authority promotion.
- `FactoryCommandBoundary` and the synchronous SQLite command path emit
  correlation-safe telemetry for commit, replay, validation/persistence
  failure, event/projection counts, idempotency key, and command latency. The
  telemetry record excludes command payloads and cannot change command outcome.
- The fixed Memory/SQLite/D1 conformance fixture, route-transition replay,
  restart/replay tests, and simulated partial-projection recovery test pass in
  the repository test suite. The latest full run was `53` files and `337`
  tests.
- The current working tree passes `pnpm typecheck`, `pnpm verify:source-tree`,
  `pnpm verify:factory-tree`, `pnpm verify:migrations`,
  `pnpm verify:schema-contract`, and `git diff --check`.
  The duplicate inventory records 592 byte-identical copies removed from active
  paths and 61 durable quarantine files. The cleanup is staged in the current
  index but not committed, so a fresh checkout remains an open source-tree
  gate.
- When the hosted runtime has no executable Sandbox binding and the WorkOrder
  does not require self-hosted execution, `runFactoryTurn` records a typed
  `task.blocked` reason (`cloudflare_sandbox_unsupported`), transitions the
  WorkOrder to `blocked`, and returns `executor_unavailable`; it does not leave
  the WorkOrder waiting on an unavailable executor.
- Production shadow-read soak, one complete hosted self-hosted lifecycle,
  provisioned staging/production resources, a reviewed commit of the staged
  source cleanup, and signed release artifacts remain release gates.

## Explicitly deferred until the spine is complete

- Cloudflare Sandbox implementation and hosted execution expansion
- Production WorkOS, Stripe, Cloudflare provisioning, and staging proof
- Per-tenant Slack, Linear, Jira, GitHub, and GitLab integration hardening
- Outcome measurement operations and economics dashboards beyond projection
  contracts
- Scorers, Factory Steward activation, and the self-improvement loop
- New dashboard, CLI, TUI, or MCP surface area beyond what is required to
  consume the spine

## Consequences

### Positive

- Every client receives one replayable answer for verification, review,
  release, and outcome state.
- Restart, migration, storage replacement, and projection repair become normal
  operations instead of bespoke data-reconciliation events.
- The `HOLD`/`RELEASE` ambiguity and similar evidence-to-authority leaks are
  prevented by the event contract rather than by convention.
- The product can differentiate on planning, deterministic assurance,
  vendor-neutral execution, economics, and learning without re-litigating
  lifecycle ownership for every feature.

### Costs and risks

- The change crosses the store, Foreman, local runtime, hosted Worker, CLI,
  TUI, dashboard, MCP, harness, migration, and test paths.
- Historical D1 and SQLite rows require an explicit, auditable backfill and may
  need a compatibility projection while clients migrate.
- A durable command boundary adds ordering, idempotency, and failure handling
  that must be tested rather than assumed.
- Differentiation work is gated for the duration of the spine migration, which
  carries an accepted opportunity cost.

## Non-goals

- Replacing D1 or SQLite with a particular vendor or database technology
- Making Workers AI, an agent, an integration, or a client an authority
- Removing the WorkOrder model immediately; it remains as a graph-backed view
  until compatibility consumers are migrated
- Requiring hosted execution for local-first or self-hosted deployments
- Treating a successful event append as proof that verification, review, or
  release has happened without the corresponding typed event
