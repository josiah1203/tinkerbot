# Changelog

All notable changes to `pr-proof` are documented here.

## [0.1.0] - 2026-08-17

### Added

- Local-first CLI for test-integrity and bounded impact analysis.
- TypeScript/JavaScript AST graph with import, export, route, package, and dynamic-reference evidence.
- Assertion weakening, disabled-test, mock, error-path, tolerance, coverage, and base/head non-vacuity checks.
- LCOV and Istanbul coverage readers.
- Bounded StrykerJS adapter with cache and explicit mutation states.
- Terminal, JSON, Markdown, and SARIF reporters with report schema v1 metadata.
- `pr-proof --version`, `doctor`, `config validate`, `config explain`, and `usage` commands.
- Explicit baseline initialization/check/update with stable fingerprints, stale detection, resolved states, narrow ownership/expiry waivers, and local history.
- Seven policy packs with report rationale and explicit unknown handling.
- Normalized LCOV, Istanbul, JUnit, Jest/Vitest, Stryker, SARIF, and generic JSON artifact adapters.
- Evidence-ranked test-to-change provenance and fail-closed `select-tests` recommendations.
- `contracts` API Contract Guard for OpenAPI/Swagger operations and TypeScript exports.
- `fixtures` Fixture/Snapshot Integrity checks for churn, deletion, expected-error coverage, and assertion specificity.
- Extension architecture and deferred tool contracts for scope, release, receipt, context, collision, flaky-test, and dependency modules.
- Bounded read-only Python, Go, Rust, C, and C++ front-end validation with explicit valid, invalid, uncertain, and unavailable states.
- Workspace-aware static resolution for TypeScript `paths`, Python `src/` layouts, nested Go modules, Rust workspace crates, and C/C++ `compile_commands.json` include paths.
- GitHub Action metadata with safe pull-request workflow guidance, annotations, Check Runs, sticky comments, and fork fallback.
- Fixtures, release runbook, compatibility, security, troubleshooting, dependency, and pilot documentation.

### Limitations

- Live GitHub API validation is pending until an authorized repository and credentials are available.
- Dynamic, reflective, generated, and metadata-free alias behavior is explicitly partial or unknown; validation still does not execute repository code.
- Mutation execution requires StrykerJS or a compatible adapter.
