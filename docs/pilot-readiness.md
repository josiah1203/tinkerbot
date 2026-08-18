# Pilot readiness

For a design-partner pilot:

1. Add `pr-proof.yml` with the repository’s existing Vitest/Jest command and coverage artifact path.
2. Start in `advisory` mode and review false positives in the first few dozen pull requests.
3. Enable targeted mutation only for selected packages and keep `max_mutants`/timeout limits small.
4. Use the SARIF artifact and sticky comment for review evidence; do not make missing metadata a blocking condition.
5. Record repository-local duration, changed file count, findings, and unknown states without uploading source.

The stable usage-event shape is documented below for an optional future telemetry or billing adapter. PR Proof itself does not emit it or contact a hosted service.
