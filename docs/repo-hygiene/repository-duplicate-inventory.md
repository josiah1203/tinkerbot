# Repository duplicate inventory

## Snapshot

- Repository: `main`
- Snapshot commit: `917a11b`
- Normalization: remove a trailing space plus numeric suffix (` 2`, ` 3`, or
  ` 4`) from each path component before grouping.
- Scope: all tracked repository paths, not only `.tinkerbot/`.
- Result: 1,201 tracked files; 211 duplicate semantic groups; 647 redundant
  paths; 192 groups were byte-identical and 19 groups contained divergent
  variants.

This inventory is the durable review record for the source-tree cleanup. The
canonical path is the normalized path without the numeric suffix. Identical
variants are safe to remove because their SHA-256 content is equal to the
canonical file. Divergent variants are not silently discarded; they are moved
to the repository-hygiene quarantine with their original content and paths so
they remain recoverable and reviewable.

The narrower [.tinkerbot inventory](./factory-tree-duplicate-inventory.md)
remains the detailed manifest for the Factory definition tree.

## Resolution policy

1. Keep exactly one canonical path in every source, migration, fixture, test,
   documentation, and asset tree.
2. Remove byte-identical numeric-suffix variants from the active tree.
3. Move divergent numeric-suffix variants to
   `docs/repo-hygiene/quarantine/` and resolve each as merged, discarded, or
   explicitly retained before any future cleanup.
4. Run `pnpm verify:tree` before build and typecheck so a copied attachment or
   generated duplicate cannot silently become a second implementation.

## Divergent groups

The following groups require quarantine rather than automatic deletion. The
hash is the canonical file's SHA-256; the quarantine operation records the
variant files and their original bytes in the worktree diff.

| Canonical path | Divergent variants | Hashes in group | Canonical SHA-256 |
| --- | --- | ---: | --- |
| `apps/control-plane-worker/migrations/0018_factory_graph_backfill.sql` | `0018_factory_graph_backfill 2.sql`, `0018_factory_graph_backfill 3.sql`, `0018_factory_graph_backfill 4.sql` | 2 | `b91d00d48b8d5be16edfa434591394c1b6f159650cb63f648821f26b995950ca` |
| `docs/README.md` | `README 2.md`, `README 3.md`, `README 4.md` | 2 | `522cd7842b65ba5bd3e992174673d8080f43fd05a52da9783f3a8f078811c5f0` |
| `docs/adr/README.md` | `README 2.md` | 2 | `d4be78ffa9c5bc2cf164e12af2b570d2d4d9c637017c0430bb6e91a0ee8bc701` |
| `packages/cli/src/factory-os.ts` | `factory-os 2.ts`, `factory-os 3.ts`, `factory-os 4.ts`, `factory-os 5.ts`, `factory-os 6.ts`, `factory-os 7.ts` | 2 | `e6b34bb6471d3383ba9a07d3091078cc39ce5b377f4b4b67b97616b1244302a7` |
| `packages/factory/src/control-plane-view.ts` | `control-plane-view 2.ts`, `control-plane-view 3.ts`, `control-plane-view 4.ts` | 2 | `7ffefa2fa157b0ab201fb2f014e0773c3ed81970803a281fbbd7b4d8e9759f1b` |
| `packages/factory/src/execute.ts` | `execute 2.ts`, `execute 3.ts`, `execute 4.ts` | 3 | `836ea3d475fd04fb62e64c6b20ed0736af785c5bc3657ca0f347dce724fe456c` |
| `packages/factory/src/graph.ts` | `graph 2.ts`, `graph 3.ts` | 2 | `13e9d7dd832128ab03477e3f2a69c15fa703c5281d1e0fdeb357fe14e0794b40` |
| `packages/factory/src/index.ts` | `index 2.ts` | 2 | `e7d456df6ce151bf09b47aec4e08659383d2d4054f6ed429a15129772ba4f831` |
| `packages/factory/src/lifecycle.ts` | `lifecycle 2.ts`, `lifecycle 3.ts`, `lifecycle 4.ts` | 3 | `16bfcb4b48caa49bea896159cffb5f3b83405e447189a3e9885c093522dd835f` |
| `packages/factory/src/spine.ts` | `spine 2.ts` | 2 | `03f87b0c040afbbfe181bf391a639d5880407aa6df9c29552b2424517f6e2437` |
| `packages/factory/src/store.ts` | `store 2.ts`, `store 3.ts`, `store 4.ts` | 3 | `2367f62c7d2516d0551a3845ac384729cc236e13ed34951977a86d27ed718423` |
| `packages/local-runtime/src/orchestrator.ts` | `orchestrator 2.ts`, `orchestrator 3.ts` | 3 | `ee7756db93cbcfc12b8e2c888fddc0d44fb39d9e4b0e478cdd50e645324bac9a` |
| `packages/local-runtime/src/sqlite-store.ts` | `sqlite-store 2.ts`, `sqlite-store 3.ts`, `sqlite-store 4.ts` | 3 | `502544580c37c389eb0bb35777ea0d9725f0a678fe41fcbbc817f07b69687496` |
| `pnpm-lock.yaml` | `pnpm-lock 2.yaml`, `pnpm-lock 3.yaml` | 2 | `b599390524f6f0745f3eb4bd156cc042f3e7fb930e428a1ad48ba34e4779f845` |
| `tests/control-plane-view.test.ts` | `control-plane-view.test 2.ts`, `control-plane-view.test 3.ts`, `control-plane-view.test 4.ts`, `control-plane-view.test 5.ts`, `control-plane-view.test 6.ts` | 2 | `9160ee4eb4b4b0b6eb7496316432daa3b5e68c9eb86db26da446c38bb158cc81` |
| `tests/factory-graph.test.ts` | `factory-graph.test 2.ts`, `factory-graph.test 3.ts`, `factory-graph.test 4.ts`, `factory-graph.test 5.ts` | 2 | `8e1d4f5e026d206ded5237f508ba116753d3e6701aea93702dd21c7383faa885` |
| `tests/factory-lifecycle.test.ts` | `factory-lifecycle.test 2.ts`, `factory-lifecycle.test 3.ts`, `factory-lifecycle.test 4.ts`, `factory-lifecycle.test 5.ts` | 2 | `4a16c19f719445ceaad470e430c11078048db552ba7f635cc0381031fb7562a3` |
| `tests/factory-worker.test.ts` | `factory-worker.test 2.ts`, `factory-worker.test 3.ts` | 2 | `6228b783182a75bb309a60cfedee5914868119fe3c781cb300aa2f774c68824` |
| `tests/local-runtime.test.ts` | `local-runtime.test 2.ts`, `local-runtime.test 3.ts`, `local-runtime.test 4.ts`, `local-runtime.test 5.ts` | 3 | `c8aa2aebe863a0056edc15ce7f0758e51403a82b5beaf995f653d2d86a3b3916` |

The original full path list and hashes remain recoverable from commit
`917a11b` and the subsequent cleanup diff. No unique variant is removed
without a durable path and hash record.

## Cleanup result

The current working tree has removed the 592 byte-identical active copies and
quarantined the 55 divergent variants plus six suffix artifacts that had no
canonical counterpart. The active source tree now passes `pnpm verify:source-tree`,
`pnpm verify:factory-tree`, and the repository typecheck. Quarantine remains
outside compiler and Factory-loader paths until each retained variant receives
an explicit merge, discard, or archive decision.
