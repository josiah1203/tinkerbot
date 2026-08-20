# Tinkerbot Verify GitHub Action

The Action runs `tb check` on the customer runner and submits a source-minimized assurance bundle. That verification cell is the quality laboratory for every production line. The GitHub App is the authoritative Check Run and inline-comment publisher. Action-side `GITHUB_TOKEN` publication is a fork/degraded fallback only.

## OIDC

Hosted admission is signature-verified and fail-closed. Unsigned JWT helpers (`e30.*.sig`) are rejected.

1. Workflow `permissions: id-token: write`
2. Action requests a GitHub OIDC token with audience `tinkerbot` (GitLab CI is supported only for the explicitly allowlisted public `https://gitlab.com` issuer)
3. `POST /actions/oidc/exchange` verifies RS256 against the issuer JWKS (`https://token.actions.githubusercontent.com/.well-known/jwks` or the fixed GitLab.com JWKS), then `exp` / `nbf` / `iat`, `iss`, `aud`, `repository`, optional `sha`, and consumes `jti` (or a token fingerprint) against replay. Self-managed GitLab issuers require a separately reviewed allowlist/adapter; arbitrary issuer hostnames are rejected.
4. Exchange fails closed when the repository has no GitHub App installation
5. Worker returns a short-lived run token
6. Action `POST /assurance/ingest` with that token
7. App publishes Check Run + inline comments, deduped by `runId + fingerprint + commitSha`

`session-token` remains a deprecated developer fallback. Fork PRs stay write-disabled. Use `pull_request` only, never `pull_request_target`. Unauthorized publication leaves local artifacts and an explicit UNKNOWN.

## Packaging

`action/index.js` requires compiled `dist/action/index.js`. Root `dist/` is gitignored. GitHub Action **release tags** must include the built `dist/` tree (`pnpm build` on the tag machine, then publish that artifact). A source-only checkout cannot run the Action.

App permissions: `metadata: read`, `contents: read`, `pull_requests: write`, `issues: write`, `checks: write`. Webhook URL: `/integrations/github/webhook`.
