# ADR 0001: Hosted control-plane authority

- Status: Accepted
- Date: 2026-08-18

## Decision

Tinkerbot is a proprietary hosted service. The control plane is authoritative for identity, organization membership, entitlements, policy, repository-scoped assurance state, and acceptance of submitted evidence. The terminal client prepares bounded evidence from a checkout but must authenticate before it retrieves or changes hosted state.

## Consequences

- Hosted `tb` commands and the dashboard require a hosted session. Local `tb check` does not grant hosted authority.
- Evidence ingestion rejects source, full diffs, patches, secrets, and credential-shaped fields.
- Local deterministic commands remain compatibility/development capabilities; they do not grant hosted authority.
- WorkOS, Stripe, Cloudflare bindings, and an authorized deployment are release gates, not values that may be invented in documentation or source.
