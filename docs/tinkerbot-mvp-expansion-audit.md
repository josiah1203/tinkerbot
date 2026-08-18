# Tinkerbot MVP expansion audit

> Historical audit — preserved for the expansion baseline. It is not release guidance; the hosted control-plane ADRs and release documents govern current behavior.

## Current state before this expansion

The repository is a standalone TypeScript monorepo. The existing local-first pipeline already includes:

- a `tb`/`tinkerbot`/`pr-proof` CLI with deterministic report schema v1;
- Git revision and normalized diff adapters;
- parser-backed impact analysis for TypeScript, JavaScript, Python, Go, Rust, C, and C++;
- test-integrity, coverage, mutation, fixture, contract, baseline, policy, provenance, selection, artifact, and history modules;
- terminal, JSON, Markdown, SARIF, GitHub Action, and accountless local report surfaces;
- a Cloudflare Worker foundation with provider adapters for hosted authentication, billing, tenancy, and entitlements.

There is no `progress.md` in the repository at the time of this audit. The initial verification run completed successfully: 20 test files and 73 tests passed.

## Additive implementation map

The expansion adds a bounded `packages/assurance` domain layer. It owns versioned, vendor-neutral objects and deterministic operations while reusing the existing Git, parser, impact, policy, baseline, and report contracts.

| Capability | Existing source of evidence | Additive expansion |
| --- | --- | --- |
| Change Assurance Record | report, Git context, findings, policy, baseline | durable lifecycle record with stable object IDs and explicit unknowns |
| Verification receipt | finalized report and artifact metadata | deterministic, hash-addressed receipt, integrity/applicability checks, replay requirements |
| Verification graph | parser and impact paths | bounded typed snapshot with stable nodes/edges and partial/unknown states |
| Behavioral coverage | changed-line coverage, provenance, impact paths | dimensioned coverage independent of line coverage |
| Change contract | existing contract analyzer and repository files | `.tinkerbot/change-contract.yml` evaluator and scope-drift findings |
| Finding lifecycle | baseline and history | append-only transitions with freshness invalidation reasons |
| Agent governance | policy packs and explicit metadata | agent execution receipt and admission evaluation; no authorship heuristics |
| Cross-repository changes | contract and package metadata | bounded Change Set assessment with UNKNOWN relationships |
| Release safety | receipts, contracts, change sets | importable release manifest and advisory assessment |
| Runtime outcomes | hosted adapter boundary | observed/imported/confirmed/inferred outcome records; no causal claims |

## CLI and evidence plan

The existing commands and report formats remain unchanged. New commands are additive:

`proof create|verify|replay`, `repo inspect|map`, `impact`, `change contract validate|assess`, `change assess`, `policy simulate`, `change-set assess|export`, `release assess|manifest`, and `outcome record|export`.

The new operations use JSON as the portable interchange format. `review-context` remains consumable without the hosted control plane, and receipt verification never recalculates or upgrades the underlying deterministic verdict.

## Hosted and local boundaries

- Local verification, receipt creation, receipt verification, graph construction, contract assessment, and report viewing remain accountless.
- Hosted views continue to be server-authorized, repository-scoped, and entitlement-controlled. Provider adapters remain optional and tests do not require production credentials.
- Raw source, full diffs, secrets, and customer API keys are not required by the new contracts. Receipts contain hashes and structured metadata by default.
- Feature flags, deployments, rollbacks, canaries, telemetry, incidents, and external scanners are advisory adapter inputs only.

## Known limits and release boundaries

The MVP expansion deliberately does not implement deployment orchestration, automatic rollback, feature-flag evaluation, observability storage, incident causality, multi-repository merging, a replacement issue/PR system, generic AI review/autofix, or AI-authorship inference. Graphs can be partial; runtime-unresolved paths remain UNKNOWN. Hosted provider integration remains a foundation until live credentials, deployment, authorization, retention, and browser validation are performed.

## Validation plan

The expansion is validated with deterministic unit and integration tests covering canonical serialization, stable IDs, receipt tampering/applicability/staleness, replay requirements, graph limits/cycles/duplicate edges, coverage states, contract drift, lifecycle ordering and freshness, explicit agent provenance, Change Set and release UNKNOWN states, outcome association semantics, schema fixtures, security redaction, and CLI round trips. Existing tests and release gates remain part of the final run.
