# TUI architecture

The interactive master terminal lives in `packages/tui`. It is not imported by `packages/core`, the GitHub Action, or hosted Workers AI.

`tb tui --once` stays in `packages/cli/src/tui/` so CI and non-TTY coverage remain on the Node engine. OpenTUI-style chrome is excluded from the CLI coverage ratchet (`packages/tui/**`).

The interactive chrome is a compact kit shell: branded header, slash suggestions, editable prompt, transcript projections, and model/cost footer. The underlying state still contains Check, Work, nested agent, and Shell tabs, which are exposed through `/tab next|prev|close`. Nested `claude` / `gemini` / `codex` / `cursor` / `$SHELL` processes keep vendor OAuth in the child.
