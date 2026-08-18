# ADR 0002: GitHub App and Action responsibilities

- Status: Accepted
- Date: 2026-08-18

## Decision

The GitHub Action runs verification in the repository’s Actions runner. It creates source-minimized assurance output and, when configured, submits it to the hosted control plane. The GitHub App receives signed lifecycle webhooks and owns its installation/repository relationship; it is not an execution environment for pull-request code.

## Consequences

- A PR can show a `Tinkerbot Verify` Check Run, bounded annotations, and one sticky comment through the Action today.
- A true App-branded Check Run requires release-owner registration of the App plus App credentials/token minting; the current Action uses the workflow token for its visible PR output.
- `pull_request_target` is prohibited for untrusted contributor code. Fork PRs do not receive privileged secrets or write operations.
- App manifest URLs and webhook secrets are external release inputs and must be configured before production registration.
