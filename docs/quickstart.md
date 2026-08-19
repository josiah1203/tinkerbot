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
```

## Configure

Sign in on the public site, then store a short-lived session:

```sh
tb login --url https://<approved-control-plane-host> --token <session>
tb whoami
tb org list
tb dashboard
```

Create `.tinkerbot/config.yml` (legacy `pr-proof.yml` is compatibility only):

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
tb --help
tb factory validate
tb factory sync
tb verify --repository "$TINKERBOT_REPOSITORY"
```

A factory definition lives in `.tinkerbot/` (`factory.yaml`, `agents/`, `automations/`, `runners/`). See [Factories](./factories.md). Send a narrow first request (one file, one check, open a pull request). The factory hands off at the PR; humans merge. `tb check` on GitHub Actions remains the verdict.

Inspect exact findings in JSON, Markdown, or SARIF:

```sh
tb check --format json --output .pr-proof/report.json
tb report --input .pr-proof/report.json --format markdown
```

## Add GitHub Actions

Use the example workflow in [`.github/workflows/pr-proof.example.yml`](../.github/workflows/pr-proof.example.yml) with `pull_request`, `persist-credentials: false`, `contents: read`, and only the Check Run/comment permissions you want to grant. The workflow never uses `pull_request_target`; fork runs degrade to local artifacts and annotations.

## Read the result

`PASS` means no actionable finding was produced. `NEEDS_REVIEW` identifies evidence that needs a human review. `UNKNOWN` means an optional or dynamic evidence source was unavailable; it is not a false pass or automatic failure. `FAIL` is reserved for explicitly configured blocking behavior.

Hosted commands (`login`, `verify`, `factory`, `work`, `run`, `dashboard`) require a valid hosted session. Local deterministic subcommands remain available for development and CI; they cannot represent hosted authorization, policy, or accepted assurance state. No source code or full diff is uploaded by the hosted assurance ingestion path.
