# BYOK credential boundary

## Status

Accepted

## Context

Local inference should use Anthropic, OpenAI-compatible, Ollama, or Workers AI adapters without storing raw keys in factory YAML, D1, SQLite, receipts, or `.tinkerbot`.

## Decision

Factory YAML may hold only `credentialRef` values (`env:VAR` or `keychain://…`). BYOK is local-runner-only in this release. Hosted BYOK (tenant vault, egress, retention) is a separate security project. Vendor CLI harnesses (Claude Code, Codex, Gemini, `oz`) remain rejected; API adapters are not harnesses.

## Consequences

Resolving a credential never writes the secret into plans, cost actuals, or receipts. Missing refs fail closed.
