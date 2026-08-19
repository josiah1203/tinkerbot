# Tinkerbot Verify GitHub Action

The Action runs `tb check` on the customer runner and submits a source-minimized assurance bundle. That verification cell is the quality laboratory for every production line. The GitHub App is the authoritative Check Run and inline-comment publisher. Action-side `GITHUB_TOKEN` publication is a fork/degraded fallback only.

## OIDC

1. Workflow `permissions: id-token: write`
2. Action requests a GitHub OIDC token with audience `tinkerbot`
3. `POST /actions/oidc/exchange` validates issuer, audience, repository, SHA, and installation
4. Worker returns a short-lived run token
5. Action `POST /assurance/ingest` with that token
6. App publishes Check Run + inline comments, deduped by `runId + fingerprint + commitSha`

`session-token` remains a deprecated developer fallback. Fork PRs stay write-disabled. Use `pull_request` only, never `pull_request_target`. Unauthorized publication leaves local artifacts and an explicit UNKNOWN.

App permissions: `metadata: read`, `contents: read`, `pull_requests: write`, `issues: write`, `checks: write`. Webhook URL: `/integrations/github/webhook`.
