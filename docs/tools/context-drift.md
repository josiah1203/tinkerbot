# Context Drift Guard

## User problem

Specifications, README claims, architecture references, API documentation, diagrams, configuration docs, and ownership references can become stale relative to code.

## CLI and Action surface

Planned: `pr-proof context --base ... --head ...`. It is deferred until deterministic link extraction is sufficiently reliable.

## Inputs and outputs

Inputs are repository docs, configured code references, symbol/export names, links, and Git revisions. Output would list stale links/claims with before/after evidence and confidence.

## Rules and unknowns

Deterministic links, paths, symbols, and configuration keys are authoritative inputs. Prose-only claims, diagrams without machine-readable references, and generated docs are `UNKNOWN`.

## Security, false positives, and configuration

Read-only scanning must not fetch remote URLs by default. Repositories need exclusions for generated docs and intentionally historical references. A changed implementation does not automatically mean a prose claim is wrong.

## Fixtures and out of scope

Fixtures need renamed symbols, stale links, updated docs, diagrams, generated documentation, and code ownership changes. Semantic truth of arbitrary prose and web crawling are out of scope.
