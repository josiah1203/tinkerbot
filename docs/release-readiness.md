# Release readiness

## Final status

| Field | Value |
| --- | --- |
| Release status | `READY_WITH_LIMITATIONS` |
| Version | `0.1.0` |
| Source commit | unavailable in the current no-commit workspace |
| CLI package status | installable after build; package metadata and bin are configured |
| GitHub Action status | metadata, local reports, annotations, Check Run/comment adapters implemented |
| Local verification | lint, typecheck, test (25 files / 134 tests), build, diff check, 95% global coverage gate, and package coverage ratchet pass with all configured branch targets satisfied |
| Package verification | `pnpm pack` to `/tmp` and `npm pack --dry-run` passed; packed CLI, Action wrapper, and bundled control-plane assets smoke-tested after final build. Clean dependency installation was blocked by registry/cache environment |
| Live GitHub verification | pending; no credentials or authorized test repository were available |
| Default policy | advisory |
| Source upload | disabled by design |

## Capability audit

| Capability | Status | Evidence / limitation |
| --- | --- | --- |
| CLI `check` | implemented, tested | Real base/head Git integration fixture |
| CLI `test-integrity` | implemented, tested | Rule and integration fixtures |
| CLI `impact` | implemented, tested | AST and real Git fixture |
| CLI `report` | implemented, tested | JSON, Markdown, SARIF render tests |
| `pr-proof --version` | implemented, tested | Reports version, commit, runtime, platform, capabilities |
| `pr-proof doctor` | implemented, tested | Local repository/environment diagnostics |
| `pr-proof config validate` | implemented, tested | Default and strict validation |
| `pr-proof config explain` | implemented, tested | Effective merged configuration |
| `pr-proof usage` | implemented, tested | Local `.pr-proof/usage.json`, no telemetry |
| `pr-proof baseline init/check/update` | implemented, tested | Explicit checked-in state; stale and waiver states are visible |
| `pr-proof policy list/explain` | implemented, tested | Seven deterministic policy packs; default remains advisory |
| `pr-proof artifacts` | implemented, tested | LCOV, Istanbul, coverage.py, Go coverprofile, gcov, LLVM, JUnit, Jest/Vitest, Stryker, SARIF, generic JSON |
| `pr-proof select-tests` | implemented, tested | Recommendation only; full-suite fallback on uncertainty |
| `pr-proof history` | implemented, tested | Local `.pr-proof/history.jsonl`, no telemetry |
| `pr-proof contracts` | implemented, tested | OpenAPI/Swagger operations and language-neutral source export comparison |
| `pr-proof fixtures` | implemented, tested | Snapshot/fixture churn, deletion, expected-error, and specificity checks |
| Test weakening rules | implemented, tested | Conservative rule matching |
| Base/head non-vacuity | implemented, adapter-dependent | Requires a runnable repository test command |
| LCOV/Istanbul coverage | implemented, tested | Requires generated coverage artifacts |
| Targeted Stryker | implemented, adapter-dependent | Requires StrykerJS or supplied result adapter |
| AST/line-oriented impact graph | implemented, tested | TypeScript/JavaScript compiler graph plus bounded Python/Go/Rust/C/C++ adapters; dynamic/preprocessor behavior remains explicit UNKNOWN |
| Language registry and selection | implemented, tested | Auto/explicit selection, test conventions, capability summaries, and cross-language fixtures |
| Dynamic/runtime analysis | unavailable | Explicitly reported as `UNKNOWN` |
| Large-diff fallback | implemented, tested | Bounded analysis and visible limitation |
| Terminal/JSON/Markdown/SARIF | implemented, tested | Versioned report metadata |
| GitHub annotations | implemented, partially tested | Local command mapping tested; live runner pending |
| GitHub Check Runs | implemented, adapter-dependent | Requires GitHub token and `checks: write` |
| Sticky comments | implemented, adapter-dependent | Marker-based update; live permissions pending |
| Fork fallback | implemented, partially tested | Local no-token path; live fork pending |
| Hosted Worker runtime | staging deployed with provider prerequisites | WorkOS sessions, signed membership/invitation-event provisioning, current-user reconciliation, cursor-based Events API replay, D1 membership/role/feature/seat authorization, entitlement snapshots, invitation routes/UI seam, and Stripe billing routes are implemented; staging D1 is migrated and scheduled, while R2 enablement, webhook registration, rotated secrets, Stripe catalog, and live provider validation remain |
| Cloudflare secret workflow | implemented, not remotely applied | Wrangler config, required secrets, interactive bootstrap script, and Secrets Store guidance are present; no remote secret mutation was performed |
| npm package publication | prepared, not published | Publishing intentionally not performed |
| Action release tag | prepared, not published | Requires an actual repository and release commit |
| Mandatory telemetry | unavailable by design | Usage remains local/CI-visible |
| Security contact/support policy | implemented with release-owner placeholders | Canonical repository URLs/contact must be configured before publication |

## Open operational tasks

- Run the live GitHub validation matrix in an authorized repository: Vitest, Jest, private/public, fork, no coverage, mutation timeout, large diff, dynamic import, and repeated sticky-comment update.
- Enable R2 in the Cloudflare account, create/bind the approved evidence bucket, and apply its retention/deletion policy.
- Seed rotated WorkOS/Stripe/SESSION secrets, register the WorkOS webhook, configure the server-owned Stripe plan catalog, enable the seven-day Events API replay, and run staging smoke tests.
- Execute live WorkOS/Stripe validation and verify reconciliation before exposing hosted administrative actions to the browser preview.
- Configure the canonical repository owner/name, security contact, support URL, and release commit before publishing.
- Create and push the immutable `v0.1.0` and `v1` Action tags only after review.

No live result is fabricated here; these are operational prerequisites for moving from `READY_WITH_LIMITATIONS` to `READY`.

## Release handoff

- **Release:** `READY_WITH_LIMITATIONS`
- **Version:** `0.1.0` source/package/CLI; Action tag planned as `v0.1.0` with compatibility tag `v1`; report schema `1`.
- **Commit:** unavailable; this workspace has no release commit.
- **CLI package status:** packed, metadata-complete, executable and package entry point smoke-tested from the extracted tarball; clean dependency installation remains environment-blocked.
- **GitHub Action status:** bundled, metadata/workflow validated, local report/annotation/Check Run/comment paths implemented; live permissions pending.
- **Local verification:** 25 suites / 134 tests passed; lint, typecheck, build, hosted/local contract tests, package dry-runs, secret/config checks, 96.69% statement/line coverage, 83.94% branch coverage, and the raised coverage ratchet passed with no package-target warnings.
- **Live GitHub verification:** pending; no authorized repository or credentials were available.
- **Known limitations:** dynamic/runtime consumers, generated code, metadata-free aliases, macro/preprocessor behavior, and unavailable native mutation engines remain partial or `UNKNOWN`; R2 provisioning, rotated live provider credentials, webhook registration, Stripe catalog activation, full historical bootstrap, and live WorkOS/Stripe validation remain unverified.
- **Open operational tasks:** enable/bind R2, seed rotated secrets, register the WorkOS webhook, configure the Stripe plan catalog, enable the selected replay window, execute live provider validation, configure repository identity/security/support contacts, create immutable release tags, and execute the live validation matrix.
- **Rollback procedure:** move the `v1` Action tag to the last known-good immutable commit, pin consumers to the prior package version, and publish a patch release; see [`release-runbook.md`](./release-runbook.md).
