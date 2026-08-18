# Hosted assurance control-plane boundary

The paid hosted control plane is the system of record for authorized repository metadata, history, policies, teams, receipts, graph snapshots, contracts, releases, and outcomes. It is not a self-hosted web verifier and does not replace GitHub, deployment systems, feature-flag systems, observability, issue tracking, or security scanners.

The Worker exposes server-authorized assurance metadata routes:

- `GET /assurance/summary?repository=...` returns a repository-scoped assurance bundle or an explicit empty state.
- `POST /assurance/ingest` accepts a versioned, source-minimized assurance bundle for an entitled organization and authorized maintainer-level actor.
- `POST /assurance/delete` removes repository-scoped assurance metadata for an authorized owner/admin and records a deletion audit event.

Free local verification remains free. Hosted assurance entitlement is decided from the server-side tenant entitlement snapshot, never browser state. Missing provider credentials, membership, repository authorization, entitlement, evidence, or runtime adapters are visible as unavailable/unknown states.
