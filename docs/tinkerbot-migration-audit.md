# Tinkerbot migration audit

> Historical audit — preserved to show the migration baseline. Its local/accountless preview assumptions are superseded by the current hosted-product contract and ADRs.

Date: 2026-08-18

This audit applies the attached Tinkerbot migration specification to the existing `pr-proof` repository. The direct implementation request for this slice is to prepare WorkOS authentication, Stripe billing, and Cloudflare hosting/secrets boundaries without placing provider credentials in source or claiming production readiness.

## Instruction boundaries

- The attached prompt is treated as product and architecture scope: preserve the local verifier, preserve the existing control-plane shell, keep deterministic evidence authoritative, and add provider adapters explicitly.
- Provider credentials supplied in chat are treated as secrets. They are not copied into source, configuration committed to Git, reports, logs, frontend bundles, or documentation.
- No external account, resource, subscription, webhook, deployment, domain, package publication, or public repository mutation is performed by this audit.
- The existing local preview remains accountless and provider-independent.

## Repository inventory

| Area | Current state | Migration implication |
| --- | --- | --- |
| Package manager | pnpm workspace; TypeScript build; Node 20+ | Keep pnpm and add provider code under `packages/` or the existing app boundary. |
| CLI | `pr-proof` commands, deterministic reports, local `serve` | `tb` and `tinkerbot` now alias the existing entrypoint; legacy commands/state/schema remain supported. |
| Verification engine | Core, Git, parser, coverage, mutation, impact, contracts, fixtures, policies, history | This remains authoritative and must not depend on hosted auth or billing. |
| Local report viewer | `apps/control-plane` served by `tb/pr-proof serve`; browser-only report viewer | Keep localhost-only and accountless. Do not turn it into a hosted API. |
| Hosted preview shell | `apps/control-plane/app.js`, static `data.js`, `auth.js`, and `server.mjs` | Extend additively; replace development-only provider seams with server-backed adapters only when endpoints exist. |
| Authentication | Development `localStorage` preview plus WorkOS Worker path | WorkOS exchange, encrypted D1 sessions, refresh, secure cookies, sign-out, D1 membership authorization, signed WorkOS membership/invitation provisioning, current-user sync, cursor-based Events API replay, invitation API, and optional hosted Team UI wiring are implemented; webhook registration, rotated live credentials, and organization switching remain. |
| Billing | Static preview plus server-side Stripe Worker path | Checkout, portal, cancellation, signature verification, D1 replay protection, billing metadata, entitlement snapshots, feature checks, and seat checks are implemented; plan catalog, reconciliation, and live validation remain. |
| Persistence | Portable D1 metadata/session/ledger and R2 evidence adapters | Staging D1 is provisioned and migrations `0001`–`0004` are applied; R2 still requires account enablement, bucket creation, binding, and retention policy. |
| Deployment | Cloudflare Worker staging deployment and secret contract | `tinkerbot-control-plane-staging` is deployed and scheduled; rotated provider secrets and production promotion remain gated. |
| Tests | Vitest suites cover local verifier, preview server, language support, and hosted contracts | Session encryption, WorkOS callback, Stripe checkout/webhook, secret-boundary, and storage tests are local; tenant-isolation and live provider tests remain. |

## Existing control-plane route map

The existing shell already contains these public/local paths:

- `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`
- `/local/report`
- `/app`, `/app/overview`, `/app/repositories`, `/app/repositories/:id/*`
- `/app/history`, `/app/runs`, `/app/runs/:id`, `/app/findings`, `/app/findings/:id`
- `/app/policies`, `/app/baselines`, `/app/team`, `/app/integrations`
- `/app/settings/account`, `/security`, `/notifications`, `/billing`, `/audit`, `/report`

The current UI uses the established shell, sidebar, settings navigation, local filtering, honest unavailable banners, and browser-local development auth. The provider work must retain these paths and make provider status explicit rather than replacing the shell or fabricating server state.

## Provider implementation plan

```text
WorkOS       -> AuthProvider       -> server session + organization authorization
Stripe       -> BillingProvider    -> checkout/portal + signed idempotent webhooks
Cloudflare   -> HostedRuntime      -> Worker/Pages boundary
Cloudflare   -> MetadataStore      -> portable D1-compatible contract
Cloudflare   -> EvidenceStore      -> R2-compatible structured evidence retention
Secrets      -> runtime bindings   -> local .dev.vars / deployment secrets, never source
```

The first implementation slice provides:

1. Provider-neutral TypeScript contracts and configuration validation.
2. WorkOS authorization/exchange and refresh methods without frontend secret exposure, plus encrypted D1 session persistence.
3. Stripe checkout/portal/cancellation requests and signed replay-safe webhook processing without trusting browser plan state.
4. Cloudflare Worker configuration, D1 migrations, and portable R2/D1 runtime interfaces.
5. Interactive secret bootstrap documentation/script that never accepts secrets as command-line arguments.

## Release classification

| Capability | Classification after audit |
| --- | --- |
| Local deterministic verification | Implemented and tested |
| Local report viewer | Implemented and accountless |
| Multi-language static graph | Implemented with explicit uncertainty |
| WorkOS production auth | Implemented runtime path; requires webhook registration, rotated secrets, live callback validation, and broader bootstrap/reconciliation checks |
| Stripe production billing | Implemented runtime path; requires server plan catalog, entitlement enforcement, and webhook reconciliation |
| Cloudflare hosted runtime | Staging Worker/config/migrations deployed; R2 and production promotion remain |
| Cloudflare secret storage | Worker secret and Secrets Store workflows documented; no remote secret mutation performed |
| Hosted persistence and evidence ingestion | D1 session/metadata/ledger and R2 adapter implemented; evidence ingestion remains deferred |
| GitHub App/repository sync | Deferred; existing Action remains local-runner based |
| Production readiness | Not claimed |

## Security notes

- Rotate the WorkOS, Stripe, and Cloudflare credentials pasted into chat before using them for production or shared environments.
- Use separate development/staging/production credentials and least-privilege Cloudflare tokens.
- Do not use R2 access keys as general Cloudflare API credentials, and do not place either credential type in a Worker bundle.
- WorkOS and Stripe secrets belong only in server-side bindings. Browser code receives capability/status data, never provider tokens.
- Stripe webhooks must be signature-verified and idempotent before changing subscription or entitlement state.
- Hosted evidence ingestion must validate schema, size, organization, repository, checksum, and authorization before persistence.
