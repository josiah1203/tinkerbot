# Flaky Test Decision Tool

## User problem

Teams need to distinguish repeated intermittent failures from consistent failures, infrastructure failures, timeouts, and test-order sensitivity.

## CLI and Action surface

Planned: `pr-proof flaky-tests --input junit-history/`. It is deferred until a stable history input contract is documented.

## Inputs and outputs

Inputs are multiple JUnit/test-run records with revisions, test names, durations, failure messages, exit status, and environment metadata. Output would classify each test with sample count and evidence.

## Rules and unknowns

One failure is never flaky. Intermittence requires repeated observations under comparable conditions. Missing run identity, changed environments, and infrastructure ambiguity are `UNKNOWN`.

## Security, false positives, and configuration

Keep raw logs local and redact secrets. Configure minimum samples, comparable environments, and timeout thresholds. A test that fails only after a code change is not automatically flaky.

## Fixtures and out of scope

Fixtures need consistent failures, intermittent failures, infrastructure outages, timeouts, order-sensitive runs, and sparse history. Automatic quarantine, test deletion, and hosted analytics are out of scope.
