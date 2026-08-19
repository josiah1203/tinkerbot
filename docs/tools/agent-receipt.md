# Agent Change Receipt

## User problem

Record how an agent-assisted factory stage ran without storing prompts, source, or secrets, and without treating the receipt as a correctness proof.

## CLI

```sh
tb receipt validate --input .tinkerbot/agent-receipt.json
```

A valid receipt never upgrades a failed or unknown verification verdict. Malformed receipts, missing identity, or credential-like values are `UNKNOWN`.

## Required fields

Identity (repository, agent, workflow), model/provider, harness, prompt/config hash when present, definition hash, input/output references, tool-call names (not payloads), tokens/cost, duration, retries, human decisions, commit/PR, and the deterministic verification result.

Do not store prompts, source, or secrets. A signature over the receipt is independent of pass/fail.
