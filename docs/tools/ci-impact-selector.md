# CI Impact Selector

## User problem

Repositories want a smaller early test batch without silently omitting tests when static impact evidence is incomplete.

## CLI and Action surface

The first deterministic slice is available as `pr-proof select-tests --base ... --head ...`. It produces a machine-readable recommendation only. The GitHub Action does not use it to skip required tests.

## Inputs and outputs

Inputs are Git revisions, the shared TypeScript/JavaScript impact graph, changed files/lines, configured confidence threshold, and test files at the head revision. Output classifies every discovered test as `selected`, `related`, `unrelated`, or `unknown`, with impacted files/symbols, confidence, reasons, and a full-suite fallback.

## Rules and unknowns

Runtime coverage and verified impact links are strongest. Dynamic imports, generated code, unresolved aliases, graph truncation, large diffs, and missing test files produce uncertainty and require the full suite. The selector never claims that a selected test set is complete proof.

## Security, false positives, and configuration

Selection reads local Git and repository files only. Low confidence can over-select tests; an incomplete graph can under-select them, which is why the default fails closed to the full suite. Configure `selection.confidence_threshold` and `selection.full_suite_on_unknown` explicitly.

## Fixtures and out of scope

Fixtures cover direct, indirect, shared-helper, parameterized, dynamic-import, generated, monorepo, and branch-specific coverage cases. Scheduling CI jobs, replacing required suites, remote test orchestration, and natural-language test intent are out of scope.
