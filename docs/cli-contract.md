# CLI contract

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | PASS, advisory NEEDS_REVIEW, or an informational command completed |
| 1 | FAIL, or NEEDS_REVIEW in blocking mode |
| 2 | UNKNOWN when `output.fail_on_unknown` is enabled, or an unavailable history/artifact command |
| 3 | Configuration, argument, policy, format, or report-input error |
| 4 | Repository, Git, worktree, or execution error |
| 5 | Unexpected internal error |
| 12 | Recognized command unavailable in this client build |

Scripts may rely on these values. A normal advisory `NEEDS_REVIEW` does not fail the process; blocking mode and explicit unknown policy do.

## Commands

The supported local analysis commands are `check`, `test-integrity`, `impact`, `report`, `doctor`, `config validate`, `config explain`, `usage`, `baseline init|check|update`, `policy list|explain`, `artifacts`, `select-tests`, `contracts`, `fixtures`, and `history|history compare`. Local factory runtime commands are `factory validate|new|plan`, `run --local`, `eval init|add|run|compare|baseline|export`, and `dashboard --local`. Empty `tb` prints help. `tb tui` is a tabbed master terminal on a TTY (`pnpm tb tui`); `--once` prints one Node check transcript. `tb agents` lists PATH CLIs. `tb factory new` writes a local starter tree. `tb dashboard` opens the hosted app. `--help` and `--version` are available without a repository analysis.

`login`, `logout`, `whoami`, `org list`, `org switch <organization-id>`, `org seats`, `billing summary|catalog|portal`, `factory list|show|sync|mcp`, `work *`, `cell list`, `product list|show`, `skill list|show`, `evolution list|show|approve`, `run show|logs`, `receipt validate`, and `verify --repository owner/repository` use an HTTPS control-plane URL and session from `tb login` or environment variables. `tb factory sync` uploads `factory.yaml` plus the `.tinkerbot/` tree. `github run` and `serve` remain recognized but unshipped and return exit code `12`.

Analysis commands accept `--base`, `--head`, `--format terminal|json|markdown|sarif`, `--output`, `--config`, `--policy`, `--mode`, `--timeout`, `--max-files`, and `--max-findings`. Values are passed as argument arrays; repository output/input paths must remain inside the repository root. Output files are created as needed and atomically replaced when an explicit `--output` is supplied.

The effective configuration supports `languages.mode: auto|explicit`, `languages.include`, and `languages.exclude` for `typescript`, `javascript`, `python`, `go`, `rust`, `c`, and `cpp`. JSON reports include a `languages` capability summary for detected source files; terminal and Markdown reports render the same summary.

## Output and error behavior

- Reports are deterministic for identical repository state, configuration, policy, and tool version.
- JSON and SARIF are machine-readable; Markdown and terminal output collapse hostile control characters and escape Markdown-sensitive text.
- Ordinary errors do not print full source files, environment values, tokens, or child-process secrets.
- Missing optional evidence is written to `limitations`/adapter `unknowns`, not converted to coverage or mutation success.
- Baseline changes happen only through `baseline init` or `baseline update`; a normal check never writes a baseline.

## Package execution

The built package exposes `dist/packages/cli/src/index.js` as `tb` and `tinkerbot`, with `pr-proof` retained only as a deprecated compatibility binary. It emits a deterministic migration warning and is never presented as the product identity. The Action uses `dist/action/index.js`. Run `pnpm build` before invoking either from a source checkout. Existing `pr-proof` configuration, `.pr-proof/` state, report schema, and Action marker names remain compatible.

`serve` is not a release capability. The legacy `pr-proof serve` implementation is retained only for development compatibility and must not be exposed as a hosted control plane.
