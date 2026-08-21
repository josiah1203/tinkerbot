# ADR-0010 Companion: Factory Lifecycle Transition Table

## Status

Proposed with [ADR-0010](./0010-durable-factory-spine.md)

## Purpose

This table is the executable state-machine contract for the durable Factory
Spine. It removes the phrase “legal transition” from the realm of convention:
each edge has a precondition, an event, a resulting state, and a replay/retry
rule.

The canonical loop is:

```text
Intake → Triage → Plan/Capacity → Specification → Spec approval
  → Implementation → VerificationRun → Review
  → Revision? → Implementation
  → Release approval → Release.decided{RELEASE|HOLD}
  → Release execution (RELEASE path) → Outcome/Economics → Complete
```

An active release may take a separate rollback branch:

```text
Released → Rollback approval → Release.decided{ROLLBACK}
         → Release.rolled_back → Outcome/Economics
```

Plan/Capacity and Outcome/Economics are Factory Graph subdomains, not new
legacy `WorkOrder.status` values in the first migration. The existing status
field remains a compatibility projection while the graph carries the richer
scope, digest, decision, and outcome state.

## State vocabulary

### WorkOrder route states

These are the current compatibility states and their canonical meaning:

| Compatibility state | Canonical meaning |
| --- | --- |
| `intake` | Authorized demand has created a WorkOrder but routing has not completed. |
| `triage` | Foreman is classifying demand, risk, and required line. |
| `specification` | Intent, acceptance criteria, and implementation contract are being formed. |
| `implementation` | A current ChangeSet is being produced in an execution cell. |
| `verification` | A deterministic VerificationRun is evaluating the current ChangeSet digest. |
| `review` | Review evidence is being recorded for the current digest. |
| `approval` | A scoped human/designated checkpoint is pending; `scope` distinguishes `SPEC`, `RELEASE`, and `ROLLBACK`. |
| `ready` | Release approval has been granted for the current digest; release execution is still pending. |
| `merged` | The approved ChangeSet has been merged or assembled for release execution. |
| `released` | Release execution has been recorded. Outcome measurement continues as a sidecar graph. |
| `blocked` | A required input, gate, capacity, or authority is missing. |
| `failed` | Execution or a required operation failed and needs recovery or requeue. |
| `cancelled` | An authorized cancellation closed the WorkOrder without release. |
| `unknown` | State cannot be safely reconstructed; no release action is eligible. |

### Independent decision state

The route state never replaces the decision projections:

```text
verificationVerdict = PASS | FAIL | UNKNOWN
reviewAssessment    = CLEAR | NEEDS_HUMAN_REVIEW | REVISE
releaseDecision     = NOT_RELEASED | RELEASE | HOLD | ROLLBACK
```

`verificationVerdict` is always scoped to the current ChangeSet digest.
`reviewAssessment` is a compatibility projection of the canonical review
outcomes `NO_FINDINGS`, `FINDINGS`, and `ESCALATE`. Release authority comes only
from a scoped `approval.recorded` event and a subsequent `release.decided`
event.

## Executable contract snapshot

The route legality implementation lives in
`packages/factory/src/transition-contract.ts`. This snapshot is checked by the
factory transition contract test; changing either the implementation or this
table without changing the other is a verification failure.

<!-- factory-transition-contract:start -->

```json
{
  "intake": ["triage", "specification", "implementation", "verification", "blocked", "cancelled", "unknown"],
  "triage": ["specification", "implementation", "verification", "blocked", "cancelled", "failed", "unknown"],
  "specification": ["implementation", "approval", "blocked", "cancelled", "failed", "unknown"],
  "implementation": ["review", "verification", "blocked", "cancelled", "failed", "unknown"],
  "review": ["verification", "implementation", "approval", "blocked", "cancelled", "failed", "unknown"],
  "verification": ["approval", "review", "blocked", "failed", "unknown"],
  "approval": ["ready", "implementation", "blocked", "cancelled", "unknown"],
  "ready": ["merged", "blocked", "cancelled", "unknown"],
  "merged": ["released", "unknown"],
  "released": [],
  "blocked": ["intake", "triage", "specification", "implementation", "review", "verification", "approval", "cancelled", "failed", "unknown"],
  "failed": ["intake", "cancelled", "unknown"],
  "cancelled": ["unknown"],
  "unknown": ["intake", "blocked", "failed", "cancelled"]
}
```

