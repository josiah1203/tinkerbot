# Tinkerbot Factory Transition Implementation Plan

## Objective

Transition Tinkerbot from deterministic change verification into an intent-driven, human-and-agent software factory. The system must have one shared Factory Graph, an append-only authoritative event ledger, provider-neutral integrations, and a closed loop from intent through outcome and economics.

## Non-negotiable guardrails

- Tinkerbot is standalone. Providers are adapters, never the domain model.
- `tb` is the canonical CLI; `tinkerbot` remains its alias.
- `.tinkerbot/` is the local definition/configuration root.
- The Control Plane, CLI, TUI, local reports, and integrations are projections of the same Factory Graph.
- GitHub is an optional, least-privilege source-control adapter. A Tinkerbot GitHub App installation is not a required product path.
- Customers own implementation workers, models, runners, and BYOK credentials.
- Workers cannot approve or release their own work.
- Only deterministic verification writes `verificationVerdict`.
- Passing verification is neither review approval nor release authority.
- Secrets never appear in definitions, work orders, receipts, evidence, external messages, or ordinary logs.

## Completion definition

The transition is complete only when every material lifecycle object can be reconstructed from the append-only Factory Graph, all product surfaces use graph projections, external systems cannot become a source of truth, and the solo, enterprise, integration-command, and high-risk scenarios pass end to end.

## Current benchmark: Warp Factories

This comparison is a capability benchmark, not a dependency decision. Warp's public material describes an Early Access, cloud-hosted factory built around a foreman, triage/spec/implement/review agents, cloud runs, runners, multi-harness/model choice, integrations, dashboards, scorers, and self-improvement. Tinkerbot keeps the useful factory workflow while preserving a standalone, local-first product boundary.

| Capability | Tinkerbot after this transition | Warp Factories benchmark | Gap or decision |
| --- | --- | --- | --- |
| Product boundary | Standalone `tb`, TUI, local reports, and Control Plane; providers are adapters | Managed cloud factory assembled on an automation platform | Tinkerbot owns the domain model; hosted rollout remains a deployment gate |
| Lifecycle | Intent → decision → spec → work order → task/worker → change → deterministic verification → approval/release → outcome/economics | Foreman routes triage/spec/implement/review/verify/ship/monitor | Tinkerbot is stronger on explicit authority, replay, outcomes, and economics; live closed-loop operations still need provider validation |
| Execution | Customer-owned workers/runners and BYOK boundary; optional Tinkerbot-managed advisory intelligence | Cloud agent runs, runners, supported harnesses/models, and eligible self-host execution | Real customer runner/PR continuation, sandbox attachment, and hosted steering are external rollout work |
| Integrations | Provider-neutral command/adapter contracts, ExternalReference mapping, GitHub/GitLab intake, and `@tinkerbot` command API | Built-in Slack, GitHub, GitLab, Linear, Jira, direct runs, schedules, and Factory MCP | Adapter callbacks, signatures, credentials, rate limits, and production smoke tests remain external |
| Assurance and authority | Append-only Factory Graph, deterministic `tb check` verdict, independent review, human approval, release gates, signed evidence | Review/verification agents and human approval/merge handoff | Tinkerbot's authority split is explicit; production evidence ingestion and release drills remain external |
| Measurement | Typed outcome maturity, cost ledger, COPQ/OEE-style projections, and cost per accepted/unreverted/outcome-positive change | Dashboard, costs, scorers, benchmarks, and self-improvement proposals | Local contracts/projections are present; real telemetry, scorer calibration, and improvement operations need live data |
| Human control | Local and hosted graph-backed approval/release/outcome writes; no worker self-approval or self-release | Human spec approval, questions, and merge handoff | Cloud-to-local session handoff, notifications, and support runbooks need live validation |
| GitHub dependency | No Tinkerbot GitHub App installation is required; optional least-privilege adapter secrets only | Code-host authorization is part of factory setup | This is an intentional product difference, not a parity gap |

The benchmark is based on the Warp overview supplied with this task and Warp's current public factory material: [Warp homepage](https://www.warp.dev/), [cloud software factories guide](https://www.warp.dev/blog/a-guide-to-cloud-software-factories-for-engineering-leaders), and [factory build guide](https://www.warp.dev/blog/software-factory-build-guide).

