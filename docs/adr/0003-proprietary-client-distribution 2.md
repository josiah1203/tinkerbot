# ADR 0003: Proprietary multi-channel client distribution

- Status: Accepted
- Date: 2026-08-18

## Decision

Tinkerbot distributes the same proprietary terminal client through an authorized private npm registry (npm and Bun), an approved Homebrew tap, and a checksum-verified curl installer. Release assets are compiled per platform, archived, checksummed, and represented by a generated manifest before they are made public.

## Consequences

- npm publication is restricted/private-registry only; `publishConfig.access` is `restricted` and public npm publishing is not a release step.
- Homebrew formulas are rendered from the release manifest so URLs and SHA-256 values cannot drift.
- The curl installer verifies its selected artifact against the manifest before extracting it.
- Signing identity, canonical download host, registry, and Homebrew tap are external release inputs. No unsigned or placeholder artifact is called a production release.
