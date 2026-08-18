# Roadmap

## Available in the current release

- Test-integrity analysis with base/head non-vacuity checks, coverage, and optional targeted mutation evidence.
- TypeScript/JavaScript, Python, Go, Rust, C, and C++ impact analysis with explicit unresolved runtime, macro, and preprocessing paths.
- Bounded read-only toolchain validation plus workspace-aware import resolution for TypeScript aliases, Python `src/` layouts, nested Go modules, Rust crates, and C/C++ compile databases.
- Stable report schema and terminal, JSON, Markdown, and SARIF output.
- Baselines, narrow waivers, stale-state detection, and explicit `new`, `existing`, `resolved`, `unknown`, `waived`, and `expired` states.
- Policy packs, normalized CI artifact parsing, test-to-change provenance, fail-closed test selection recommendations, local JSONL history, API Contract Guard, and Fixture/Snapshot Integrity.
- Fork-safe `pull_request` Action behavior with local reports and best-effort GitHub publishing.

## Next implementation candidates

1. Add runtime test-execution adapters that can associate individual test cases with changed lines without changing the default test runner.
2. Add reliable GraphQL schema parsing when a repository provides an established parser and fixtures.
3. Add bounded cache indexes for contract parses, fixture scans, and provenance evidence with complete revision/config keys.
4. Validate the Action against an authorized GitHub repository, including missing permissions, fork runs, repeated comments, and Check Run updates.

## Intentionally deferred

Scope drift, release safety, agent receipts, context drift, agent collision, flaky-test decisions, and dependency impact have extension contracts under `docs/tools/`. CI Impact Selector is represented by the implemented fail-closed `select-tests` recommendation. The remaining tools do not have public placeholder commands; each needs representative repository fixtures and a deterministic evidence source before implementation.

## Release discipline

A feature is release-ready only when it has a real vertical slice, unit/integration/CLI tests, documented unknown and security behavior, stable report output, bounded execution, and passing `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