## Local implementation status (provider-independent)

The repository now has the provider-independent foundation and can be exercised without credentials:

- Factory Graph contracts, authority checks, local SQLite persistence (including reopen-time legacy backfill), D1 migrations 0017–0018, replay projection, economics, and outbox sync are implemented.
- Local and hosted work-order creation/transitions emit canonical graph events; deterministic verification, approvals, release requests, outcomes, cost planning, worker sessions, claims, change proposals, and evidence receipts retain separate fields. The synchronous local CLI path makes creation, human approval, and graph-backed outcome writes durable before returning.
- `GET /work-orders/:id/graph`, `tb factory status <id>`, `tb work graph <id>`, local dashboard graph JSON, browser Control Plane timeline/state, and TUI `/graph <id>` are implemented.
- Micro, standard, and strategic local intent contracts are validated and persisted with progressive governance fields.
- Worker contracts, receipts, orchestration, production cells, assurance, outcomes, and lifecycle unit coverage are present.

The remaining release blockers are external-state work: real provider installations/signing secrets, production deployment and migration execution, live adapter callbacks, customer-runner/PR continuation, hosted observability, and end-to-end tests against those providers.

## Milestone 0 — Baseline and migration audit

### Deliverables

- Inventory verification, CLI, TUI, Control Plane, worker/runtime, evidence, authentication, billing, GitHub, migrations, fixtures, and tests.
- Classify existing code as preserve-and-connect, replace-with-projection, or deprecate.
- Document non-destructive migration for historical Work Orders, evidence, approvals, reports, and external references.
- Record architecture decisions for provider neutrality, event authority, implementation-worker ownership, and separate decision authorities.

### Exit gate

- Migration map is reviewed.
- No target architecture depends on GitHub App installation state.

## Milestone 1 — Shared Factory Graph and append-only ledger

### Deliverables

- Implement stable IDs and relationships for Organization, Factory, Repository, Objective, Intent, DecisionRecord, Spec, WorkOrder, Task, TaskDependency, Assignment, WorkerDefinition, WorkerCapability, WorkerSession, ExecutionCell, ChangeSet, BranchRef, PullRequestRef, IntegrationCandidate, VerificationRun, EvidenceReceipt, ReviewAssessment, ApprovalDecision, Release, OutcomePlan, OutcomeObservation, Incident, Rollback, PolicyVersion, AutonomyProfile, CapacitySnapshot, CostEvent, QualityEvent, IntegrationConnection, and AuditEvent.
- Persist immutable events with actor, actor type, organization/factory, timestamp, correlation and causation IDs, schema/policy version, provenance, and external references.
- Materialize lifecycle, audit, queue, economics, outcome, and surface projections from events.
- Persist events in local SQLite and hosted D1; support replay and migration tests.

### Exit gate

- Important lifecycle state can be reconstructed only from graph events.
- No independent task, approval, or outcome state remains in a surface.

## Milestone 2 — Intent governance

### Deliverables

- Support micro, standard, and strategic Intent Contracts.
- Implement intent challenge for medium/high/critical risk, assessing evidence, alternatives, assumptions, scope, downside, and measurability.
- Separate intent completeness, evidence quality, decision confidence, and strategic approval.
- Record decision owners, required approvers, kill criteria, review dates, and outcome plans.
- Implement CLI and Control Plane intent/challenge workflows.

### Exit gate

- Every non-emergency change has a traceable intent and decision path.

## Milestone 3 — Orchestration and capacity

### Deliverables

- Versioned task DAG decomposition and Task Contracts.
- Explainable priority using value, urgency, impact, confidence, risk, novelty, cost, dependencies, capacity, and historical outcomes.
- Routing based on risk, ambiguity, novelty, reversibility, blast radius, capability, reliability, concurrency, review capacity, and integration capacity.
- Attention-aware human capacity, protected review windows, WIP limits, context switching, and attention debt.
- Cold-start controls for novel work: sandboxing, smaller boundaries, evidence, independent review, feature flags/canaries, rollback plans, and no autonomous release.

### Exit gate

- Every priority and routing decision has stored inputs and an explanation.

## Milestone 4 — Production and assembly

### Deliverables

