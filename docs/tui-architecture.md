# Tinkerbot hosted TUI architecture

## Decision

The product direction in the Tinkerbot brief supersedes older product-direction prose that centered a browser control-plane preview. No executable repository instruction forbidding a terminal UI was found during Phase 0. The existing verification engine, report contract, GitHub Action, and local `tb`/`pr-proof` compatibility remain canonical.

This change does not inspect, import, copy, or migrate Synara code, branding, layouts, settings, business logic, or data models. Synara audit artifacts are outside the Tinkerbot implementation boundary.

## Runtime boundary

The verification engine remains the existing TypeScript/Node implementation under `packages/`. The TUI is isolated in `packages/tui` and is implemented with the pinned OpenTUI core, Solid, and keymap packages. OpenTUI-specific renderables never enter `core`, `git`, analyzers, reporters, or the GitHub Action. Hosted organization, membership, entitlement, repository binding, policy, and accepted evidence remain authoritative.

The release TUI consumes an authenticated control-plane protocol:

1. It requires an HTTPS control-plane URL, authenticated session token, and canonical `owner/repository` reference.
2. It loads assurance state through the server-authorized API and presents an explicit permission/error state when that contract is unavailable.
3. It never silently falls back to repository-local reports, localStorage, or static demo data in hosted mode.
4. It may prepare source-minimized local inputs only through explicit authenticated client commands; accepted evidence is owned by the hosted service.

The hosted adapter has no local-authority fallback. A missing session, denied membership, entitlement failure, or failed request is a recoverable, visible state—not a fabricated PASS.

## Packaging matrix

`pnpm tui:build` produces the Bun bundle used by `tb tui`. `pnpm tui:compile` produces a host executable; set `TINKERBOT_TUI_TARGET` for a supported cross-target. The target matrix is macOS Apple Silicon/x64, Linux glibc x64/arm64, Linux musl x64/arm64, and Windows x64/arm64 where the matching OpenTUI native package is available. Cross-target artifacts are build outputs, not a claim that every terminal/OS combination has been live-validated in this workspace.

The OpenTUI packages and native bindings stay pinned to the same version. The standalone build uses Bun’s single-file compile path and does not change the canonical Node verification engine.

## Lifecycle and fallback

The renderer is owned by a single lifecycle boundary. SIGINT, cancellation, resize, child-process failure, and render errors all pass through cleanup before exit. A test renderer exercises the same component tree. Terminal widths below the two-pane threshold use a single-column detail view and retain all commands through the bottom input.

## GitHub boundary

The Action and App publish deterministic summaries, checks, receipts, and bounded annotations through authenticated hosted authorization. GitHub remains authoritative for review, comments, approvals, branch protection, required checks, merge controls, permissions, and audit history. The TUI requires hosted login and never uploads source or full diffs by default.

## Alternatives rejected

- Importing analyzers directly into the TUI would couple rendering to the engine and bypass the stable CLI/report contract.
- Rebuilding the engine around OpenTUI would break existing Node/CI callers and the Action.
- Adding a web dashboard would exceed the local-first TUI boundary; `tb serve` remains a compatibility/local-report surface only.
- `@opentui/react`, `@opentui/three`, and `@opentui/ssh` are not used in this pass.
