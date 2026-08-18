# Five-minute quickstart

## Install

From a Node.js repository with Git history:

```sh
pnpm add -D pr-proof
```

For a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm tui:build
```

## Configure

Create `pr-proof.yml`:

```yaml
version: 1
framework:
  test_runner: vitest
  command: pnpm test --run
coverage_file: coverage/lcov.info
base:
  ref: origin/main
policy:
  pack: default
```

Defaults are advisory. Coverage and mutation evidence are optional and missing evidence becomes visible `UNKNOWN` state.

## Run locally

```sh
tb tui
tb doctor
tb check --base origin/main --head HEAD
tb usage --json
tb policy list
tb baseline init
tb baseline check
```

Inspect exact findings in JSON, Markdown, or SARIF:

```sh
pr-proof check --format json --output .pr-proof/report.json
pr-proof report --input .pr-proof/report.json --format markdown
```

## Add GitHub Actions

Use the example workflow in [`.github/workflows/pr-proof.example.yml`](../.github/workflows/pr-proof.example.yml) with `pull_request`, `persist-credentials: false`, `contents: read`, and only the Check Run/comment permissions you want to grant. The workflow never uses `pull_request_target`; fork runs degrade to local artifacts and annotations.

## Read the result

`PASS` means no actionable finding was produced. `NEEDS_REVIEW` identifies evidence that needs a human review. `UNKNOWN` means an optional or dynamic evidence source was unavailable; it is not a false pass or automatic failure. `FAIL` is reserved for explicitly configured blocking behavior.

Remove the tool by deleting its dependency, configuration, and workflow step. No hosted account is required and no source or full diff is uploaded by default.