- Worker registry with identity, capabilities, experience, permission scope, cost, concurrency, reliability, autonomy, and required reviewer.
- Signed Worker Contracts and Receipts with claim status, scope, tests, risks, tools, cost, duration, and provenance.
- Isolated execution cells with reproducibility, permission, network, secret, tool, resource, and cleanup policy.
- Module/file ownership, interface contracts, parallel work, conflict prediction, assembly order, rebases, and contract tests.
- IntegrationCandidate creation for multi-change assembly and full verification after assembly.

### Exit gate

- Workers cannot exceed declared scope, leak secrets, self-verify, self-approve, or bypass assembly controls.

## Milestone 5 — Assurance and release governance

### Deliverables

- Deterministic traceability, scope, receipt, claims, test-integrity, dependency, interface, policy, reproducibility, integration, and release checks.
- Maintain separate typed values:
  - `verificationVerdict`: `PASS | FAIL | UNKNOWN`
  - `reviewDecision`: `NOT_REVIEWED | APPROVE | REQUEST_CHANGES | ESCALATE`
  - `releaseDecision`: `NOT_RELEASED | RELEASE | HOLD | ROLLBACK`
  - `outcomeStatus`: `UNMEASURED | PENDING | POSITIVE | NEUTRAL | NEGATIVE | UNKNOWN`
- Add independent review, approval, waivers with expiry/follow-up debt, release authority, canary/feature-flag gates, and rollback controls.
- Ensure AI is advisory only and cannot alter deterministic evidence, verdicts, severity, waivers, or release decisions.

### Exit gate

- A passing verification never automatically approves or releases a change.

## Milestone 6 — Outcomes and economics

### Deliverables

- Measurement plans, observations, maturity, attribution, cohorts, sample sizes, confidence, confounders, and windows.
- Incident, rollback, defect escape, rework, and quality events.
- Cost ledger for inference, compute, CI, verification, storage, orchestration, human implementation/review, integration, and release work.
- COPQ categories: prevention, appraisal, internal failure, and external failure.
- OEE-style effectiveness and primary metric: cost per accepted, unreverted, outcome-positive change.
- Feed mature outcomes back into prioritization, routing, and autonomy decisions.

### Exit gate

- No positive outcome is recorded before its measurement window is mature.

## Milestone 7 — Provider-neutral integrations

### Deliverables

- Common adapters for GitHub, Slack, Jira, Linear, and generic webhooks.
- Signature validation, identity mapping, ExternalReference creation, idempotency, authorization, rate limits, failure handling, correlation, and Control Plane links.
- Support `@tinkerbot` commands: plan, challenge, status, assign, run, verify, evidence, review, approve, release, explain, why, cost, outcome, pause, and resume.
- Retire standalone GitHub App installation as a primary surface while preserving historical references non-destructively.

### Exit gate

- No adapter maintains parallel factory state.

## Milestone 8 — Surface completion

### Deliverables

- CLI lifecycle commands, local graph inspection, evidence export, cost/outcome reports, diagnostics, and `tb serve`.
- TUI cockpit views: intent queue, task graph, worker lanes, blocked work, attention load, review queue, integration candidates, verification/evidence, approvals/releases, outcomes, COPQ, and OEE.
- Control Plane views: command center, intent/challenge, task graph, workers/capacity, execution, assembly, assurance, review/release, outcomes, economics, autonomy, integrations, audit, and entitlements.
- Accountless local verification and source-private local reports remain supported.

### Exit gate

- Every displayed object is a Factory Graph projection.

## Milestone 9 — Security, migration, and release readiness

### Deliverables

- Tenant isolation, least-privilege integrations, secret redaction, signed receipts, tamper-evident evidence, explicit upload consent, BYOK isolation, and privileged-action audit logs.
- Version definitions-as-code for policies, templates, workers, capabilities, autonomy, integrations, outcome plans, and entitlements.
- Complete migration and backward-compatibility tests.
- Validate end-to-end scenarios:
  - solo micro task;
  - strategic enterprise task;
  - external integration command;
  - novel high-risk task;
  - rollback and mature outcome.
- Run typecheck, unit, integration, migration, end-to-end, security, performance, accessibility, and release smoke suites.

### Release gate

- All required scenarios pass.
- GitHub App installation is not required.
- Factory Graph replay reconstructs lifecycle state.
- Privacy, entitlement, authority, and deterministic-verification invariants are verified.
