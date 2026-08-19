# Implementation status

Tinkerbot is a software production operating system: Cloudflare for auth, state, agents, evidence, and the control tower; GitHub Actions for repository verification; GitHub App for inline publication. The local engine remains the verdict authority.

## Status

Factory OS domain (product, line, cell, work order, spec, release, outcome, skill, improvement proposal), Worker orchestration, PKCE auth, dashboard APIs, Action OIDC exchange, GitHub App publisher, seat billing contracts, CLI factory/work/cell/skill/evolution/receipt commands, and OS-matrix CI workflows are in source. Live Cloudflare queues, R2 buckets, Workers AI, Stripe Price IDs, WorkOS event sync, and GitHub App private keys remain external provisioning.

Release manifests keep `"signed": false` until CI actually signs artifacts.

## Implemented commands

`login`, `logout`, `whoami`, `org list|switch`, `dashboard`, `tui`, `agents`, `factory validate|list|show|sync|mcp|new`, `work list|show|retry|approve|cancel|take|return`, `cell list`, `product list|show`, `skill list|show`, `evolution list|show|approve`, `run show|logs`, `receipt validate`, `verify`, `check`, `test-integrity`, `impact`, `report`, `doctor`, `config validate|explain`, `usage`, `baseline`, `policy`, `artifacts`, `select-tests`, `contracts`, `fixtures`, `history`, `proof`, `repo`, `change`, `change-set`, `release`, `outcome`, `evidence`. `serve` is retired as a product surface (exit 12).

## Out of scope

Autonomous merge, `pull_request_target`, executing deploys on a customer cluster, silently rewriting factory prompts or policies, billing by tokens/runs, and claiming signed releases before signing CI exists.
