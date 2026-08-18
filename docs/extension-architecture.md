# Extension architecture

PR Proof keeps one local verification pipeline and adds modules at its evidence boundaries:

```text
Git base/head
  -> FileDiff[]
  -> parser and symbol graph
  -> evidence adapters (coverage, test results, mutation, contracts, fixtures)
  -> policy and baseline state
  -> versioned findings and unknowns
  -> terminal, JSON, Markdown, SARIF, and Action output
```

## Module contract

Implemented and future modules should expose a deterministic function that accepts a repository root, resolved revisions, the shared diff model, and a validated configuration. The result contains:

- module metadata (`id`, display name, version, supported ecosystems, required and optional inputs);
- a status (`pass`, `needs_review`, `unknown`, `not_run`, or `fail`);
- findings with rule ID, title/message, severity, confidence, location, evidence, remediation, fingerprint, and module;
- metrics, normalized evidence, diagnostics, and explicit unknowns;
- bounded execution and cache metadata when the module is expensive.

The repository currently uses the stable `Finding`, `FileDiff`, `ImpactReport`, and report-schema types as the compatibility seam. New fields are optional on the report, while finalized findings receive stable location, evidence, fingerprint, revision, and tool metadata.

## Package boundaries

| Package | Responsibility |
| --- | --- |
| `core` | configuration, finding/report schema, verdict aggregation, version capabilities |
| `git` | revision resolution, diff parsing, revision file reads, bounded worktrees |
| `language-core`, `language-validation`, `parser`, and `impact-analysis` | Language detection/capabilities, bounded read-only front-end checks, and TypeScript/JavaScript, Python, Go, Rust, C, and C++ symbols, imports, exports, and impact paths |
| `test-integrity`, `coverage`, `mutation` | test changes and evidence already produced by the repository |
| `baseline` and `policy` | explicit state transitions, waivers, policy packs, unknown handling |
| `artifacts` and `provenance` | normalized CI evidence and test-to-change relationships |
| `selection` and `history` | fail-closed recommendations and local JSONL trend records |
| `contracts` and `fixtures` | deterministic API contract and fixture/snapshot guards |
| `reporters` and `cli` | stable output and command orchestration |

## Compatibility rules

Existing commands (`check`, `test-integrity`, `impact`, `report`, `doctor`, `config`, and `usage`) remain available. The default policy is advisory, missing optional evidence remains visible as `UNKNOWN`, and baseline updates are only performed by an explicit `baseline init` or `baseline update` command. Reports retain the original summary, findings, impact, and test-integrity fields; new module results are optional.

No module may claim that static relationships prove runtime behavior. Runtime coverage and execution metadata are stronger than AST, import-graph, proximity, or naming heuristics, and each provenance record names the method and confidence used.

## Security and performance boundaries

The default CLI reads local files and Git history only. It does not upload source, call an LLM, emit telemetry, or require vendor integrations. GitHub API calls are confined to the existing Action’s optional Check Run/comment publishing path. Commands and analysis are bounded by configured file, finding, symbol, mutation, snapshot, and timeout limits. Cache keys, where added, must include repository identity, base/head revisions, config, policy, tool version, and adapter version.

Deferred modules must use this contract and documentation pattern before acquiring a public command. A design document is not a successful implementation and must not be wired into the Action as a placeholder.
