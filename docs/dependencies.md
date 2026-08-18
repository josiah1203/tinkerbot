# Dependency and license inventory

Direct dependencies are intentionally small and pinned in `package.json` and `pnpm-lock.yaml`:

| Package | Version | Use | License |
| --- | ---: | --- | --- |
| `typescript` | 5.9.3 | compiler API, build | Apache-2.0 |
| `yaml` | 2.9.0 | YAML configuration | ISC |
| `@types/node` | 22.20.1 | type definitions | MIT |
| `vitest` | 3.2.7 | test runner | MIT |

The lockfile records transitive dependencies and integrity hashes. Before publishing, run the organization’s approved dependency audit and license scanner against the packed artifact and lockfile. The dry-run release does not publish or claim a live audit result.
