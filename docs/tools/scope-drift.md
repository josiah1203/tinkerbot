# Scope Drift Guard

## User problem

Teams need a deterministic signal when a pull request changes files outside an approved task scope without pretending that natural-language requirements are perfectly understood.

## CLI and Action surface

Planned: `pr-proof scope --spec scope.yml --base ... --head ...`. It is intentionally not shipped until the structured scope format and exclusion semantics are stable. It will not return placeholder success.

## Inputs and outputs

Inputs are a checked-in structured scope file, Git revisions, and optional generated-file metadata. Output is a normal report module with matched paths, excluded paths, out-of-scope findings, evidence, and unknowns.

## Rules and unknowns

Rules cover changed paths outside explicit include globs and changes that cannot be classified. Natural-language scope, unrecognized generated files, and missing specs are `UNKNOWN`.

## Security, false positives, and configuration

The spec is repository-controlled and must not execute commands. Exclusions should cover generated code, lockfiles, formatting, migrations, documentation, and test-only changes where appropriate. Broad globs create false negatives; narrow scopes create false positives.

## Fixtures and out of scope

Fixtures need nested scopes, renamed files, generated outputs, lockfiles, and documentation-only changes. Runtime intent inference, task-management integrations, and LLM interpretation are out of scope.
