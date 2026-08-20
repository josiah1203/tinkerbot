# Cloudflare hosted runtime and secrets

The factory Worker binds D1, R2 (`EVIDENCE_BUCKET`), Queue (`FACTORY_EVENTS`), Workers AI (`AI`), a `Sandbox` Durable Object binding, and static assets for the dashboard. Wrangler `database_id` values are placeholders: operators must create distinct D1 databases for development, staging, and production and replace `00000000-…`, `11111111-…`, and `22222222-…`. See [hosted provisioning](./hosted-provisioning.md).

Optional customer S3/GCS export uses Worker secrets `EVIDENCE_EXPORT_ENDPOINT` and `EVIDENCE_EXPORT_TOKEN` after a successful R2 put. Export failure does not change a `tb check` verdict. Cron (`*/15 * * * *`) reconciles billing metadata and, when enabled, WorkOS Events.

GitLab intake is `POST /integrations/gitlab/webhook` (MR and Issue hooks, `GITLAB_WEBHOOK_SECRET`). Job/Pipeline/Deployment/System hooks are rejected. GitLab CI OIDC is a peer of GitHub Actions for ingest only.

Account: `ee09ba373380c725a23c69d5236e570d`. Staging Worker: `tinkerbot-control-plane-staging`. Production D1, R2, Queue, Workflow, and AI resources must be provisioned in that account; this repository does not create live Cloudflare resources.

Required secrets for the hosted core:

- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `SESSION_ENCRYPTION_KEY`

Optional source-control adapter secrets:

- `GITHUB_WEBHOOK_SECRET` enables signed GitHub webhook intake.
- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` enable the optional customer-managed GitHub App publisher.

Core factory use does not require a Tinkerbot GitHub App installation or any GitHub App credentials.

Vars: `CONTROL_PLANE_URL`, `WORKOS_REDIRECT_URI`, `ACTION_OIDC_AUDIENCE`, nonempty production `STRIPE_PLANS_JSON`. Self-hosted execution additionally uses a distinct `SELF_HOSTED_WORK_SECRET` and either the `SELF_HOSTED_WORK` Queue or an HTTPS-only `SELF_HOSTED_WORK_ENDPOINT`; neither path carries provider credentials. Copy [`apps/control-plane-worker/.env.example`](../apps/control-plane-worker/.env.example) to `.dev.vars` locally.

Production integration intake also requires the provider-specific `*_WEBHOOK_SECRET` and `INTEGRATION_ORGANIZATION_ID`. The latter is a deliberate single-tenant deployment binding; a multi-tenant rollout needs a signed per-tenant endpoint/token registry before exposing these public webhook paths. Authenticated `/config/status` reports `selfHostedWorkReady` separately from the presence of a queue/endpoint so an operator cannot mistake a producer binding for a runnable worker boundary.
