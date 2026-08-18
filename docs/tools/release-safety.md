# Release Safety Gate

## User problem

Release owners need a review checklist for public API, migrations, flags, configuration, deployment-sensitive files, versioning, and rollback evidence.

## CLI and Action surface

Planned: `pr-proof release --base ... --head ...`. It will be added only with deterministic checks and real fixtures.

## Inputs and outputs

Inputs include Git revisions, package metadata, migration directories, feature-flag conventions, changelog/version files, deployment manifests, and optional rollback metadata. Output is a report with checklist items, findings, evidence references, and unknowns.

## Rules and unknowns

Rules identify public API changes, irreversible migrations, missing changelog/version updates, changed deployment configuration, and missing rollback metadata. Custom deployment systems and dynamic migration behavior are `UNKNOWN`.

## Security, false positives, and configuration

Do not run migrations or deploy commands. Repository-specific migration and flag paths must be explicit. A version bump may be intentional or generated, so the finding must include the exact evidence rather than assume risk.

## Fixtures and out of scope

Fixtures need reversible and irreversible migrations, flags, config changes, package exports, changelog updates, and rollback notes. Deployment execution, production access, and release publication are out of scope.
