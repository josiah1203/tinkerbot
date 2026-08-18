# Test strategy

PR Proof uses risk-based tests. The suite is intentionally split between pure adapter tests, temporary Git repositories, real CLI subprocesses, and small checked-in fixtures. A test is useful only when it asserts semantic output—rule, location, evidence, state, verdict, or exit code—not only a snapshot.

## Risk tiers and targets

| Tier | Packages / boundary | Target | Required evidence |
| --- | --- | ---: | --- |
| Critical | `core`, `git`, `cli`, reporters, Action safety | 90% statements / 85% branches | verdicts, stable report fields, safe argv, cleanup, exit codes, annotation escaping |
| High | parser, test-integrity, coverage, mutation, impact-analysis | 85% statements / 80% branches | positive/negative rules, uncertainty, timeouts, malformed input, bounded traversal |
| Medium | baseline, policy, artifacts, provenance, contracts, fixtures, history, selection, control-plane | 85% statements / 80% branches | state transitions, adapters, path containment, deterministic selection/history, provider-unavailable states |
| Low | documentation-only and deferred extension contracts | measured by review | no executable placeholder command is exposed |

Coverage is a ratcheting release gate. The repository pins `@vitest/coverage-v8`, measures shipped TypeScript package sources, emits text, JSON, JSON-summary, and HTML reports, and compares package metrics with [`fixtures/coverage-baseline.json`](../fixtures/coverage-baseline.json). Global statements, functions, and lines must remain at or above 95%, and a package regression beyond the documented tolerance fails. The latest suite reaches 96.69% statements/lines, 97.71% functions, and 83.94% branches overall; all configured critical, high, and medium package targets are satisfied without warnings.

## Test layers

- Unit/branch tests cover normalization, fingerprints, configuration precedence, verdict aggregation, report escaping, artifact parsing, policy matching, state machines, language detection, parser dispatch, and language-specific coverage formats.
- Fixture tests cover every currently implemented test-integrity rule and its safe counterpart under `fixtures/test-integrity/`.
- Git integration tests create temporary repositories and exercise real revisions, diffs, worktrees, spaces, binary files, and cleanup.
- CLI contract tests invoke the built executable as a subprocess and assert stdout, stderr, exit codes, and repository-local output behavior.
- Fault-injection tests use malformed input, missing files, invalid refs, non-zero children, timeouts, corrupt cache entries, and unavailable optional evidence.
- Cross-language fixtures exercise Python imports/decorators/dynamic loading, Go module resolution and test naming, Rust modules/macros, and C/C++ includes/preprocessing uncertainty.
- Repeatability tests serialize identical reports more than once and compare bytes. History is checked to remain observational; it cannot change a verdict.

## Unknown-state policy

Missing optional evidence, parser diagnostics, unresolved imports, dynamic behavior, stale baselines, malformed artifacts, and unavailable mutation engines remain explicit diagnostics. Advisory policy reports them as `UNKNOWN` evidence without turning them into a false pass. A policy pack may intentionally turn those diagnostics into a blocking finding. No test is silently skipped because evidence is missing.

## Regression procedure

Run, in order:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
  npm pack --dry-run
```

When available, also run `pnpm test -- --coverage`, `pnpm audit`, and `actionlint`. Record unavailable tools and the replacement checks in [`stability-report.md`](stability-report.md).
