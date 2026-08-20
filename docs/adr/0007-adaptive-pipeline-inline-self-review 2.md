# Adaptive pipeline and inline self-review

## Status

Accepted

## Context

Regex-only Foreman skips were too coarse. Solo work wants fewer async waits without weakening verification or merge policy.

## Decision

A deterministic planner consumes diff size, restricted paths, impact/test-integrity uncertainty, and prior failure history. Policy still strips illegal skips (`autonomyAllowsSkip`; verification and release never skip). `pipeline: single_agent` emits a composite receipt and escalates in place to the multi-stage pipeline. `inline_self_review` may skip async specification wait for low-risk human solo work only. Agents cannot approve. Restricted, security, and release work cannot use inline self-review. `approvals.required` / `neverMerge` are unchanged.

## Consequences

Foreman recommendations are not policy. Scorers and LLM judges cannot upgrade `tb check`.
