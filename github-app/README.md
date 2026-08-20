# Deprecated GitHub App template

This directory is retained only for historical installations and migration reference. It is not a Tinkerbot product surface and is not required to use Tinkerbot. New integrations use the provider-neutral `@tinkerbot` command/event protocol and map GitHub records to canonical Factory Graph objects through external references. Prefer the customer-owned GitHub Action or another least-privilege connector.

[`manifest.json`](./manifest.json) points at `https://control.tinkerbot.dev`. Replace those URLs with the approved production control-plane host before creating the App.

The App publishes Check Runs, bounded annotations, and inline review comments. Verification runs on the customer GitHub Actions runner. The App must not check out or execute pull-request code. Webhook handlers verify `X-Hub-Signature-256`, deduplicate deliveries, and stop writes when the installation is suspended or deleted.

Permissions: `metadata: read`, `contents: read`, `pull_requests: write`, `issues: write`, `checks: write`. Events: `issues`, `pull_request`, `installation`, `installation_repositories`. Webhook path: `/integrations/github/webhook`.
