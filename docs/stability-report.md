# Stability report

## Current local result

This report is generated from the latest local verification run and must be updated when the release gates change.

| Measure | Result |
| --- | --- |
| Test files | 25 (including coverage-target, coverage-depth, control-plane, assurance, TUI model, hardening, and language-support suites) |
| Tests | 134 |
| Package distribution | `core`, `language-core`, `git`, `parser`, `test-integrity`, `coverage`, `mutation`, `impact-analysis`, `reporters`, `baseline`, `policy`, `artifacts`, `provenance`, `selection`, `history`, `contracts`, `fixtures`, `control-plane`, `cli` |
| Statement / branch / function / line coverage | Latest shipped-package run with pinned `@vitest/coverage-v8`: 96.69% / 83.94% / 97.71% / 96.69% overall |
| Coverage thresholds | Global statements, functions, and lines must remain at or above 95%; the raised package ratchet passes and every configured package tier meets its branch target |
| Checked-in edge-case fixture roots | Existing test-integrity, impact, mutation, and multi-language fixture roots under `fixtures/` |
| Property/fuzz tests | 0 dedicated generator-based tests; deterministic malformed-input/property-like regressions are present and a generator dependency is intentionally deferred |
| Repeated-run result | Real Git integration report serialized identically on repeated runs; hardening report order/fingerprint test also passes |
| Package smoke test | Build, pack dry-run, and executable smoke test are rerun after the final build; packed control-plane assets are included |
| Action validation | Static workflow/action tests pass; live GitHub API, fork, permission, retry, and idempotency validation remains manual |
| Known flaky tests | None observed; no test is marked flaky |

## Verification gates

The final run must record the exit status of `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`, and `npm pack --dry-run` (this pnpm version does not support a `pnpm pack --dry-run` flag). `pnpm audit` is network-dependent. `actionlint` is an optional external binary and is recorded as unavailable when not installed.

## Remaining unknowns and manual checks

- Runtime registration, reflection, dynamic imports, generated code, metadata-free aliases, and missing coverage remain explicit unknown evidence.
- A real GitHub repository is still required to validate Check Run permissions, sticky-comment updates, repeated-run idempotency, fork pull requests, API timeouts, and local-report fallback.
- Package installation must be repeated from a clean directory after the final tarball is produced. The attempted isolated-cache npm install hung without registry progress in this restricted environment; direct tarball extraction and executable/export checks passed.
- Preserve the completed package targets and continue adding focused branch cases with each new adapter path. The provider is pinned, the current gains are checked in as the ratchet floor, and `coverage/coverage-summary.json` is generated deterministically.

No live API result, publication, tag, push, or source upload is inferred from local tests; the coverage percentages above are local instrumentation measurements, not a release approval.
