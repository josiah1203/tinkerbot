# Frontend → backend contract inventory

> Historical audit — this record describes a transitional browser preview. It is not current release guidance; use [the documentation index](./README.md), [architecture](./architecture.md), and [release readiness](./release-readiness.md).

This is the backend work implied by the current pr-proof control-plane UI. The preview must keep unavailable capabilities visibly unavailable until these contracts exist; it must not imply that a toast or local state change was persisted.

## Implemented hosted slice

The Cloudflare Worker now provides a server-side WorkOS and Stripe foundation: OAuth state/callback exchange, encrypted D1 sessions, session refresh/sign-out, D1 membership/role authorization, signed WorkOS membership/invitation provisioning, Checkout/portal/cancellation requests, Stripe signature verification, replay-safe webhook claims, organization-keyed billing metadata, feature/seat entitlement guards, and entitlement snapshots. The default browser preview remains local-first, while an explicit hosted API base enables the Team invitation flow without exposing provider credentials.

## Priority 0 — identity, authorization, and tenancy

- Production sign-in, sign-up, sign-out, session refresh, session expiry, password reset, email verification, and recovery-token handling.
- Server-side session storage or signed sessions with rotation, revocation, secure cookies, CSRF protection, rate limits, and audit events.
- Organization/workspace membership, organization switching, role assignment, ownership transfer, suspension, and full roster management remain; invitation creation, invite-safe roles, and seat-limit enforcement are implemented.
- Server-side authorization for every repository, run, finding, policy, baseline, billing, integration, and audit-log read/write.
- Tenant isolation tests proving one organization cannot read or mutate another organization’s data.

## Priority 0 — repository and GitHub connectivity

- GitHub App installation and OAuth/account linking, repository discovery, private-repository entitlement checks, and disconnect/reconnect flows.
- Repository records: provider id, owner, visibility, default branch, installation, sync status, last sync, and failure state.
- Pull-request webhook ingestion with signature verification, replay protection, idempotency, and delivery history.
- Commit/ref resolution and a server-authorized way to enqueue local or hosted verification runs.
- Provider capability/status endpoints so the UI can show connected, degraded, revoked, rate-limited, and unavailable states.

## Priority 0 — verification runs and evidence

- Run creation, queueing, cancellation, retry, progress, timeout, failure, and completion state transitions.
- Durable run summaries keyed by repository, pull request, commit, base, head, policy, tool version, and generated timestamp.
- Evidence storage and retention for test integrity, impact, changed-line coverage, mutation, contracts, fixtures, and limitations.
- Run history pagination, filtering, comparison, deep links, and authorization checks.
- Report ingestion with schema validation, size limits, checksum/content-addressed storage, and explicit provenance.
- Export endpoints for JSON/SARIF/metadata with audit logging and download authorization.

## Priority 0 — findings, baselines, and policies

- Finding records with stable ids, rule ids, severity, confidence, status, location, evidence references, resolution history, and assignees.
- Finding resolution/reopen, acknowledgement, comments, ownership, bulk actions, and optimistic-concurrency handling.
- Baseline creation, update, comparison, stale/expired handling, renamed-finding detection, and repository-local versus hosted ownership rules.
- Policy-pack CRUD, versioning, validation, organization/repository assignment, evaluation results, and server-authorized blocking/advisory decisions.
- Policy and baseline change history with who/when/why metadata.

## Priority 1 — billing and paid entitlements

- Provider customer/subscription records, checkout-session creation, customer portal, invoice history, payment-method status, and cancellation/change-plan flows.
- Signed webhook ingestion for checkout, subscription, invoice, payment failure, refund, and cancellation events.
- Idempotent webhook ledger with replay protection and reconciliation jobs.
- Server-authoritative plan catalog, private-repository limits, member limits, feature flags, grace periods, delinquency, and entitlement snapshots.
- Billing access control so the client never determines its own paid capabilities.

## Priority 1 — notifications and integrations

- Persisted notification preferences for findings, run completion, billing, and security events.
- Delivery channels, templates, retries, bounce/complaint handling, unsubscribe state, and delivery audit history.
- Integration connection records, encrypted credentials/tokens, rotation/revocation, health checks, and least-privilege scopes.
- MCP/provider connection lifecycle if the product exposes those settings as real integrations.

## Priority 1 — operational trust and auditability

- Append-only audit log for authentication, membership, repository, run, finding, policy, baseline, billing, integration, and export events.
- Actor, organization, request id, timestamp, IP/device metadata policy, before/after summary, retention, and export support.
- Error taxonomy and correlation ids that the frontend can render as actionable states instead of generic failures.
- Health/readiness, provider status, rate-limit, maintenance, and incident endpoints.

## Priority 2 — frontend support contracts

- Cursor pagination and server-side search/filter contracts for repositories, runs, findings, audit events, and members.
- Saved view/filter preferences and settings persistence.
- Stable deep-link routes with 404, 401, 403, 404, 409, 429, 5xx, and expired-session behavior.
- Idempotency keys for all retriable mutations and consistent request validation errors mapped to fields.
- Server-driven feature/capability flags so unavailable actions can be disabled with a reason and a recovery path.

## Current preview action mapping

| Frontend action | Current preview behavior | Backend contract needed |
| --- | --- | --- |
| Connect repository | Honest unavailable toast | GitHub App install/OAuth and repository sync |
| Organization switching | Honest unavailable toast | Organization/workspace membership API |
| Run local check | Explains local CLI path | Run enqueue/progress/cancellation API for hosted runs |
| Policy changes | Honest non-persisted toast | Policy CRUD, validation, assignment, and authorization |
| Baseline actions | Honest local-only toast | Baseline storage/comparison and history |
| Invite member | Hosted API form when configured; honest unavailable toast otherwise | WorkOS credentials/webhook, invitation API, roles, seat limits, and identity provider |
| Integration actions | Honest unavailable toast | Credential-backed integration lifecycle |
| Billing/learn more | Honest unavailable toast | UI wiring plus plans, entitlements, invoices, and reconciliation; Worker billing endpoints now exist |
| Save settings/toggles | Honest non-persisted toast | Settings/preferences persistence and authorization |
| Finding panel | Local read-only evidence | Finding mutations, comments, resolution, and history |
| Report upload/download | Browser-local JSON read/download | Optional authenticated report ingestion/export API; preserve local-only mode |
| Search/filter/palette | Browser-local filtering/navigation | Server search, pagination, saved views, and permission-aware results |

## Contract acceptance bar

Before any provider-backed button is enabled, the backend should expose: an authenticated request, an authorization check, validation errors, loading/progress state, retry/idempotency behavior, success confirmation, failure recovery, audit event, and a test covering the relevant tenant boundary.
