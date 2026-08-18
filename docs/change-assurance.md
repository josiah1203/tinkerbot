# Change assurance contract

The assurance expansion is a portable, source-minimized layer over the deterministic report. It uses schema `https://tinkerbot.dev/schemas/assurance/v1` and stable SHA-256 object IDs. The additive canonical evidence envelope uses `https://tinkerbot.dev/schemas/evidence/v1` and is documented in [`evidence-schema.json`](./evidence-schema.json).

## Authority and uncertainty

Deterministic parser, test, artifact, policy, and receipt checks are authoritative for their own evidence. Human-confirmed and imported records retain provenance. Advisory, inferred, partial, missing, stale, and unknown states are not silently converted to pass. Optional model explanations may describe structured evidence but cannot create findings, change severity/verdict, alter baselines/waivers, or open release gates.

## Receipts and replay

`tb proof create` writes a portable receipt containing repository/base/head references, changed-file and symbol fingerprints, tool/configuration versions, redacted commands, artifact hashes, evidence references, limits, partial/missing/unsupported states, and replay requirements. `tb proof verify` checks the canonical hash, applicability, expiry, artifacts, tool version, and configuration. `tb proof replay` performs a bounded dependency/tool/configuration preflight. Source and full diffs are excluded by default; signature metadata is provider-neutral and optional.

`tb evidence --format json` adds the evidence contract to a report; `--format change-assurance` preserves the legacy assurance bundle shape and adds the same envelope under `evidence`. Contract digests are calculated over a canonical payload, and optional explanations are advisory-only.

## Graph and behavioral coverage

Graph snapshots contain stable typed nodes and edges, deterministic duplicate removal, depth/node/edge limits, cycles that terminate, and explicit partial/unknown completeness. Behavioral coverage has independent dimensions for tests, execution, branches, mutation, contracts, fixtures, ownership, policy, rollback, and runtime. Ordinary line coverage is only one possible input and never stands in for the other dimensions.

## Contracts and lifecycle

`.tinkerbot/change-contract.yml` is optional. When present, deterministic scope drift checks cover allowed/forbidden paths, components, symbols, required tests/evidence/documentation/reviewers, rollback evidence, and release dependencies. Missing configuration is a distinct result. Finding lifecycle events are append-only and explain new, unchanged, resolved, regressed, waived, stale, invalidated, and unknown transitions. Head/base changes, source/fixture/test/policy/tool changes, artifact changes, and waiver expiry can invalidate or stale evidence.

## Agents, releases, and outcomes

Agent admission requires explicit identity, human initiator, workflow, permissions, changed-file/symbol budgets, approvals, and evidence. Authorship is never inferred from code style or commit language. Change Sets and Release Manifests represent cross-repository and release dependencies without merging, deploying, rolling back, evaluating flags, or claiming production correctness. Runtime outcomes distinguish observed facts, imported signals, human-confirmed associations, inferences, and unknown relationships; temporal proximity alone is not causality.
