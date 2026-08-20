# Release readiness

The factory source tree is not a hosted production release until Cloudflare, WorkOS, Stripe, and signing identities are provisioned and validated. GitHub App registration is an optional source-control adapter gate, not a prerequisite for core factory use.

| Area | Source status | Release gate |
| --- | --- | --- |
| Factory domain + CLI | implemented | hosted URL and session issuance |
| Factory Workstation + local platform MCP | source, package bins, and tests | clean-install client smoke test; optional claude-code-kit dist build |
| Dashboard | Worker APIs + SPA | production assets domain |
| GitHub App publisher (optional adapter) | implemented | App registration, private key, webhook URL |
| Action OIDC (optional adapter) | JWKS RS256 + installation required | App install + customer `id-token: write` |
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
