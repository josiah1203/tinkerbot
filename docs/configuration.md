# Configuration

The default file is `pr-proof.yml` at the repository root. JSON is also accepted. Unknown fields are preserved for forward compatibility, while missing fields use safe advisory defaults.

```yaml
version: 1
framework:
  test_runner: vitest
  command: pnpm test --run
  coverage_file: coverage/lcov.info
languages:
  mode: auto
  include: [typescript, javascript, python, go, rust, c, cpp]
  exclude: []
base:
  ref: origin/main
test_integrity:
  mode: advisory
  require_new_tests_fail_on_base: false
  run_base_tests: true
  mutation_testing:
    enabled: false
    max_mutants: 20
    changed_lines_only: true
    timeout_seconds: 120
  ignores:
    - rule: TEST_ASSERTION_REMOVED
      path: tests/fixtures/**
      reason: fixture intentionally demonstrates failure behavior
impact:
  max_dependency_depth: 2
  include_tests: true
  include_public_exports: true
  include_routes: true
  fail_on: [critical_unverified_impact]
output:
  check_run: true
  sticky_comment: true
  sarif: true
  annotations: true
  fail_on_unknown: false
limits:
  max_changed_files: 500
  max_changed_lines: 10000
  max_files_analyzed: 5000
  max_symbols_analyzed: 50000
  max_findings: 200
  analysis_timeout_seconds: 120
validation:
  strict: false
  allow_shell_commands: false
  toolchain_checks: true
baseline:
  path: .pr-proof/baseline.json
  enabled: true
  fail_on_new: false
  waivers: []
fixtures:
  enabled: true
  max_snapshot_lines: 200
  approved_paths: []
  generated_paths: []
  require_acknowledgement: false
selection:
  confidence_threshold: medium
  full_suite_on_unknown: true
policy:
  pack: default
```

Commands from configuration execute only when the user explicitly enables base/head test comparison. In GitHub Actions they run on the unprivileged `pull_request` runner and never receive privileged secrets. Baseline updates are never implicit; use `pr-proof baseline init` or `pr-proof baseline update`.

`languages.mode: auto` analyzes every recognized source extension unless it appears in `exclude`. Set `mode: explicit` and list only the languages that the repository owns when a monorepo needs a narrower graph. The parser records language-specific unknowns for Python dynamic imports, Go build directives, Rust macros/derives, and C/C++ preprocessing. Configure the existing repository test command and coverage artifact for the selected ecosystem; PR Proof does not install or invent a test runner.

Baseline waivers require a rule, reason, owner, and creation date. Prefer a fingerprint or constrained repository-relative path and set an expiry. Blanket waivers are not accepted by the configuration schema.

Use `pr-proof config validate` to validate the file and `pr-proof config explain` to print the effective configuration after defaults. Strict mode rejects unknown keys. Unsafe shell syntax and mutation limits above safe maximums are rejected unless explicitly reviewed and enabled.

`validation.toolchain_checks` enables bounded, read-only syntax/front-end checks for Python, Go, Rust, C, and C++ files when the corresponding validator is installed. These checks do not run repository code, tests, builds, or package scripts. A missing validator is reported as unavailable rather than treated as a parser failure; validation is capped at 250 files per graph.

Exit codes are stable: `0` PASS, `1` FAIL or blocking NEEDS_REVIEW, `2` UNKNOWN when `output.fail_on_unknown` is enabled, `3` configuration error, `4` execution error, and `5` internal error.
