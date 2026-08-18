# Hosted client quickstart

## Install

Install through an authorized release channel. The URLs and registry/tap names below are release-owner inputs; this repository does not publish a public package or installer.

```sh
# Private npm registry
npm install -g @tinkerbot/cli@<version> --registry https://<approved-registry>

# Bun
bun add -g @tinkerbot/cli@<version> --registry https://<approved-registry>

# Homebrew after the approved tap is published
brew install <organization>/tinkerbot/tinkerbot

# Checksum-verifying installer hosted by the approved download service
curl -fsSL https://<approved-download-host>/<version>/install.sh | \
  TINKERBOT_RELEASE_BASE_URL=https://<approved-download-host>/<version> sh
```

For a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm tui:build
```

## Configure

Complete sign-in in the hosted product, then export the resulting terminal session values. `tb login` is reserved but is not implemented in this client build; it must not be used as a release instruction.

```sh
export TINKERBOT_CONTROL_PLANE_URL="https://<approved-control-plane-host>"
export TINKERBOT_SESSION_TOKEN="<session-issued-by-the-hosted-sign-in-flow>"
export TINKERBOT_REPOSITORY="OWNER/REPOSITORY"
tb whoami
tb org list
```

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
tb
tb verify --repository "$TINKERBOT_REPOSITORY"
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

The TUI and hosted `verify` command require a valid hosted session. Local deterministic subcommands remain available for development and CI compatibility, but cannot represent hosted authorization, policy, or accepted assurance state. No source code or full diff is uploaded by the hosted assurance ingestion path.
