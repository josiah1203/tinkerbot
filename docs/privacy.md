# Tinkerbot privacy

Tinkerbot is a hosted service. The control plane is authoritative for organization membership, entitlements, repository authorization, policies, and accepted evidence; it is not a source mirror.

- Source code stays in the customer runner by default.
- Full diffs are not uploaded or stored by default.
- Structured report metadata is minimized and retention is configurable.
- Repository names, paths, rule IDs, and finding text may still be sensitive.
- Users can delete synchronized metadata through a server-authorized operation.
- No mandatory LLM and no unrelated telemetry.
- Provider secrets are read from Cloudflare Worker bindings or an account-level Secrets Store; they are not stored in logs, client bundles, reports, or billing UI. WorkOS access/refresh tokens are encrypted before D1 session persistence.
- Payment-card details remain with the billing provider.
- Authorization, entitlements, repository access, and audit visibility are server-side decisions.

Release clients require hosted authentication. Legacy local preview tooling is not a production surface.

## Change assurance data

Local analysis may prepare bounded inputs, but hosted verification acceptance and evidence access require an authorized session. Receipts contain hashes, revisions, tool/configuration metadata, evidence references, explicit unknowns, and provenance—not source code or full diffs by default.

Hosted ingestion is opt-in and stores structured assurance metadata only. Feature flags, deployments, telemetry, incidents, and external reviewer records are adapter inputs; they are not silently collected or fabricated. External explanations are advisory and cannot alter authoritative findings or verdicts. Commands and invocation metadata are redacted before serialization.
