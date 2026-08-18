# Tinkerbot

Tinkerbot is a proprietary hosted verification service. Its primary client is the authenticated `tb` terminal UI and CLI; `tinkerbot` is an identical alias. The legacy `pr-proof` entrypoint is retained only as a deprecated compatibility alias.

It combines deliberately bounded verification modules:

- **Proof-of-Test** finds weakened or vacuous tests, reads changed-line coverage, and can compare a new test on the base and head revisions.
- **Change Impact Proof** builds a static import/export and symbol graph, follows limited-depth downstream impact, and reports paths that remain unverified.
- **Baselines and policy packs** classify new/existing/resolved findings, support narrow expiring waivers, and explain advisory or explicitly blocking decisions.
- **CI evidence and provenance** normalize common coverage/test/mutation/SARIF artifacts and label test-to-change relationships by evidence strength.
- **Adjacent guards** provide API contract comparison, fixture/snapshot integrity, local verification history, and fail-closed test-selection recommendations.

The client may inspect a checked-out repository to prepare bounded structured evidence. It does not upload source code or full diffs by default. Hosted authorization, organization membership, entitlements, policy, and accepted evidence are server-authoritative.

Tinkerbot is not an open-source, self-hosted, BYOK, or accountless product. GitHub is the primary pull-request surface through the Tinkerbot GitHub App and Action; the browser is limited to authentication, organization, billing, GitHub connection, legal, and support handoffs.

## Quick start

```sh
tb login
tb whoami
tb                         # authenticated OpenTUI
tb verify
tb evidence
tb github run
```

Install signed Tinkerbot client releases from the authenticated download channel. This source checkout is for authorized development; run `pnpm build` and `pnpm tui:build` before local verification.

Use `pr-proof.yml` to configure the runner, coverage artifact, mutation limits, output, baselines, fixtures, selection, and policy. Safe defaults are advisory. Blocking is opt-in with `test_integrity.mode: blocking`, a stricter policy pack, or `baseline.fail_on_new: true`.

The hosted cockpit is `tb`: a compact OpenTUI view of organization, repository, policy, and structured evidence state. It requires an authenticated control-plane session and never silently treats local reports as hosted authority. Receipts, graph snapshots, behavioral coverage, lifecycle events, contracts, release manifests, and outcomes are explicit evidence objects; absent or stale evidence remains UNKNOWN. See [`docs/tui-architecture.md`](./docs/tui-architecture.md) and [`docs/evidence-schema.json`](./docs/evidence-schema.json).

Tinkerbot configuration belongs at `.tinkerbot/config.yml`. Legacy `pr-proof` configuration is migration-only compatibility and cannot bypass hosted authentication or policy enforcement.

## Tinkerbot Verify GitHub Action

The reusable action is defined in [`action.yml`](./action.yml). A minimal workflow is in [`.github/workflows/pr-proof.example.yml`](./.github/workflows/pr-proof.example.yml). Use `pull_request`, never `pull_request_target`, for untrusted contributor code:

```yaml
name: Tinkerbot Verify
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  tinkerbot-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4.2.2
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4.4.0
        with: { node-version: 22 }
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: pnpm build
      # Replace OWNER/tinkerbot@v1 with the actual released repository.
      - uses: OWNER/tinkerbot@v1
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
```

The action writes a deterministic JSON report, SARIF, receipt, and evidence contract locally, emits bounded deterministic annotations and a step summary, and best-effort updates one canonical `Tinkerbot Verify` Check Run and sticky comment when permissions allow. Fork pull requests are treated as untrusted and write-disabled; no privileged secrets are needed or used. See [`docs/github-action.md`](./docs/github-action.md) and [`github-app/manifest.json`](./github-app/manifest.json).

## Scope and limitations

The implementation supports Git repositories with TypeScript/JavaScript, Python, Go, Rust, C, and C++, while test commands remain repository-controlled (`vitest`, `jest`, `pytest`, `go test`, `cargo test`, `ctest`, or another safe configured command). Bounded read-only toolchain checks and common workspace metadata reduce false unknowns for TypeScript paths, Python `src/` layouts, nested Go modules, Rust crates, and C/C++ compile databases. Static analysis still cannot fully resolve dynamic imports, reflection, macros, conditional compilation, or generated code. These cases are explicitly marked `runtime_unknown` or `UNKNOWN`; they do not fail an advisory check by themselves. See [`docs/limitations.md`](./docs/limitations.md).

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm tui:build
pnpm tui:test
pnpm build
pnpm coverage:check
```

The project is split into adapters under `packages/` so additional parsers, test runners, mutation engines, and reporters can be added without changing the core report contract.

Support and security reporting guidance is in [`docs/support.md`](./docs/support.md) and [`docs/security.md`](./docs/security.md). The pilot release has no hosted support desk or mandatory telemetry.
