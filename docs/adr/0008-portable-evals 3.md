# Portable personal evals

## Status

Accepted

## Context

Hosted `tinkerbot_benchmark_results` is a scalar table and must not be overloaded for personal regression suites.

## Decision

Portable evals use `EvalSuite` → `EvalTask` → `EvalAttempt` files under `.tinkerbot/evals/` and `tb eval init|add|run|compare|baseline|export`. Scorers set `upgradesVerdict: false` and remain advisory.

## Consequences

Eval YAML tracking is part of the factory-as-code reproducibility work, not a second gitignore hole.
