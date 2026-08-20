# Test strategy

Tinkerbot uses risk-based tests. The suite is split between pure adapter tests, temporary Git repositories, real CLI subprocesses, an in-memory Worker SQL stub, mocked Playwright control-tower E2E, and small checked-in fixtures. A test is useful only when it asserts semantic output—rule, location, evidence, state, verdict, or exit code—not only a snapshot.

Non-negotiables stay in tests, not docs: `tb check` cannot be upgraded by agents; humans merge; Steward cannot self-approve or auto-merge; missing ingest is UNKNOWN; the example Action workflow never uses `pull_request_target`.

## Risk tiers and targets

| Tier | Packages / boundary | Target | Required evidence |
| --- | --- | ---: | --- |
| Critical | `core`, `git`, `cli`, reporters, Action safety | 90% statements / 85% branches | verdicts, stable report fields, safe argv, cleanup, exit codes, annotation escaping, fork write-disable, OIDC audience `tinkerbot` |
| High | parser, test-integrity, coverage, mutation, impact-analysis, **factory** | 85% statements / 80% branches | routing, autonomy skip rules, cells, skills/evolution, Foreman waits, UNKNOWN ingest, merge readiness |
| Medium | baseline, policy, artifacts, provenance, contracts, fixtures, history, selection, control-plane, assurance, **github**, **hosted-integrations**, **language-core**, **language-validation** | 85% statements / 80% branches | state transitions, adapters, path containment, signature rejection, unavailable syntax tools, provider-unavailable states |
| Low | documentation-only and deferred extension contracts | measured by review | no executable placeholder command is exposed |

Coverage is a ratcheting release gate. The repository pins `@vitest/coverage-v8`, instruments `packages/**/src/**/*.ts`, `apps/control-plane-worker/src/**/*.ts`, and `action/**/*.ts`, emits text, JSON, JSON-summary, and HTML reports, and compares package metrics with [`fixtures/coverage-baseline.json`](../fixtures/coverage-baseline.json). Global statements, functions, and lines must remain at or above **94%**. That 94% bar is the official release promise; do not document 98% while Vitest measures ~94%. Long-term branch targets that remain open are warnings, not ratchet failures. Action runtime lives in `action/run.ts` so tests can import it without loading the `action/index.js` GitHub loader stub.

## Test layers

- Unit/branch tests cover normalization, fingerprints, configuration precedence, verdict aggregation, report escaping, artifact parsing, policy matching, state machines, language detection, parser dispatch, language-specific coverage formats, and Factory OS routing/autonomy/cells/skills.
- Fixture tests cover every currently implemented test-integrity rule and its safe counterpart under `fixtures/test-integrity/`.
- Git integration tests create temporary repositories and exercise real revisions, diffs, worktrees, spaces, binary files, and cleanup.
- CLI contract tests invoke the built executable as a subprocess and assert stdout, stderr, exit codes, and repository-local output behavior. Factory OS commands (`tb work take|return`, `tb cell list`, `tb product list`, `tb skill list`, `tb evolution list|approve`, `tb factory validate`) stay in [`tests/factory-cli.test.ts`](../tests/factory-cli.test.ts). Hosted 401 stays UNKNOWN (exit 2). Unknown subcommands exit 3.
- Worker tests use an in-memory SQL stub, not Cloudflare D1. [`tests/factory-worker.test.ts`](../tests/factory-worker.test.ts) covers signed GitHub security alerts, incident/support webhooks, OIDC rejection, cell sweep, take/return decisions, steward self-approve 409, CSRF origin rejection, `runFactoryTurn`, MCP, and queue/scheduled paths. No live Cloudflare, GitHub, Stripe, or WorkOS.
- Action tests combine source contracts ([`tests/action-hardening.test.ts`](../tests/action-hardening.test.ts): never `pull_request_target`, fork writes disabled, OIDC audience `tinkerbot`) with a runtime import of [`action/run.ts`](../action/run.ts) that uses a stub CLI and mocked `fetch`.
- Fault-injection tests use malformed input, missing files, invalid refs, non-zero children, timeouts, corrupt cache entries, unavailable optional evidence, malformed Stripe/WorkOS signatures, and oversized language sources.
- Cross-language fixtures exercise Python imports/decorators/dynamic loading, Go module resolution and test naming, Rust modules/macros, and C/C++ includes/preprocessing uncertainty. Unknown extensions, excluded directories, and an unavailable syntax tool remain `unavailable` or `unknown`, never a silent pass.
- Repeatability tests serialize identical reports more than once and compare bytes. History and outcome records are observational; they cannot change a `tb check` verdict.
- Playwright E2E ([`tests/e2e/control-tower.spec.ts`](../tests/e2e/control-tower.spec.ts)) drives the control-tower SPA against a localhost static server of [`apps/control-plane`](../apps/control-plane) with `page.route` mocks for Worker APIs. Chromium only. It does not boot Wrangler, D1, or Workers AI.

## Commands

```sh
pnpm test          # Vitest only (OS-matrix safe; no browser download)
pnpm test:coverage # Vitest + v8 coverage + scripts/verify-coverage.mjs ratchet
pnpm test:e2e      # playwright install chromium (if needed), then Playwright
pnpm test:all      # Vitest, then E2E
```

Install the Playwright browser once with `npx playwright install chromium` if `pnpm test:e2e` is run without network. The example Action workflow in `.github/workflows/pr-proof.example.yml` is customer-verify, not this repository's unit CI; do not add `pull_request_target`.

## Unknown-state policy

Missing optional evidence, parser diagnostics, unresolved imports, dynamic behavior, stale baselines, malformed artifacts, unavailable mutation engines, and missing Action OIDC ingest remain explicit diagnostics. Advisory policy reports them as `UNKNOWN` evidence without turning them into a false pass. A policy pack may intentionally turn those diagnostics into a blocking finding. No test is silently skipped because evidence is missing.

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

When available, also run `pnpm test:coverage`, `pnpm test:e2e`, `pnpm audit`, and `actionlint`. Record unavailable tools and the replacement checks in [`stability-report.md`](stability-report.md).
