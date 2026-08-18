# Security and privacy

Current product boundary: Tinkerbot is a hosted proprietary SaaS. The terminal client and GitHub App/Action use server-authoritative organization, entitlement, repository, policy, and evidence decisions; the web surface is limited to required handoffs.

Tinkerbot may prepare bounded evidence in a customer runner. Source code, diffs, ASTs, and full reports stay local unless an explicit tenant-authorized transfer policy applies; release clients require an account.

The paid control-plane design preserves that boundary. Synchronized data is structured verification metadata, not a source mirror; full diffs are not uploaded by default. Repository names, paths, findings, and rule metadata can still be sensitive and must be covered by organization authorization and configurable retention.

The Tinkerbot Verify Action is designed for `pull_request`, not `pull_request_target`. It uses least-privilege permissions, checks out with persisted credentials disabled in the example, does not require privileged secrets, avoids printing full diffs, redacts common environment secret values from summaries, and treats repository configuration as untrusted input. Network use is optional and limited to GitHub’s API for one Check Run/comment when the supplied token permits it; fork runs are write-disabled.

Mutation and test commands are bounded by configured timeouts and limits. Dynamic or incomplete analysis is labeled `UNKNOWN` rather than promoted to a false pass or failure.

The control-plane implementation keeps authentication, organization/repository authorization, entitlements, and billing provider state behind server-side adapters. The Worker uses secure HTTP-only session cookies, encrypts WorkOS tokens before D1 persistence, validates OAuth state, verifies WorkOS and Stripe webhook signatures, applies timestamp tolerance and replay ledgers, and records webhook events for replay protection. An opt-in scheduled Events API consumer advances a D1 cursor only after event handling succeeds. Unknown WorkOS roles map to viewer and inactive/pending memberships do not receive access. The browser is never trusted for plan, role, organization, or access decisions. The staging implementation now includes invitation UX wiring, invite-safe roles, feature and seat enforcement, and entitlement snapshots; deployment still needs WorkOS endpoint registration, rotated secrets, replay enablement, CSRF protection where cookie mutations are used, rate limiting for authentication and billing actions, safe redirect allowlisting, audit events for sensitive actions, and entitlement reconciliation. No raw payment-card data is accepted or stored by the application.

Baseline and history files contain repository/revision identifiers, finding fingerprints, rule metadata, and local trend values—not full source or diffs. Review repository policy before checking them in. Artifact adapters read repository-relative paths only, and generic JSON is treated as evidence records rather than executed configuration.

## GitHub App boundary

The App manifest is a template in [`github-app/manifest.json`](../github-app/manifest.json). Webhook handlers must validate `X-Hub-Signature-256`, deduplicate `X-GitHub-Delivery`, normalize repository identity, and fail closed on missing installation/repository permissions. The App receives assurance metadata only and must never check out or execute pull-request code. Verification remains in the customer-controlled runner; GitHub remains authoritative for review and merge state.

## Change assurance boundary

Assurance receipts, graph snapshots, lifecycle events, contracts, release manifests, and outcomes are structured metadata. Receipt integrity is a SHA-256 check over a canonical payload; verification reports the original deterministic verdict and never upgrades it. Hosted assurance ingestion is authenticated, organization-scoped, repository-scoped, role-checked, and server-entitlement-checked. Source code, full diffs, patches, secrets, tokens, API keys, and credential-shaped fields are rejected by the Worker ingestion boundary. Local receipt verification remains accountless and can run offline.

Graph completeness, runtime relationships, deployment state, and outcome associations are explicit partial or UNKNOWN states. A preceding change is not treated as the cause of an incident without human-confirmed or otherwise supported provenance. Deletion requests remove organization/repository assurance metadata and create an audit record; retention metadata remains part of portable outcomes and records.

## Security contact

The source workspace does not have an authorized public repository or security mailbox configured yet. Before publishing, the release owner must configure the repository’s private vulnerability-reporting channel (prefer GitHub Security Advisories) and replace this notice with the canonical contact. Do not disclose a suspected secret or vulnerability in a public issue.