<!-- factory-transition-contract:end -->

## Transition table

| From | Trigger and precondition | Event(s) | Result | Revisitable / retry rule |
| --- | --- | --- | --- | --- |
| `intake` | Demand is authenticated, tenant-scoped, and idempotent. | `work_order.created`, then `task.queued` | `triage` | Same intake command and payload are idempotent; a different payload with the same key conflicts. |
| `triage` | Risk, source, dependencies, and line are classified. | `task.decomposed`, `capacity.updated` | Plan/Capacity evidence is present; continue to `specification`. | Capacity may be recomputed without changing lifecycle state. A changed plan requires a new versioned event. |
| Plan/Capacity | Required capacity and policy constraints are satisfied. | `spec.created` | `specification` | A revised spec creates a new spec version; an old spec approval cannot authorize it. |
| `specification` | Spec is complete and a human/designated spec checkpoint is required. | `approval.requested(scope=SPEC)` | `approval(scope=SPEC)` | Duplicate request for the same spec is idempotent. |
| `approval(scope=SPEC)` | `approval.recorded(scope=SPEC, outcome=GRANTED)` by an authorized non-worker actor. | `approval.recorded`, `task.started` | `implementation` | A denial returns to `specification`, `blocked`, or `cancelled` according to policy. |
| `implementation` | A bounded worker/session produces a ChangeSet with an immutable content digest. | `change.proposed`, `verification.started` | `verification` for the new digest | A worker completion is accepted only through the Foreman command boundary. |
| `verification` | Deterministic verifier evaluates the current `(WorkOrder, ChangeSet digest)`. | `verification.recorded(verdict=PASS|FAIL|UNKNOWN)` | `review` for `PASS` or `UNKNOWN`; `implementation`/`blocked` for `FAIL` | A new run for the same digest may replace the current verdict in aggregate order. A new digest resets it to `UNKNOWN`. |
| `review` | Current-digest verification and review evidence are sufficient to request release authority. | `review.recorded(outcome=NO_FINDINGS)`, `release.requested`, `approval.requested(scope=RELEASE)` | `approval(scope=RELEASE)` | Review is never release authority; duplicate requests are idempotent. |
| `review` | Findings require rework. | `review.recorded(outcome=FINDINGS)`, `task.reworked`, `change.updated` | `implementation` with a new digest | This is the normal revision loop; old verification and approvals are ineligible. |
| `review` | Review cannot safely conclude. | `review.recorded(outcome=ESCALATE)` | `blocked` or scoped human review | No release request may bypass the escalation. |
| `approval(scope=RELEASE)` | Authorized approver grants release authority for the exact current digest and requested outcome. | `approval.recorded(scope=RELEASE, outcome=GRANTED, targetOutcome=RELEASE)` | `ready` | The approval reference is digest- and outcome-bound and cannot be reused after `change.updated`. |
| `approval(scope=RELEASE)` | Release authority denies or withdraws approval. | `approval.recorded(scope=RELEASE, outcome=DENIED)` | `blocked`, `review`, or `implementation` per reason | No `release.decided` may reference a denied approval. |
| `ready` | The Foreman has a valid `ReleaseApprovalRef`, current verification `PASS`, and policy gates pass. | `release.decided(outcome=RELEASE)` | `releaseDecision=RELEASE`; release execution may proceed | Same decision command is idempotent. A different outcome or approval reference conflicts. |
| `ready` | Authorized release authority elects not to release yet with an explicit hold authorization for the current digest. | `approval.recorded(scope=RELEASE, outcome=GRANTED, targetOutcome=HOLD)`, `release.decided(outcome=HOLD)` | `releaseDecision=HOLD`; remains `ready` with a hold reason | A later `RELEASE` requires a new decision and a still-valid `targetOutcome=RELEASE` approval reference. `HOLD` never projects as `RELEASE`. |
| `ready` | A `RELEASE` decision exists and the approved ChangeSet is assembled or merged. | `integration_candidate.assembled` | `merged` | Assembly is replayable; it cannot create a release decision. |
| `merged` | A prior `RELEASE` decision exists and execution succeeds. | `release.executed` | `released` | Execution is not authority; a duplicate execution is idempotent. |
| `released` | An active release must be reversed and rollback policy permits it. | `approval.recorded(scope=ROLLBACK, outcome=GRANTED, targetOutcome=ROLLBACK)`, `release.decided(outcome=ROLLBACK)` | `releaseDecision=ROLLBACK` | `ROLLBACK` is illegal without an existing release reference and rollback approval. |
| `released` | The authorized rollback operation completes. | `release.rolled_back` | Rollback execution evidence is recorded; the WorkOrder remains historically released while the Release projection is rolled back. | Duplicate rollback execution is idempotent; it cannot create a second release decision. |
| `released` | The outcome measurement window is opened and later matures. | `outcome.measurement_started`, `outcome.observed`, `outcome.matured`, `cost.recorded` | Outcome/Economics sidecars become mature; `WorkOrder.status` remains `released`. | Observations are append-only and may not mark an immature positive outcome. |
| Any non-terminal state | Authorized cancellation is requested. | `work_order.transitioned{toState=cancelled}` | `cancelled` | Cancellation is idempotent; it cannot be used to disguise a release decision. |

