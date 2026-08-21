# TUI session

`tb tui` is the verification client surface with a Claude Code-style kit shell on a TTY. `tinkerbot-tui` (or `pnpm tui:kit`) is the standalone Factory Workstation entrypoint built on the same shell in `packages/tui`; both project the same graph, work, and deterministic-check state while keeping vendor CLIs in nested PTYs. `@tinker` is **not** a TUI mention — it is the factory’s GitHub/Slack/Jira/Linear command handle. Non-TTY and CI use the Node transcript in `packages/cli/src/tui/` (`tb tui --once`).

Launch interactive mode from a real Cursor/IDE TTY: `pnpm tui` or `pnpm tb tui`. There is no AppleScript or PID-kill launcher.

The workstation accepts `TINKERBOT_CLAUDE_CODE_KIT_ROOT` when the supplied kit has been built (`packages/ui/dist` and `packages/ink-renderer/dist`). The checked-in source-only checkout is detected automatically and uses the compatible fallback renderer until its optional UI packages are built; no kit agent package is loaded into the verification core.

## Surfaces

- TTY: compact kit shell with live editing, slash suggestions, chat input, and `/check`/`/work`/`/graph` projections. `/tab next|prev|close` switches the underlying tabs.
- Non-TTY / CI: exit 2, no check. Use `tb tui --once` or `tb check`.
- `tb tui --once` / `tb tui check`: one Node check transcript, same exit codes as `tb check`.
- `tb tui work <id>`: Work tab (hosted attach when logged in).
- `tb tui --agent claude|gemini|codex|cursor|shell`: open a nested CLI tab.
- `tinkerbot-tui [--once] [work <id>] [--agent claude|gemini|codex|cursor|shell]`: launch the kit-aware Factory Workstation; `/check` and `/graph` use the current local implementation.
- `tb agents`: PATH detection. Logged-in-or-not is best-effort. Tokens are never printed.

## Nested CLIs

Binaries on `PATH` (override with `TINKERBOT_CLAUDE_BIN`, `TINKERBOT_GEMINI_BIN`, `TINKERBOT_CODEX_BIN`, `TINKERBOT_CURSOR_BIN`). Cursor is `cursor`, then `agent`. Fallback shell is `$SHELL`.

The **child** runs vendor login (`claude auth login`, and so on). Tinkerbot does not proxy or store Anthropic, Google, OpenAI, or Cursor tokens.

Trust boundary: Tinkerbot will not merge and will not treat nested “tests passed” text as PASS. A raw PTY can still run `gh pr merge` if the user could. `tb check` remains the only verdict.

Hosted factory YAML accepts customer-owned harness definitions, but hosted Workers never execute those commands directly. Use `runner.type: self_hosted` plus `workerHost: self_hosted[:worker-id]`; the control plane emits a credential-free `SELF_HOSTED_WORK` handoff and the worker returns through the existing deterministic verification/OIDC path. Built-in hosted implement remains `tinkerbot-sandbox` | `github_actions`.

## Master slash

Always Tinkerbot, never the child: `/tab`, `/check`, `/work <id>`, `/claude`, `/gemini`, `/codex`, `/cursor`, `/shell`, `/factory list|show`, `/plan`, `/cost`, `/eval`, `/dashboard`, `/help`, `/exit`. `/plan` `/cost` `/eval` read the local SQLite store. Forbidden on the master: `/merge`, `/pass`, `/fail`, `/approve-verdict`.

## Node `--once` streams

`select-tests` is a recommendation. The GitHub Action must not use it to skip required CI tests.

| Card | Feeds `tb check` verdict |
| --- | --- |
| SelectTests | never |
| Subset | never (locked when `requiresFullSuite`) |
| Bash(configured command) | yes |
| Verdict | `combineVerification` over required modules; reported worker claims ignored |

`--no-base-tests` remains UNKNOWN.

## Hosted attach

Agent stage text is transcript, not PASS. Verify waits for Action (or GitLab CI) OIDC ingest. Missing ingest is UNKNOWN. `/approve` on the Node transcript is specification only. Humans merge.
