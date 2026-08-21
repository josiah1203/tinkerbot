# ADR-0010: Durable Factory Spine Before Differentiation

## Status

Proposed

## Date

2026-08-20

## Owners

Factory core / platform team

## Refines

[ADR-0009: Factory authority planes](./0009-factory-authority-planes.md)

## Companion artifact

[Factory lifecycle transition table](./0010-factory-lifecycle-transition-table.md)

## Relationship to ADR-0009

ADR-0009's four-plane ownership remains in force: `tb check` is the
authoritative deterministic inspection engine, workers and Intelligence are
advisory, and external systems are adapters. This ADR is authoritative for the
durable event vocabulary, command boundary, transition rules, and canonical
ledger projections. Existing `reviewAssessment` and `releaseDecision` values
may remain as compatibility views while consumers migrate; they are not a
second source of lifecycle truth.

## Context

Tinkerbot's differentiated value is built on a shared lifecycle: intent,
planning, execution, deterministic verification, review, release, and outcome.
The Control Plane, CLI, TUI, MCP server, integrations, and local runtime must
all answer the same question about a WorkOrder. They cannot do that reliably
while each surface can maintain or mutate its own interpretation of lifecycle
state.

The repository already contains most of the ingredients for a Factory Graph:
typed graph events, local SQLite persistence, hosted D1 persistence, legacy
WorkOrder/run/stage tables, and graph-backed views. They are not yet a durable
spine. In particular:

- `verification_verdict`, `review_assessment`, and `release_decision` still
  exist as mutable WorkOrder columns and are updated alongside graph events.
- `recordTypedDecision()` can write a legacy decision column and append a graph
  event in the same operation, so the column and the ledger can disagree.
- The current projector treats `release.completed` as `RELEASE` without
  requiring an explicit release outcome. A `HOLD` payload can therefore be
  represented as a release event that projects as `RELEASE`.
- Legacy state mappings such as `approval -> review.completed` and
  `ready -> release.requested` blur review, approval, and release authority.
- The in-memory ledger and the D1/SQLite stores do not yet share a complete
  restart, ordering, idempotency, and replay contract.
- Duplicate or stray files under `.tinkerbot/` can make loader behavior depend
  on filesystem state rather than on a reproducible definition tree.

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
| Verification evidence and verdict | `verification.recorded` | Records `PASS`, `FAIL`, or `UNKNOWN` for a specific ChangeSet digest; only deterministic verification may emit a binding verdict. |
| Review assessment | `review.recorded` | Records `NO_FINDINGS`, `FINDINGS`, or `ESCALATE`; never releases work and never uses `APPROVE` as a wire value. |
| Approval request | `approval.requested` | Requests a scoped human/designated checkpoint; does not grant authority. |
| Human or designated approval | `approval.recorded` | Records `scope: SPEC | RELEASE | ROLLBACK` and `outcome: GRANTED | DENIED`; never substitutes for deterministic verification or a release decision. |
| Release request | `release.requested` | Records intent to release; does not change released state. |
| Release outcome | `release.decided` | Requires exactly one `RELEASE`, `HOLD`, or `ROLLBACK` outcome plus a typed reference to the specific matching `approval.recorded` event; it is the only event that changes release decision state. |
| Release execution | `release.executed` | Records execution after `release.decided { outcome: RELEASE }`; it does not independently authorize release. |
| Explicit rollback | `release.rolled_back` | Records rollback execution after a `release.decided { outcome: ROLLBACK }`; it does not independently authorize or change the release decision. |

Legacy `*.completed` events may be read during migration but cannot be emitted
by new code. A compatibility reader must not infer a release outcome from an
event name. In particular, `HOLD` must remain `HOLD` through append, replay,
projection, API response, and client rendering.

The canonical projection preserves these independent truths:

```text
verificationVerdict = PASS | FAIL | UNKNOWN  # for the current ChangeSet digest
reviewAssessment    = CLEAR | NEEDS_HUMAN_REVIEW | REVISE
releaseDecision     = NOT_RELEASED | RELEASE | HOLD | ROLLBACK
outcomeStatus       = UNMEASURED | PENDING | POSITIVE | NEUTRAL | NEGATIVE | UNKNOWN
```

The canonical review event maps `NO_FINDINGS -> CLEAR`, `FINDINGS -> REVISE`,
and `ESCALATE -> NEEDS_HUMAN_REVIEW` for the existing compatibility projection.
The event and payload types must use distinct tagged IDs for review and
approval. A `release.decided` payload contains a `ReleaseApprovalRef` whose
`kind` and `scope` can only reference an `approval.recorded` event for the
same WorkOrder and requested release scope. For `RELEASE` and `HOLD`, the
reference must target the current ChangeSet digest and requested outcome. For
`ROLLBACK`, it must target the active Release ID and its release digest. A
`ReviewEventId` cannot satisfy that type, even if a caller has its string value.

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

### 6. Gate differentiation on spine completion

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

1. **Freeze the spine contract.** Inventory lifecycle writes, event types,
   projections, migration paths, surface readers, and the companion transition
   table. Mark each path as command, event, projection, adapter, or deprecated
   compatibility code.
2. **Make the source tree reproducible.** Remove or quarantine duplicate
   semantic paths and add the loader/CI guard before using the tree as a replay
   fixture.
3. **Introduce typed event constructors.** Add the disjoint verification,
   review, approval, request, and release-decision payloads. Stop emitting
   ambiguous legacy completion events.
4. **Close the command boundary.** Route every binding transition through the
   Foreman durable authority, including worker completion, integration
   callbacks, and legacy migration. Add idempotency and ordering behavior.
5. **Cut over projections.** Rebuild D1 and SQLite lifecycle read models from
   canonical events. Backfill history with explicit migration events and retain
   compatibility fields only as derived views.
6. **Shadow-read production state.** Run the new projector alongside the
   legacy columns against production traffic and backfilled history. Record
   every diff, resolve or explicitly reject each one, and require zero
   unexplained divergence for the declared production soak window (minimum
   seven consecutive days) before surface cutover.
7. **Prove durability.** Run replay, restart, duplicate-command, conflicting
   idempotency-key, partial-projection, migration, late-callback, and D1/SQLite
   equivalence tests, including `HOLD` and `ROLLBACK`.
8. **Cut over surfaces.** Remove direct lifecycle writes and make CLI, TUI,
   dashboard, MCP, harness, and integrations consume projections and submit
   commands.
9. **Unblock differentiation.** Resume deferred capability work only after the
   acceptance criteria below are enforced in CI.

## Acceptance criteria

- [ ] All binding lifecycle changes enter through the Foreman command boundary;
      no surface, worker, adapter, or migration path directly writes lifecycle
      columns or appends binding events.
- [ ] `verificationVerdict`, `reviewAssessment`, `releaseDecision`, and
      `outcomeStatus` are projected from the ledger and remain independent.
- [ ] `review.recorded` cannot carry `APPROVE`; only a scoped
      `approval.recorded` event can grant authority. `release.decided` requires
      a tagged `ReleaseApprovalRef` for the exact current ChangeSet digest
      (`RELEASE`/`HOLD`) or active Release ID (`ROLLBACK`), and a review-event
      ID cannot satisfy that reference.
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
- [ ] A fixed replay suite produces identical D1 and SQLite projections for
      verification, review, approval, release, rollback, outcome, and legacy
      migration scenarios.
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
      write to `verification_verdict`, `review_assessment`, or
      `release_decision` outside the projection/compatibility layer.
- [ ] Every client surface reads the same graph projection for lifecycle state;
      provider adapters retain only external references, delivery status, and
      correlation metadata.
- [ ] Secret/credential rejection, tenant isolation, actor authorization, and
      audit provenance remain enforced at the command and event boundary.

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
