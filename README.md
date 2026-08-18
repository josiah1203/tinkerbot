# Tinkerbot

Tinkerbot (formerly PR Proof) is a local-first developer cockpit for proving that a change is safe and that its tests meaningfully protect the behavior. The short CLI is `tb`; `tinkerbot` and the legacy `pr-proof` entrypoint remain compatible aliases. Static graph support covers TypeScript, JavaScript, Python, Go, Rust, C, and C++.

It combines deliberately bounded verification modules:

- **Proof-of-Test** finds weakened or vacuous tests, reads changed-line coverage, and can compare a new test on the base and head revisions.
- **Change Impact Proof** builds a static import/export and symbol graph, follows limited-depth downstream impact, and reports paths that remain unverified.
- **Baselines and policy packs** classify new/existing/resolved findings, support narrow expiring waivers, and explain advisory or explicitly blocking decisions.
- **CI evidence and provenance** normalize common coverage/test/mutation/SARIF artifacts and label test-to-change relationships by evidence strength.
- **Adjacent guards** provide API contract comparison, fixture/snapshot integrity, local verification history, and fail-closed test-selection recommendations.

The tool runs in the customer’s repository, does not upload source code or full diffs by default, and does not require an account, hosted access, or an LLM.

It is an advisory, MIT-licensed CLI/TUI/Action. The TUI is a thin OpenTUI client over the canonical local engine; GitHub is an additive assurance surface, not a replacement review client. `tb serve` remains only as the existing compatibility/local-report surface; this direction does not introduce a full web dashboard or self-hosted web control plane.

## Quick start

```sh
pnpm install
pnpm build
pnpm tui:build
pnpm tui:compile       # optional host executable; set TINKERBOT_TUI_TARGET for a cross-target
tb --version                 # `pr-proof` and `tinkerbot` remain supported aliases
tb tui                      # accountless local OpenTUI cockpit
tb doctor
tb check --base origin/main --head HEAD
tb usage --format json
tb policy list
tb select-tests --base origin/main --head HEAD
tb serve --port 4173
```

From npm/pnpm, install the published package as a development dependency with `pnpm add -D pr-proof`. From this source checkout, use the local `pnpm build` first. A five-minute setup is documented in [`docs/quickstart.md`](./docs/quickstart.md).

Use `pr-proof.yml` to configure the runner, coverage artifact, mutation limits, output, baselines, fixtures, selection, and policy. Safe defaults are advisory. Blocking is opt-in with `test_integrity.mode: blocking`, a stricter policy pack, or `baseline.fail_on_new: true`.

The local cockpit is `tb tui`: a two-pane grouped Work view with repository/worktree context, local diff, evidence trace, run/cancel/rerun, policy inspection, history, filtering, command mode, and source-minimized exports. The additive change-assurance CLI surfaces remain local-first and source-minimized: `tb proof create|verify|replay`, `tb repo inspect|map`, `tb change contract validate|assess`, `tb change-set assess`, `tb release assess`, `tb outcome record|export`, and `tb evidence --format review-context|change-assurance`. Receipts, graph snapshots, behavioral coverage, lifecycle events, contracts, release manifests, and outcomes are explicit evidence objects; absent or stale evidence remains UNKNOWN. See [`docs/change-assurance.md`](./docs/change-assurance.md), [`docs/tui-architecture.md`](./docs/tui-architecture.md), and [`docs/evidence-schema.json`](./docs/evidence-schema.json).

Tinkerbot configuration may also live at `.tinkerbot/config.yml` (preferred), `.tinkerbot/tinkerbot.yml`, or `.pr-proof/config.yml`; legacy root `pr-proof.yml` remains supported. No hosted account or cloud provider is required for local use.

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
