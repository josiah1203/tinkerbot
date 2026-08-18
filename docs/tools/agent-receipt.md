# Agent Change Receipt

## User problem

Developers may want a local record of how an agent-assisted change was produced without requiring vendor cooperation or treating the record as correctness proof.

## CLI and Action surface

Planned: `pr-proof receipt validate --input .pr-proof/agent-receipt.json`. No public command is shipped yet.

## Inputs and outputs

The optional JSON receipt may include agent/version/model identifiers, task ID, prompt hash, changed files, commands, tests, failed attempts, backtracks, human decisions, and a summary. Output would validate shape, redact secrets, and report missing fields.

## Rules and unknowns

Malformed receipts, commands not independently observable, and missing human decisions are `UNKNOWN`. A valid receipt only proves that a record was supplied.

## Security, false positives, and configuration

Never store prompts, source, secrets, or tokens by default. Prompt hashes must be opt-in. Receipt paths and size limits must be bounded. Presence of a receipt must never lower a finding or create a pass.

## Fixtures and out of scope

Fixtures need valid, malformed, secret-containing, truncated, and vendor-neutral receipts. Vendor APIs, prompt uploads, provenance attestation, and correctness claims are out of scope.
