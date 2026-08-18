# Troubleshooting

## Base or head cannot be resolved

Run `git fetch --no-tags --prune origin '+refs/heads/*:refs/remotes/origin/*'` or pass the exact `--base` and `--head` SHAs. GitHub workflows should use `fetch-depth: 0` and the event’s explicit base/head SHAs.

## No coverage file found

Run Vitest/Jest with coverage enabled and set `framework.coverage_file`. This changes coverage evidence to `UNKNOWN`; it does not fail an advisory check.

## Base test execution is unknown

The configured command could not run in a clean base worktree, timed out, or lacked dependencies. Install dependencies in the repository and verify the command independently. Unknown base execution is intentionally not treated as a failure.

## Mutation testing is unknown

Install StrykerJS or provide a normalized result adapter. Keep `max_mutants` and `timeout_seconds` bounded. A timeout or unavailable engine is never classified as killed or passed.

## Check Run/comment did not appear

Confirm the workflow uses `pull_request`, has `checks: write` and/or `pull-requests: write`, and that the token is available. Fork PRs may be read-only; inspect `.pr-proof/report.json`, annotations, and the step summary instead.

## Configuration failed

Run `pr-proof config validate` and `pr-proof config explain`. Strict mode rejects unknown keys. Unsafe shell syntax requires explicit `validation.allow_shell_commands: true` after review.
