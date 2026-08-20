# Usage

## Install and first check

```sh
pnpm add -D pr-proof
pr-proof --version
pr-proof doctor
pr-proof check --base origin/main --head HEAD
tb tui --once
pnpm tui
tb agents
```

`tb tui` is a Claude Code-style kit shell on a TTY (`pnpm tui`). `tb tui --once` is the CI transcript. Nested CLIs use their own OAuth. `select-tests` remains a recommendation; the configured suite is the merge gate.

Local external harness execution is opt-in: `tb run --local --allow-external-harness`. Set `TINKERBOT_RECEIPT_SIGNING_KEY_REF` to an `env:VAR` or `keychain://…` reference if locally emitted receipts need an HMAC integrity record; without it, receipts are explicitly marked unsigned rather than claiming a platform signature.

## Advisory and blocking behavior

```sh
# Advisory is the default.
pr-proof check --base origin/main --head HEAD --policy default

# Explicitly use a stricter pack and blocking mode.
pr-proof check --base origin/main --head HEAD --policy public-api --mode blocking
```

## Baselines and waivers

```sh
pr-proof baseline init
pr-proof baseline check
pr-proof baseline update
```

Baseline updates never happen during a normal check. Keep narrow waivers in `pr-proof.yml`:

```yaml
baseline:
  fail_on_new: true
  waivers:
    - ruleId: fixture.snapshot-churn
      path: tests/approved-migrations/**
      reason: Intentional versioned snapshot migration
      owner: api-team
      createdAt: 2026-08-17T00:00:00Z
      expiresAt: 2026-09-17T00:00:00Z
      issue: ENG-123
```

## Artifacts and adjacent tools

```sh
pr-proof artifacts --input coverage/lcov.info
pr-proof artifacts --input test-results/junit.xml --type junit --format json
pr-proof contracts --base origin/main --head HEAD
pr-proof fixtures --base origin/main --head HEAD
pr-proof select-tests --base origin/main --head HEAD --format json
```

`select-tests` is a recommendation. It never replaces the full suite automatically and falls back to the full suite when dynamic imports, generated code, unresolved aliases, large diffs, or other uncertainty is present.

## History and reports

```sh
pr-proof history
pr-proof history --format json
pr-proof history compare HEAD
pr-proof check --format json --output .pr-proof/report.json
pr-proof report --input .pr-proof/report.json --format markdown
```

History is local JSONL under `.pr-proof/history.jsonl`; it is not telemetry. Reports can be kept as CI artifacts or checked in according to repository policy.

## GitHub Action setup

Use a `pull_request` workflow with `contents: read` and only the Check Run/comment permissions the repository chooses. The complete example is in [`.github/workflows/pr-proof.example.yml`](../.github/workflows/pr-proof.example.yml). Do not use `pull_request_target` for contributor-controlled code.

## Troubleshooting

```sh
pr-proof doctor --base origin/main --head HEAD
pr-proof config validate
pr-proof config explain
pr-proof check --format json --verbose
```

Missing or malformed artifacts, unresolved dynamic behavior, and stale baselines are reported explicitly as diagnostics/`UNKNOWN`; they are not fabricated into a pass. See [`docs/troubleshooting.md`](troubleshooting.md) and [`docs/security.md`](security.md).
