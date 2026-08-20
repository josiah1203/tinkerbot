# Tinkerbot documentation

This directory distinguishes the current hosted-product contract from historical implementation and UX audits.

## Current release documents

- [Quickstart](./quickstart.md): authenticated terminal setup and verification.
- [Factories](./factories.md): Foreman loop, `v1alpha1` definitions, automations, and the factory dashboard.
- [CLI contract](./cli-contract.md): hosted and local `tb` commands. `tb tui` is the terminal session; `tb dashboard` opens `/app`.
- [TUI session](./tui.md) and [TUI architecture](./tui-architecture.md): master tabs, nested CLIs, Node `--once`.
- [GitHub Action](./github-action.md) and [`github-app/README.md`](../github-app/README.md): the PR-visible integration boundary.
- [Billing](./billing.md), [authentication](./authentication.md), [security](./security.md), and [Cloudflare runtime](./cloudflare.md): hosted control-plane contracts.
- [Distribution](./distribution.md): Bun, npm, Homebrew, and curl release artifacts.
- [Release runbook](./release-runbook.md), [release readiness](./release-readiness.md), and [hosted provisioning](./hosted-provisioning.md): authorized-release gates and operator checklist.
- [ADRs](./adr/README.md): binding architecture decisions.

## Historical records

`*-audit.md`, `synara-audit/`, `frontend-ux-audit.md`, `design-migration-map.md`, `migration.md`, and `implementation-status.md` are dated records. They may describe an earlier local preview or accountless prototype and are not release instructions. Where they conflict with the current documents above, the current hosted contract and ADRs govern.
