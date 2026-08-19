# TUI architecture

The interactive master terminal lives in `packages/tui`. It is not imported by `packages/core`, the GitHub Action, or hosted Workers AI.

`tb tui --once` stays in `packages/cli/src/tui/` so CI and non-TTY coverage remain on the Node engine. OpenTUI-style chrome is excluded from the CLI coverage ratchet (`packages/tui/**`).

Master chrome is a tab strip (Check, Work, nested agent, Shell), body, and status bar. Nested `claude` / `gemini` / `codex` / `cursor` / `$SHELL` processes inherit stdio and keep vendor OAuth in the child. Leader `ctrl-g` then `n`/`p`/`w` changes tabs after the child exits.
