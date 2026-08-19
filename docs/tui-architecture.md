# TUI architecture

The interactive master terminal lives in `packages/tui`. It is not imported by `packages/core`, the GitHub Action, or hosted Workers AI.

`tb tui --once` stays in `packages/cli/src/tui/` so CI and non-TTY coverage remain on the Node engine. OpenTUI-style chrome is excluded from the CLI coverage ratchet (`packages/tui/**`).
