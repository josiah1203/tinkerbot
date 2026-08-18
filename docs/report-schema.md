# Report schema v1

The machine-readable report is a JSON object with `schemaVersion: 1` and the stable schema identifier `https://pr-proof.dev/schemas/report/v1`.

Top-level fields:

- `schemaVersion`, `schemaId`, `toolVersion`
- `repository`, `base`, `head`
- `verdict`: `PASS`, `NEEDS_REVIEW`, `UNKNOWN`, or `FAIL`
- `summary`
- `findings`
- `testIntegrity` and/or `impact`
- Optional `baseline`, `policy`, `provenance`, `artifacts`, `selection`, `contracts`, `fixtures`, and versioned `evidence` module results
- `limitations`

Every finalized finding includes:

- Stable `id` and `ruleId`
- `severity` and `category`
- `file`, `startLine`, and `endLine`
- `message`, `explanation`, and evidence
- `title` and `module`
- `suggestedAction` and `confidence`
- `fingerprint`, and optional `module`, `baselineState`, and evidence references
- `resolution`: `open`, `unknown`, `informational`, or `not_applicable`
- `toolVersion`, `baseSha`, and `headSha`

Findings are sorted by severity, file, line, and rule ID. Reports do not include timestamps, absolute paths, random IDs, or machine-specific values. Runtime measurements are written separately to `.pr-proof/usage.json`.

SARIF maps the same locations and preserves confidence, resolution, SHA, and suggested-action properties.

## Evidence contract

The additive `evidence` field follows [`evidence-schema.json`](./evidence-schema.json) (`https://tinkerbot.dev/schemas/evidence/v1`). It records repository, commit, and change identity; run and receipt IDs; tool and policy versions; configuration and evidence hashes; provenance; affected files/symbols; baseline and waiver references; freshness; and explicit `PASS`, `FAIL`, `UNKNOWN`, `STALE`, `SKIPPED`, or `NOT_APPLICABLE` states. `UNKNOWN` and `STALE` are never converted into `PASS`; `sourceUpload` and `diffUpload` are fixed to `not_uploaded`.

Optional explanations live in a separate advisory field and cannot alter the deterministic report verdict, findings, baseline, waivers, or release gates.
