# Tinkerbot privacy

The current product is local-first: `tb`/`tinkerbot`, the OpenTUI cockpit, and customer-owned GitHub Actions are authoritative. Older hosted control-plane references in this document are compatibility notes, not a new web dashboard or required service.

pr-proof remains local-first. The hosted control plane manages organization and verification metadata; it is not a source mirror.

- Source code stays in the customer runner by default.
- Full diffs are not uploaded or stored by default.
- Structured report metadata is minimized and retention is configurable.
- Repository names, paths, rule IDs, and finding text may still be sensitive.
- Users can delete synchronized metadata through a server-authorized operation.
- No mandatory LLM and no unrelated telemetry.
- Provider secrets are read from Cloudflare Worker bindings or an account-level Secrets Store; they are not stored in logs, client bundles, reports, or billing UI. WorkOS access/refresh tokens are encrypted before D1 session persistence.
- Payment-card details remain with the billing provider.
- Authorization, entitlements, repository access, and audit visibility are server-side decisions.

The local report viewer binds to `127.0.0.1` by default and does not require a hosted login. Its purpose is to render the same structured report contract produced by the CLI and GitHub Action.

## Change assurance data

`tb` verification, receipt creation, receipt verification, replay preflight, graph construction, contract assessment, and the local viewer do not require an account or hosted access. Receipts contain hashes, revisions, tool/configuration metadata, evidence references, explicit unknowns, and provenance—not source code or full diffs by default.

Hosted ingestion is opt-in and stores structured assurance metadata only. Feature flags, deployments, telemetry, incidents, and external reviewer records are adapter inputs; they are not silently collected or fabricated. External explanations are advisory and cannot alter authoritative findings or verdicts. Commands and invocation metadata are redacted before serialization.
