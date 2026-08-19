# Tinkerbot executive summary

## Decision summary

Tinkerbot is a Cloudflare-hosted software production operating system. The control plane orchestrates products, production lines, work cells, work orders, specialist agents, evidence, releases, outcomes, and governed factory evolution. Deterministic `tb check` remains the final authority for verification verdicts. Agents cannot write verdicts, delete evidence, merge, or run shell or network from the Worker except through Sandbox allowlists.

The source tree implements the factory OS vertical. It is **not a production release** until Cloudflare, WorkOS, Stripe, GitHub App, and signing identities are provisioned and live-validated.

## Product and repository scope

Tinkerbot turns software intent into verified, traceable, releasable changes. Evidence is source-minimized: reports, findings, receipts, and explicit unknowns. The product is advisory on merge; it does not own GitHub merge or customer-cluster deploy.

| Surface | Role | Current state |
| --- | --- | --- |
| Core engine | Local `tb check` verification | Implemented; remains verdict authority. |
| CLI (`tb`) | Login, factory/work/cell/skill/evolution inspect, local check, TTY master | Implemented; `tb` with no args prints help. `tb tui` is a tabbed master (`--once` for CI). `tb dashboard` opens `/app`. |
| Dashboard | Exception-first control tower at `/app` | Worker APIs and SPA shell; live data requires a deployed control plane. |
| GitHub Action | Customer-runner execution + OIDC ingest | Implemented; App publishes Checks when configured. |
| GitHub App | Inline comments and Check Runs | Publisher in source; production App registration remains external. |
| Cloudflare Worker | Auth, D1 factory OS tables, queue/workflow, R2, billing | Implemented in source; Queue/R2/AI/Workflow/Sandbox bindings need account provisioning. |
| Billing | Seat-based Stripe ($20/$40/$60), not tokens or runs | Catalog and ledger in source; live Price IDs remain external. |

The interactive terminal is `tb tui` (tabbed master on a TTY; Node `--once` for CI). The browser control tower remains `tb dashboard`.

## What is implemented

- Factory-as-code (`.tinkerbot/` tree: factory, product, lines, skills, autonomy, evolution) hashed as a versioned definition.
- Work orders with production-line routing, work-cell leases, risk-based autonomy, and append-only state.
- Webhook admission → queue → specialist stages. Implementation runs in Cloudflare Sandbox on `tinkerbot/*`. Verification waits for Action OIDC ingest of `tb check`.
- Release candidates, GitHub Environment dispatch records, rollback work orders, and outcome ingest. Tinkerbot does not kubectl into customer clusters.
- Factory Steward proposals that cannot auto-merge or rewrite verdicts.
- PKCE WorkOS auth, CSRF, session expiry, public site vs `/app`.
- Seat billing without private-repository or member caps; usage events for budgets/fair use only.

## Remaining release gates

These are operational, not missing product definition:

1. Deploy production Worker with D1, R2, Queue, Workflow, Workers AI, Sandbox, Vectorize, Browser Rendering, and secrets.
2. Register the GitHub App against Worker webhook/callback URLs and install it in a test organization.
3. Confirm Stripe Price IDs and WorkOS organization mapping.
4. Sign release artifacts in CI.
