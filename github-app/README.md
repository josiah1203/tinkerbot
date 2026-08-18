# Tinkerbot Verify GitHub App template

This manifest is a customer- or operator-configured template. Replace the `example.invalid` URLs with an explicitly authorized HTTPS callback/webhook service before creating an App; no hosted Tinkerbot control plane is required for local CLI or Action use.

The App is an assurance publisher only. Verification runs in the customer-owned GitHub Actions runner through the `Tinkerbot Verify` Action. The App must not check out, execute, or interpret pull-request code on its own server. Webhook handlers must verify `X-Hub-Signature-256`, deduplicate `X-GitHub-Delivery`, redact secrets, and fail closed when installation or repository permissions are unavailable.

The App requests metadata read, pull-request read, and only the write capabilities needed for one Check Run, bounded annotations, and one sticky PR comment. It does not request repository contents or Actions access. GitHub remains authoritative for reviews, discussions, approvals, branch protection, merge controls, and audit history.
