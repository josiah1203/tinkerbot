# Implementation status

> Current product direction: Tinkerbot is a proprietary hosted SaaS whose primary interfaces are the authenticated `tb`/`tinkerbot` OpenTUI client and GitHub App/Action. The web surface is limited to authentication, organization, billing, GitHub connection, and support handoffs.

## Status

The MVP and language-expansion vertical slices are implemented in the standalone TypeScript monorepo. The current local release includes explicit baseline/waiver state, composable policy packs, normalized CI artifacts, test-to-change provenance, fail-closed test-selection recommendations, local history, API Contract Guard, Fixture/Snapshot Integrity, package-safe subprocess/path handling, deterministic report bounds, language-neutral graph/test/coverage support for TypeScript, JavaScript, Python, Go, Rust, C, and C++, the isolated OpenTUI cockpit, and the versioned source-minimized evidence contract. Release readiness remains limited by an authorized live GitHub validation run, platform packaging checks, and normal clean-install validation; no external publish, tag, push, or live provider mutation is performed by this workspace.

## Phase gates

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation, CLI shell, config, Git, schema, JSON, tests, docs | complete |
| 1 | Test integrity, coverage, base/head comparison, terminal/JSON | complete |
| 2 | Targeted mutation adapter, limits, cache, unknown states | complete |
| 3 | AST graph, changed symbols, impact and uncertainty | complete |
| 4 | Tinkerbot Verify Action, Check Run, sticky comment, SARIF, fork fallback | complete |
| 5 | Hardening, security/privacy, large-diff behavior, pilot docs | complete |
| 6 | Baselines, waivers, policy packs, provenance, artifact normalization, selection, history | complete |
| 7 | API Contract Guard and Fixture/Snapshot Integrity | complete |
| 8 | Extension contracts and deferred tool documentation | complete |
| 9 | Language registry, Python/Go/Rust/C/C++ graph adapters, native test conventions, coverage adapters, cross-language fixtures, bounded toolchain validation, and workspace-aware import resolution | complete |
| 10–13 | Hosted provider integration | in progress; live provider configuration and full lifecycle implementation remain release gates |

| Release hardening | Package metadata, report schema, CLI diagnostics, usage, fixtures, runbook, compatibility, SBOM | complete |
| Deep stability | Safe subprocesses, root containment, malformed artifact/history handling, deterministic output, control-plane preview, edge-case fixtures | complete |

The normal local implementation gates pass, including the pinned coverage provider, a 95% global threshold for statements/functions/lines across shipped package sources, and the raised package-level ratchet. The latest historical run reached 96.69% statements/lines, 97.71% functions, and 83.94% branches; every configured package tier met its long-term branch target. Manual validation remains: an authorized GitHub repository must validate native Check Runs, sticky comments, repeated-run idempotency, missing permissions, and fork behavior. Existing hosted control-plane deployment metadata remains compatibility material and is not expanded or required by the current Tinkerbot product boundary. No external publish, tag, push, or unapproved live provider mutation is performed by this workspace.

## Implemented commands

`tui`, `check`, `test-integrity`, `impact`, `report`, `doctor`, `config validate`, `config explain`, `usage`, `baseline init|check|update`, `policy list|explain|simulate`, `artifacts`, `select-tests`, `contracts`, `fixtures`, `history|history compare`, `proof create|verify|replay`, `repo inspect|map`, `change contract validate|assess`, `change assess`, `change-set assess|export`, `release assess|manifest`, `outcome record|export`, `evidence`, and compatibility `serve`.

## Deferred

CI Impact Selector is implemented as the fail-closed `select-tests` recommendation. Fully automated deployment, rollback execution, feature-flag evaluation, observability storage, incident causality, multi-repository merging, generic AI review/autofix, and heuristic AI-authorship detection remain deferred. Hosted assurance routes are contract foundations until deployed D1/R2 resources, membership reconciliation, repository authorization, entitlement reconciliation, retention/deletion validation, and live provider/browser validation are completed.
