# Factory authority planes

## Status

Accepted

## Context

Tinkerbot is a software production operating system. AI workers improve throughput; they are not required for factory value. A solo developer must be able to use Git, `tb`, CI, `tb check`, and human review only.

## Decision

Four planes:

1. **Control** — WorkOrders, recipes, FactoryPlan pins, cells, identities, entitlements, `@tinker` commands.
2. **Execution** — Git, local `tb`, CI, customer terminals, optional BYOK/OpenRouter/nested CLIs, sandboxes.
3. **Assurance** — `tb check` is the only `verificationVerdict`. Separate inspections: `tb factory check`, `tb cell check`, `tb release assess`, `tb outcome check`, `tb doctor`.
4. **Intelligence** — Cloudflare Workers AI drafts routing hints, eval judges, `@tinker` reply text, and Steward proposals. It never writes `verificationVerdict`.

Roles:

- `@tinker` is the factory’s **external** control handle (GitHub, Slack, Jira, Linear). Mentions become typed, authorized, idempotent commands. The TUI does not parse `@tinker`.
- The **customer agent** (optional) is a production worker. Hosted YAML must not set `harness: claude-code` (or Codex/Gemini/`oz`).
- **`tb check`** is the authoritative inspection engine.

Three truths that must not collapse:

```text
verificationVerdict = PASS | FAIL | UNKNOWN
reviewAssessment    = CLEAR | NEEDS_HUMAN_REVIEW | REVISE
releaseDecision     = READY | BLOCKED
```

Waivers are a separate object. An approved waiver is never a verification PASS.

Interactive TTY chrome may use `@claude-code-kit/ui` and `@claude-code-kit/ink-renderer`. `@claude-code-kit/agent` is not imported by `packages/core`, the GitHub Action, or hosted Workers. The kit’s renderer provenance (Claude Code TUI extraction) is a shipping review, not a verdict-authority change.

Five guarantees: work is never lost; every change has a traceable contract; evidence cannot silently become a verdict; workers operate within explicit boundaries; released software remains connected to later outcomes.

## Consequences

`tb factory init` / `tb work new` / `tb check` do not call an LLM. Factory evolution is propose → evaluate → review → canary → activate. Silent prompt, policy, or recipe edits are forbidden. Enterprise SSO is WorkOS (already on `/auth/workos/start`); SCIM, federation, and SoD remain later on the same objects.
