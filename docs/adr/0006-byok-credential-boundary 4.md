# BYOK credential boundary

## Status

Accepted

## Context

Local inference should use Anthropic, OpenAI-compatible, Ollama, or Workers AI adapters without storing raw keys in factory YAML, D1, SQLite, receipts, or `.tinkerbot`.

## Decision

Factory YAML may hold only `credentialRef` values (`env:VAR` or `keychain://…`). BYOK is local by default; a hosted control plane may use BYOK/local inference only through an explicitly registered `self_hosted` worker. Hosted Workers never receive or resolve customer provider keys. Vendor CLI harnesses (Claude Code, Codex, Gemini, `oz`) are customer-owned harnesses, not managed API adapters; they run only with an explicit local opt-in or self-hosted handoff.

## Consequences

Resolving a credential never writes the secret into plans, cost actuals, or receipts. Missing refs fail closed.
