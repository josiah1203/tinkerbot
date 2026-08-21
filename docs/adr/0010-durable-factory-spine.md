# ADR-0010: Durable Factory Spine Before Differentiation

## Status

Proposed (Revision 7 — hosted command routing and canonical client projections)

## Date

2026-08-20

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

The current implementation partially closes these defects: canonical review,
verification, approval, and release commands now use typed constructors and the
command boundary, and the compatibility projector only treats a legacy
release event with an explicit `RELEASE` outcome as released. The remaining
work is to remove or isolate legacy writers, prove adapter equivalence, and
record production shadow-read evidence.

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
Cloudflare Sandbox remains an explicitly incomplete, unsupported placeholder
until its binding and isolation contract are implemented and stage-proven.
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
green. The gate covers Sandbox implementation, production provider proof,
per-tenant integration hardening, outcome/economics operations, scorers, and
self-improvement.

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

- [ ] All binding lifecycle changes, including ChangeSet scope events, enter
      through the Foreman command boundary;
      no surface, worker, adapter, or migration path directly writes lifecycle
      columns or appends binding events.
- [ ] `verificationVerdict`, `reviewAssessment`, `releaseDecision`, and
      `outcomeStatus` are projected from the ledger and remain independent.
- [ ] `review.recorded` uses only `NO_FINDINGS`, `FINDINGS`, or `ESCALATE`;
      `reviewAssessment` is the canonical projection and legacy
      `reviewDecision` values are compatibility-only. Only a scoped
      `approval.recorded` event can grant authority. `release.decided` requires
      a tagged `ReleaseApprovalRef` for the exact current ChangeSet digest and
      matching `targetOutcome` (`RELEASE`/`HOLD`) or the active Release ID
      (`ROLLBACK`), and a review-event ID cannot satisfy that reference.
      Typed constructors enforce this at compile time for trusted callers;
      runtime validation enforces it for JSON, persisted, and remote inputs.
- [ ] Verification/review/approval/release event constructors are structurally
      disjoint. A release decision requires exactly `RELEASE`, `HOLD`, or
      `ROLLBACK`; a `HOLD` event cannot project as `RELEASE`.
- [ ] Every edge and illegal edge in the [companion transition table](./0010-factory-lifecycle-transition-table.md)
      has a command-side test, including revision loops, release holds,
      rollback eligibility, and late verification callbacks.
- [ ] Hosted and local command handling serializes per WorkOrder, not per
      Factory or tenant. Signed self-hosted completions are translated into
      Foreman commands and cannot append events directly.
- [ ] Repeating a command with the same idempotency key returns the original
      result without duplicating an event or transition. The same key with a
      different canonical payload hard-fails with an idempotency conflict.
      Aggregate event order is deterministic across retries and restarts.
- [ ] A process or Durable Object restart can reconstruct the same state from
      the ledger, and a failed projection can be rebuilt without a data repair
      performed by a client.
- [ ] A new ChangeSet digest resets the current verification projection to
      `UNKNOWN` and invalidates prior-digest review/release eligibility; late
      old-digest evidence cannot mutate current state.
- [ ] A fixed replay suite runs the same ordered event fixtures against Memory,
      SQLite, and D1 and produces identical verification, review, approval,
      release, rollback, outcome, and legacy-migration projections.
- [ ] The production shadow-read phase records zero unexplained projection
      divergence for the declared soak window, with historical backfill diffs
      accounted for before surfaces switch to the new projection.
- [ ] Legacy mappings are explicit and non-overlapping. No migration maps
      approval to a review-completion event or ready to a release outcome.
- [ ] `AuditEvent` is generated from the Factory Graph projection and has no
      independent append path.
- [ ] CI rejects duplicate semantic `.tinkerbot/` paths, loaded untracked
      files, and definition digest drift.
- [ ] A grep- or static-analysis-verifiable check finds no direct application
      write to lifecycle route fields (`status`, `current_stage`, `actor`) or
      decision fields (`verification_verdict`, `review_assessment`,
      `release_decision`) outside the projection/compatibility layer.
- [ ] Every client surface reads the same graph projection for lifecycle state;
      provider adapters retain only external references, delivery status, and
      correlation metadata.
- [ ] Secret/credential rejection, tenant isolation, actor authorization, and
      audit provenance remain enforced at the command and event boundary.
- [ ] The companion transition table and Foreman legality checks are generated
      from, or verified against, the same transition contract; a mismatch is a
      build- or review-blocking failure.
- [ ] Any file moved during consolidation is resolved in a durable inventory
      as discarded, merged, or explicitly flagged before its staging location
      is cleaned up.
- [ ] `main` is the only release source for the Factory Spine and these ADRs;
      divergent worktrees are triaged and cannot remain parallel sources of
      truth.
- [ ] Exactly one production executor is documented as supported, and one
      complete hosted lifecycle has been proven before the executor is called
      production-ready.
- [ ] This ADR changes to `Accepted` only after the adapter conformance suite
      and the declared production shadow-read soak pass, with duration,
      divergence count, and test evidence recorded here or in linked durable
      artifacts. Until then, the spine is not production-authoritative.

## Current implementation evidence

The current `main` worktree implements the local/hosted durability contract
without treating this ADR as accepted:

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
- The fixed Memory/SQLite/D1 conformance fixture, route-transition replay,
  restart/replay tests, and simulated partial-projection recovery test pass in
  the repository test suite. The latest full run was `50` files and `321`
  tests.
- The repository-wide typecheck and factory-tree gate remain intentionally
  red because the worktree contains unresolved duplicate/untracked artifacts;
  the duplicate inventory records the `.tinkerbot/` state and no destructive
  cleanup has been authorized. Production shadow-read soak and one complete
  hosted lifecycle remain external proof gates.

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
