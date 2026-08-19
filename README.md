# Tinkerbot

Tinkerbot is a software production operating system. The Cloudflare control plane orchestrates products, production lines, work cells, work orders, specialist agents, evidence, releases, outcomes, and governed factory evolution. Deterministic `tb check` remains the final authority for verification verdicts. Agents cannot write verdicts, delete evidence, merge, or run shell/network from the Worker except through Sandbox allowlists.

The CLI is `tb` (`tinkerbot` is an identical alias). `pr-proof` remains a deprecated compatibility alias. The hosted UI is an exception-first control tower at `/app`, not a terminal TUI.

## Quick start

```sh
tb login --url https://<control-plane> --token <session>
tb whoami
tb dashboard
tb factory validate
tb check --base origin/main --head HEAD
```

Factory-as-code lives under `.tinkerbot/` (`factory.yaml`, `agents/`, `automations/`, `runners/`, `product.yaml`, `lines/`, `skills/`, `autonomy.yaml`, `evolution.yaml`) and must not contain raw credentials. Specification output uses the existing `.tinkerbot/change-contract.yml` shape.

Install client archives from the authorized download channel. This checkout is for development: `pnpm build` then `pnpm test`. Release artifacts record `"signed": false` until a signing workflow exists. See [`docs/distribution.md`](./docs/distribution.md).

Configure the local engine with `.tinkerbot/config.yml`. Legacy `pr-proof.yml` is compatibility only.

## Tinkerbot Verify GitHub Action

The Action runs on the customer GitHub runner. Prefer GitHub OIDC (`id-token: write`); `session-token` is a deprecated fallback. The GitHub App publishes Check Runs and inline comments. Fork pull requests stay write-disabled. Use `pull_request`, never `pull_request_target`.

See [`action.yml`](./action.yml), [`.github/workflows/pr-proof.example.yml`](./.github/workflows/pr-proof.example.yml), [`docs/github-action.md`](./docs/github-action.md), and [`github-app/manifest.json`](./github-app/manifest.json).

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
