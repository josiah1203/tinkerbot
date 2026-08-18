# Edge-case matrix

The matrix maps each stability boundary to its fixture or direct regression test. `Unknown` means the tool preserves uncertainty; it is not a successful verification claim.

| Area | Covered scenarios | Expected behavior | Evidence |
| --- | --- | --- | --- |
| Git/worktree | spaces, CRLF, binary, rename, invalid ref, timeout, repeated cleanup | safe argv; binary/status-only files retained; cleanup idempotent; invalid refs are execution errors | `tests/git-coverage.test.ts`, `tests/stability-hardening.test.ts` |
| Parser/graph | JSX/TS syntax diagnostics, dynamic imports, unresolved relative imports, cycles, generated paths | nodes remain present; diagnostics become graph unknowns; traversal terminates | `tests/parser-impact.test.ts`, `tests/stability-hardening.test.ts` |
| Test integrity | removed assertions, matcher weakening, tolerance, disabled tests, todo, mocks, deleted tests, safe refactor | relevant test line and evidence; safe counterpart has no finding | `fixtures/test-integrity/`, `tests/test-integrity.test.ts`, `tests/fixture-rules.test.ts` |
| Coverage | LCOV/Istanbul, CRLF, duplicate records, malformed records, outside paths, missing base artifact | valid records merge; malformed/outside records are unknown; no fabricated coverage | `tests/git-coverage.test.ts`, `tests/stability-hardening.test.ts` |
| Mutation | normalized statuses, supplied result, missing engine, failed command, timeout, cache hit/miss/corruption | surviving mutants are review evidence; failed/unknown execution never becomes pass | `tests/mutation-reporters.test.ts` |
| Impact/selection | downstream paths, dynamic imports, unresolved aliases, large diffs, depth limits | cycles terminate; unknown edges and full-suite fallback remain visible | `tests/parser-impact.test.ts`, `tests/expansion-provenance-selection.test.ts` |
| Baseline/policy/history | new/existing/resolved/waived/expired/stale, rename alias, malformed history, old tool version | explicit state; stale/invalid evidence is unknown; updates are command-only | `tests/expansion-baseline-artifacts.test.ts`, `tests/stability-hardening.test.ts` |
| Artifacts/contracts/fixtures | malformed/missing JSON/XML, SARIF, OpenAPI, export changes, snapshots/fixtures | adapter status is parsed/partial/malformed/missing; safe additive changes remain non-breaking | `tests/expansion-baseline-artifacts.test.ts`, `tests/expansion-contracts-fixtures.test.ts` |
| Reporters | Unicode, pipes, backticks, newlines, missing location, duplicate findings | terminal/Markdown are escaped; JSON/SARIF are valid and deterministic | `tests/mutation-reporters.test.ts`, `tests/stability-hardening.test.ts` |
| CLI/Action | invalid flags, output traversal, no token, fork-safe workflow, annotation injection, timeout | stable exit codes; local report remains useful; workflow commands are escaped | `tests/cli-release.test.ts`, `tests/expansion-cli.test.ts`, `tests/action-hardening.test.ts` |

Known gaps are deliberately listed in [`stability-report.md`](stability-report.md), rather than represented by placeholder-success fixtures.
