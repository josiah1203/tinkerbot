# Architecture

Tinkerbot is a hosted change-assurance control plane with bounded client-side evidence preparation:

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
                  terminal client / JSON / Markdown / SARIF / GitHub Action
                                 |
                      authenticated hosted ingestion
                                 |
          organization policy, entitlements, and assurance state
```

`core` owns configuration, identifiers, findings, verdicts, and report schemas. `git` is the only layer that reads revisions. `language-core` owns extension/test conventions and capability declarations. `language-validation` runs bounded read-only front-end checks without executing repository code. `parser` preserves the TypeScript compiler API adapter, resolves common workspace metadata, and dispatches bounded line-oriented adapters for Python, Go, Rust, C, and C++. `test-integrity`, `coverage`, `mutation`, and `impact-analysis` are independent analysis adapters. `reporters` are pure formatters. The CLI composes them; the GitHub Action is a thin wrapper around the CLI/report contract.

The isolated `packages/tui` application is a Bun/OpenTUI client for the hosted control plane. It requires a control-plane URL, a session token, and a repository identifier; it loads server-authoritative assurance snapshots and invokes `tb verify` only to prepare and submit bounded evidence. The GitHub App/Action boundary publishes one `Tinkerbot Verify` Check Run, bounded annotations, a sticky summary, and source-minimized artifacts. It never executes untrusted pull-request code on an App server.

GitHub remains authoritative for pull requests, full diffs, changed-file navigation, review comments, threaded discussions, approvals, branch protections, required checks, merge controls, permissions, and audit history. Tinkerbot contributes deterministic findings, impact/reachability evidence, test/contract/fixture evidence, policy/baseline context, explicit stale/unknown states, and integrity-checkable receipts.

The implementation does not replace GitHub’s PR client, execute untrusted PR code in a hosted service, or upload source/full diffs through assurance ingestion. `tb serve` is not a hosted product surface; it remains a compatibility command only. Current provider and distribution gates are recorded in [`release-readiness.md`](./release-readiness.md).
