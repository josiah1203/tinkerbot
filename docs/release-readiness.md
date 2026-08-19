# Release readiness

The factory source tree is not a production release until Cloudflare, WorkOS, Stripe, GitHub App, and signing identities are provisioned and validated.

| Area | Source status | Release gate |
| --- | --- | --- |
| Factory domain + CLI | implemented | hosted URL and session issuance |
| Dashboard | Worker APIs + SPA | production assets domain |
| GitHub App publisher | implemented | App registration, private key, webhook URL |
| Action OIDC | implemented | `id-token: write` on customer workflows |
| Billing | seat catalog, trial, grace | real Stripe Price IDs |
| CI matrix | ubuntu/macOS/Windows | live green run |
| Artifact signing | `"signed": false` | keys + workflow |

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm release:dry-run
pnpm release:clients
```
