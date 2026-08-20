# Hosted factory control plane

The control plane is the system of record for products, factories, production lines, work cells, work orders, specifications, evidence, release candidates, outcomes, skills, and improvement proposals. It does not replace `tb check` or GitHub merge controls.

Worker routes:

- `GET/POST /factories`, `GET/PATCH /factories/:id` (operator view: activity columns, scorers, self-improvement, definition files)
- `GET/POST /work-orders`, `GET /work-orders/:id`, `POST /work-orders/:id/retry|approve|cancel|steer|take|return`
- `GET /products`, `GET /cells`, `GET /skills`, `GET /evolution`, `POST /evolution/:id/approve`
- `GET /releases`, `GET /outcomes`
- `GET /runs/:id`, `GET /runs/:id/events`
- `GET /usage`, `GET /integrations/github`
- `POST /actions/oidc/exchange` (RS256 JWKS, installation required) then `POST /assurance/ingest` with the short-lived run token
- Intake: GitHub, Slack, Linear, Jira, incident, and support webhooks
- `POST /tinker/commands` — typed `@tinker` gateway (idempotent; high-risk actions require confirmation; never a verification verdict)
- WorkOS `/auth/workos/start|callback`, `/auth/session`, `/auth/signout`
- Stripe `/billing/summary|checkout|portal`

Public site routes (`/`, `/product`, `/pricing`, `/changelog`, `/docs`, `/login`) are marketing and auth entry. Authenticated product lives under `/app`. See [information architecture](./control-plane-information-architecture.md).
