# Architecture

PR Proof is a local-first pipeline:

```text
Git diff + repository files
          |
          +--> git adapter ----> normalized diff
          |
          +--> language-core ---> language detection/capabilities
          +--> parser ----------> multi-language symbol graph
          |                             |
          +--> coverage ---------+       +--> impact analysis
          |                      |                    |
          +--> test integrity ---+--------------------+
                                 |
                    shared report schema and verdict policy
                                 |
                  terminal / JSON / Markdown / SARIF / GitHub
```

`core` owns configuration, identifiers, findings, verdicts, and report schemas. `git` is the only layer that reads revisions. `language-core` owns extension/test conventions and capability declarations. `language-validation` runs bounded read-only front-end checks without executing repository code. `parser` preserves the TypeScript compiler API adapter, resolves common workspace metadata, and dispatches bounded line-oriented adapters for Python, Go, Rust, C, and C++. `test-integrity`, `coverage`, `mutation`, and `impact-analysis` are independent analysis adapters. `reporters` are pure formatters. The CLI composes them; the GitHub Action is a thin wrapper around the CLI/report contract.

The isolated `packages/tui` application is a thin Bun/OpenTUI client over that local CLI contract. It owns terminal lifecycle, focus/keymap behavior, resize/narrow fallback, grouped work navigation, local diff/evidence/run/policy views, and export commands; it does not reimplement verification or maintain competing persistence. The GitHub App/Action boundary publishes one `Tinkerbot Verify` Check Run, bounded annotations, a sticky summary, and source-minimized artifacts. It never executes untrusted pull-request code on an App server.

GitHub remains authoritative for pull requests, full diffs, changed-file navigation, review comments, threaded discussions, approvals, branch protections, required checks, merge controls, permissions, and audit history. Tinkerbot contributes deterministic findings, impact/reachability evidence, test/contract/fixture evidence, policy/baseline context, explicit stale/unknown states, and integrity-checkable receipts.

The implementation intentionally avoids a hosted control plane, source upload by default, agent orchestration, a permanent chat interface, or a replacement PR client. `tb serve` remains a compatibility/local-report surface only.
