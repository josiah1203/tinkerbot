# Control-plane information architecture

Same origin, two chromes. Public routes are information and never render the app sidebar. Signed-in product lives under `/app` and never renders marketing nav. Auth APIs stay on the Worker (`/auth/workos/start|callback`, `/auth/session`); humans enter at `/login`.

After sign-in the Worker session cookie is set and the UI lands on `returnTo` when it is a same-origin `/app/...` path, otherwise `/app`.

Lists poll HTTP APIs. There is no realtime stream in v1. Browser sessions use the `tinkerbot_session` cookie; CLI uses a bearer token from `tb login`. Steer exists on the work-order detail page. It is not the home view.

## Chrome rules

- Marketing header: wordmark, Product, Changelog, Docs, Pricing, Log in, Start trial. Signed-in visitors see Open app instead of Start trial.
- Marketing footer: Security, Support, Privacy, Terms.
- App sidebar: org switcher and command palette at the top; Inbox, Work, Products, Factories, Releases, Evolution; Settings and Usage in the footer. Billing is not a top-level item.
- Unauthenticated `/app/*` redirects to `/login?returnTo=`.
- Work orders, billing management, seats, SSO, and evidence do not appear on the website.

## Public website

| Route | Purpose |
|---|---|
| `/` | Product story. Not the control tower. |
| `/product` | Factory OS: work orders, cells, humans merge, Steward cannot self-approve |
| `/verification` | `tb check` is the only verdict; UNKNOWN; no agent rewrite |
| `/github` | GitHub App + Action; forks write-disabled; no `pull_request_target` |
| `/github/install` | After auth, continue under `/app/settings/github` |
| `/agents` | Governed agents, receipts, no silent policy rewrite |
| `/pricing` | Seat catalog $20/$40/$60; 14-day Team trial; no paid caps; tokens are not billed |
| `/changelog`, `/changelog/:slug` | Ship notes |
| `/docs`, `/docs/:page` | Curated: quickstart, CLI, Action, billing, security |
| `/security` | Auth, evidence minimization, fail-closed entitlements |
| `/method` | How production works: evidence, cells, human merge |
| `/support` | How to get help |
| `/privacy`, `/terms` | Legal |
| `/login?returnTo=` | Dedicated auth screen. Alias `/sign-in`. |

## Authenticated dashboard

Keep the `/app` prefix so public and product URLs cannot collide.

| Route | Purpose |
|---|---|
| `/app` | Inbox / control tower. Groups: needs attention, in progress, waiting, blocked, done. Not a kanban home. |
| `/app/work` | Work-order list |
| `/app/work/:id` | List + detail. Answers: produced, where, blocking, evidence, who decides, next. Steer lives here only. |
| `/app/products`, `/app/products/:id` | Product map / risk class |
| `/app/factories`, `/app/factories/new`, `/app/factories/:id` | Factory list, wizard, operator pages (Dashboard, Activity, Runs, Agents, Automations, Scorers, Self-improvement, Definition). Agents stay read-only. Activity uses Triage/Planning/Building/Reviewing. Not the org Inbox. |
| `/app/cells` | Leased work cells |
| `/app/releases`, `/app/releases/:id` | Release candidates, assessments, and outcomes as a tab |
| `/app/evidence/:runId?` | Findings, UNKNOWN, receipts |
| `/app/evolution`, `/app/evolution/:id` | Proposals; approve is explicit; auto-merge forbidden; Steward cannot self-approve |
| `/app/usage` | Fair-use telemetry, labeled estimated COGS, not an invoice |

Settings use an inner nav. Primary nav does not list these.

| Route | Purpose |
|---|---|
| `/app/settings` | Org profile, switch org |
| `/app/settings/members` | Seats (humans billable; services not) |
| `/app/settings/billing` | Plan, trial, portal, checkout. Server summary only. |
| `/app/settings/github` | App install, repo connections |
| `/app/settings/gitlab` | Webhook secret docs; MR/issue only |
| `/app/settings/sso` | SSO / SCIM (Business+) |
| `/app/settings/api` | Service credentials, MCP URL |
| `/app/settings/export` | Optional S3/GCS fan-out after R2 |
| `/app/settings/notifications` | Slack / Teams |
| `/app/settings/roles` | Custom roles |
| `/app/settings/audit` | Audit export |

## Legacy redirects

| From | To |
|---|---|
| `/sign-in` | `/login` |
| `/app/overview` | `/app` |
| `/app/work-orders` | `/app/work` |
| `/app/work-orders/:id` | `/app/work/:id` |
| `/app/findings` | `/app/evidence` |
| `/app/integrations` | `/app/settings/github` |
| `/app/outcomes` | `/app/releases` |

## Work-order selection

Inbox groups and `/app/work` share one selection model: click focuses (and opens unless Shift), `X` / `Shift+X` toggles, `Shift+click` range-selects, arrows move focus, Inbox groups use two-dimensional arrows, `j`/`k` move to next/previous on the detail page. Multi-select actions are take, return, and approve spec only. No drag that silently changes status or merge.
