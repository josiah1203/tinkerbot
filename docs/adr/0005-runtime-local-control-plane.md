# Runtime and local control-plane authority

## Status

Accepted

## Context

The factory already models WorkOrders, production lines, autonomy, receipts, and `tb check`. Hosted execution uses Cloudflare, D1, and Workers AI. A one-person laptop path must reuse those contracts instead of introducing a second product or a solo billing tier.

## Decision

Orchestration, runner, inference, identity, and sync are pluggable via `FactoryDefinition.runtime` (`schemaVersion: v1alpha2`). `FactoryStore` is implemented by D1 in the Worker and by the local SQLite-shaped store. Local identity is `organizationId = local` with a single human actor. A one-seat hosted org remains a normal org. Autonomy stays the safety authority; pipeline is workflow shape.

## Consequences

`tb check` remains the only verification verdict. Hosted P0/P1 work (OIDC JWKS, Stripe, Action dist) is independent and does not block the local path.
