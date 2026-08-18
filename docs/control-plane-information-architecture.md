# pr-proof control-plane information architecture

The paid website is an administrative and analytical control plane. It manages organizations, repository connections, policies, billing, access, and synchronized verification metadata. It does not replace the local CLI, GitHub Action, source repository, or pull-request UI.

## Shell

The authenticated shell has:

- organization selector and repository scope in the header;
- primary navigation for Overview, Repositories, Verification Runs, Policies, History, Team, and Settings;
- a command palette for route and repository/run retrieval;
- an account menu with user, organization, plan, settings, help, and sign out;
- a responsive rail that becomes a drawer on small screens;
- explicit status labels and accessible text in addition to color.

## Routes

Public routes:

- `/sign-in`
- `/sign-up`
- `/forgot-password`
- `/reset-password`

Authenticated routes:

- `/app` and `/app/overview`
- `/app/repositories`
- `/app/repositories/:repositoryId`
- `/app/repositories/:repositoryId/runs`
- `/app/repositories/:repositoryId/policies`
- `/app/repositories/:repositoryId/baselines`
- `/app/repositories/:repositoryId/findings`
- `/app/history`
- `/app/team`
- `/app/integrations`
- `/app/settings/account`
- `/app/settings/security`
- `/app/settings/notifications`
- `/app/settings/integrations`
- `/app/settings/billing`
- `/app/settings/audit`

Local-only route:

- `/local/report` — renders a report from a local file or the development fixture without requiring a hosted session.

## Information hierarchy

1. Summary: explicit counts and current plan/connection state.
2. Attention: highest-priority findings, incomplete evidence, setup tasks, and billing/access blockers.
3. Evidence: run-level proof, finding detail, coverage, mutation, impact, contracts, fixtures, baseline, and unknowns.
4. History: synchronized structured records and trends only when records exist.

## Domain model boundaries

- `Organization` owns memberships, repositories, policy references, billing reference, retention settings, and audit events.
- `Repository` stores provider identity, default branch, connection/action state, selected policy, baseline metadata, and summarized run metadata; it does not store source or full diffs by default.
- `VerificationRun` stores the versioned pr-proof report summary and structured evidence allowed by the retention policy.
- `Finding` is derived from the report contract and preserves severity, rule, location, evidence, confidence, resolution, baseline, and suggested action.
- `Plan` and entitlements are provider-independent and server-authoritative.
- `AuthSession` is provider-neutral; the development adapter is replaceable and is not an authorization boundary.

## Honest capability states

The bundled browser shell remains a local preview and is not connected to hosted mutations. A separate Cloudflare Worker now provides the WorkOS/Stripe runtime foundation, but the UI continues to mark repository sync, policy persistence, membership changes, and entitlement state as unavailable until the Worker is deployed with D1/R2 resources and application-level authorization. No preview action writes pretend production state.
