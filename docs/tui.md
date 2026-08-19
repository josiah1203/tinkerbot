# TUI session

`tb tui` is two surfaces. Interactive TTY is a tabbed **OpenTUI-style master terminal** in `packages/tui` (isolated from the Node verification engine, Action, and hosted inference). Non-TTY and CI use the Node transcript in `packages/cli/src/tui/` (`tb tui --once`).

Launch interactive mode from a real Cursor/IDE TTY: `pnpm tui` or `pnpm tb tui`. There is no AppleScript or PID-kill launcher.

## Surfaces

- TTY: master tabs (Check, Work, nested agent CLIs, optional Shell). `/check` runs `tb check` into the Check tab. Leader `ctrl-g` then `n`/`p`/`w` leaves a nested PTY.
- Non-TTY / CI: exit 2, no check. Use `tb tui --once` or `tb check`.
- `tb tui --once` / `tb tui check`: one Node check transcript, same exit codes as `tb check`.
- `tb tui work <id>`: Work tab (hosted attach when logged in).
- `tb tui --agent claude|gemini|codex|cursor|shell`: open a nested CLI tab.
- `tb agents`: PATH detection. Logged-in-or-not is best-effort. Tokens are never printed.

## Nested CLIs

Binaries on `PATH` (override with `TINKERBOT_CLAUDE_BIN`, `TINKERBOT_GEMINI_BIN`, `TINKERBOT_CODEX_BIN`, `TINKERBOT_CURSOR_BIN`). Cursor is `cursor`, then `agent`. Fallback shell is `$SHELL`.

The **child** runs vendor login (`claude auth login`, and so on). Tinkerbot does not proxy or store Anthropic, Google, OpenAI, or Cursor tokens.

Trust boundary: Tinkerbot will not merge and will not treat nested “tests passed” text as PASS. A raw PTY can still run `gh pr merge` if the user could. `tb check` remains the only verdict.

Hosted factory YAML still rejects harness types `claude`, `claude-code`, `codex`, `gemini`, and `oz`. Hosted implement stays `tinkerbot-sandbox` | `github_actions`.

## Master slash

Always Tinkerbot, never the child: `/tab`, `/check`, `/work <id>`, `/claude`, `/gemini`, `/codex`, `/cursor`, `/shell`, `/factory list|show`, `/dashboard`, `/help`, `/exit`. Forbidden on the master: `/merge`, `/pass`, `/fail`, `/approve-verdict`.

## Node `--once` streams

`select-tests` is a recommendation. The GitHub Action must not use it to skip required CI tests.

| Card | Feeds `tb check` verdict |
| --- | --- |
| SelectTests | never |
| Subset | never (locked when `requiresFullSuite`) |
| Bash(configured command) | yes |
| Verdict | `calculateVerdict` only |

`--no-base-tests` remains UNKNOWN.

## Hosted attach

Agent stage text is transcript, not PASS. Verify waits for Action (or GitLab CI) OIDC ingest. Missing ingest is UNKNOWN. `/approve` on the Node transcript is specification only. Humans merge.
