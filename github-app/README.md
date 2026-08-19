# Tinkerbot Verify GitHub App template

[`manifest.json`](./manifest.json) points at `https://control.tinkerbot.dev`. Replace those URLs with the approved production control-plane host before creating the App.

The App publishes Check Runs, bounded annotations, and inline review comments. Verification runs on the customer GitHub Actions runner. The App must not check out or execute pull-request code. Webhook handlers verify `X-Hub-Signature-256`, deduplicate deliveries, and stop writes when the installation is suspended or deleted.

Permissions: `metadata: read`, `contents: read`, `pull_requests: write`, `issues: write`, `checks: write`. Events: `issues`, `pull_request`, `installation`, `installation_repositories`. Webhook path: `/integrations/github/webhook`.
