# Dependency Impact Guard

## User problem

Dependency, lockfile, package-boundary, license, and runtime exposure changes can affect consumers beyond the edited source files.

## CLI and Action surface

Planned: `pr-proof dependencies --base ... --head ...`. It remains advisory until lockfile parsers and package-manager fixtures cover the supported ecosystems.

## Inputs and outputs

Inputs include lockfiles, manifest dependency sections, import graphs, package boundaries, license metadata when local, and Git revisions. Output would include direct/transitive changes, runtime versus development exposure, affected packages, and unknowns.

## Rules and unknowns

Rules cover direct dependency changes, lockfile drift, transitive changes known from the lockfile, package-boundary exposure, and missing license metadata. Unresolved registries, unsupported lockfiles, and dynamic runtime loading are `UNKNOWN`.

## Security, false positives, and configuration

The default path must not contact registries. Treat package manifests and lockfiles as untrusted input and bound parsing. License detection from incomplete local metadata can be wrong and must remain advisory.

## Fixtures and out of scope

Fixtures need npm/pnpm/yarn lockfiles, workspace packages, runtime/dev changes, transitive updates, license data, and malformed locks. Installation, vulnerability scanning, registry uploads, and automatic dependency updates are out of scope.
