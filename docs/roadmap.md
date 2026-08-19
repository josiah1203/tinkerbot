# Roadmap

## Available in the current source tree

- Factory definitions (`.tinkerbot/factory.yaml`), append-only work-order state machine, and `tb factory validate`.
- Cloudflare Worker queue/workflow stages: Foreman, Triage, Specification, GitHub Actions implementation, deterministic verification, Review, Release/approval.
- Dashboard pages for factories, work orders, runs, findings, GitHub, usage, and billing.
- GitHub App publisher (inline comments, Check Runs, dedupe) and Action OIDC run-token exchange.
- Seat-based Stripe catalog ($20 / $40 / $60 per active human seat; annual $200 / $400 / $600) with a Tinkerbot-owned 14-day Team trial and past-due grace. Tokens and runs are usage telemetry, not the billing unit.
- OS matrix CI (`ubuntu-latest`, `macos-latest`, `windows-latest`) with `fail-fast: false`.

## Next

1. Provision production Queue, R2, Workflow, Workers AI, GitHub App keys, and nonempty `STRIPE_PLANS_JSON`.
2. Enable WorkOS event sync and Stripe scheduled reconciliation against live events.
3. Add tag-release signing (checksums, npm provenance, Developer ID, Authenticode, cosign) and only then set `"signed": true`.
4. Optional later: AI Gateway DLP, Sandbox/Containers for hosted implementation.

## Intentionally deferred

Realtime dashboard streaming, autonomous merge, `pull_request_target`, token/run billing, and unrestricted coding agents.