## Digest and late-event rules

1. `change.proposed` or `change.updated` establishes the current ChangeSet
   digest. It resets `verificationVerdict` to `UNKNOWN` and invalidates
   digest-bound review and release approvals.
2. A `verification.recorded` event for an old digest is retained as historical
   evidence but cannot change the current WorkOrder projection.
3. After `release.decided`, an identical verification callback is an
   idempotent replay. A conflicting or new callback for the closed current
   digest is rejected with a closed-lifecycle conflict and cannot reopen or
   rewrite release state.
4. A `release.decided(outcome=ROLLBACK)` requires an active prior release and a
   typed rollback approval reference. It cannot be used as a generic failure
   transition from `intake`, `implementation`, or `ready`.
5. Projection order is the per-WorkOrder event sequence assigned by the
   Foreman. D1 and SQLite must produce the same state from the same sequence,
   regardless of wall-clock arrival order.
6. Every compatibility route transition carries `fromState`, `toState`,
   `causeId`, and `currentStage` in its command-bound graph event. Domain
   event families are used where available; `work_order.transitioned` is the
   canonical fallback for states such as `cancelled` and `unknown`.

## Illegal transitions that must fail closed

- `review.recorded(NO_FINDINGS)` cannot satisfy a release approval reference.
- A `ReviewEventId` cannot be supplied where `ReleaseApprovalRef` is required.
- `release.decided(RELEASE)` cannot occur without current-digest verification
  `PASS`, required review evidence, policy eligibility, and a matching scoped
  approval.
- `release.decided(ROLLBACK)` cannot occur before an executed release.
- A worker, agent, or Intelligence actor cannot emit `approval.recorded` or
  `release.decided` for its own WorkOrder.
- A same-key command with a different canonical payload cannot be silently
  treated as a replay.
- A projection or compatibility column cannot advance a WorkOrder without the
  corresponding ledger event.
- Typed constructors must reject review IDs where approval IDs are expected;
  untrusted JSON, persisted legacy rows, and remote commands must also pass
  runtime validation at the Foreman boundary.
