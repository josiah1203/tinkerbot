# Factory tree duplicate inventory

## Snapshot

- Scope: `.tinkerbot/`
- Repository: `main`
- HEAD: `6357d73`
- Inventory method: enumerate hidden files, normalize a trailing ` 2`, ` 3`,
  or ` 4` suffix before the extension, and compare SHA-256 content hashes.
- Result: 102 files resolve to 29 semantic paths. Twenty-five semantic paths
  have 73 duplicate files. Every duplicate below is tracked and
  byte-identical to its canonical counterpart.
- Resolution: canonical files are retained; duplicates are explicitly
  flagged for human cleanup approval. No file was deleted or moved while
  creating this inventory.

## Duplicate groups

| Canonical path | Duplicate paths | SHA-256 |
| --- | --- | --- |
| `.tinkerbot/agents/foreman.md` | `foreman 2.md`, `foreman 3.md`, `foreman 4.md` | `190628eeeedc302d3a4f486014711666d7d4cb0288f1bb886db8dff11a3cf809` |
| `.tinkerbot/agents/implement.md` | `implement 2.md`, `implement 3.md`, `implement 4.md` | `8fe080d1c553814b35cf654b2f3a54df0d768b4af45cec5ac28b2d3ff39dcda5` |
| `.tinkerbot/agents/review.md` | `review 2.md`, `review 3.md`, `review 4.md` | `2e4b39ae3cae482b66d3569fd117889b97f43d5edbbcdf2ba464b77c5441f8ec` |
| `.tinkerbot/agents/spec.md` | `spec 2.md`, `spec 3.md`, `spec 4.md` | `d6ab605b8725363fa3ab06ba2bc9aeb0e3aa8a73b917cb77061ceab613387d5e` |
| `.tinkerbot/agents/specification.md` | `specification 2.md`, `specification 3.md`, `specification 4.md` | `6252ed6926edcb5c06beed330e98725b2e622fb52643ecc6f689a1928db64ba4` |
| `.tinkerbot/agents/triage.md` | `triage 2.md`, `triage 3.md`, `triage 4.md` | `c97e8edcef88f00d4835d316fd6f4269bfc0dcf5ec48ee5ab40b284f6b1c0913` |
| `.tinkerbot/automations/labeled-issue/automation.md` | `automation 2.md` | `86888fc1f6c2e1aa66a1c0e413365775557dacdee89f72b3023b05908a22cfeb` |
| `.tinkerbot/lines/bugfix.yaml` | `bugfix 2.yaml`, `bugfix 3.yaml`, `bugfix 4.yaml` | `48f8f7a3a917051f9c44fbc9748c636ce3253e483f390b5da545c89bcc83a55f` |
| `.tinkerbot/lines/dependency.yaml` | `dependency 2.yaml`, `dependency 3.yaml`, `dependency 4.yaml` | `9aa2d88a8a1180ec0e67c2170038c15ace5bd17b6b69d0ccb5c1b90493f0d533` |
| `.tinkerbot/lines/feature.yaml` | `feature 2.yaml`, `feature 3.yaml`, `feature 4.yaml` | `e1fe673426b639e61fc214a1fe042bddbe3c88d5fb2080dbeb9721e3eb73fb9f` |
| `.tinkerbot/lines/incident.yaml` | `incident 2.yaml`, `incident 3.yaml`, `incident 4.yaml` | `b661895e892cd24012c8caa0a47961db2f6185d7d9ba8708772e984016715727` |
| `.tinkerbot/lines/maintenance.yaml` | `maintenance 2.yaml`, `maintenance 3.yaml`, `maintenance 4.yaml` | `98a78002c252fb90e4b01028b953804f076b3eda01a76da9ead2936d0f104583` |
| `.tinkerbot/lines/migration.yaml` | `migration 2.yaml`, `migration 3.yaml`, `migration 4.yaml` | `44f23c8e7cbf35f6dbbce814af624d4fcc0a6f44c0e14b32e6d30d8c104e0e57` |
| `.tinkerbot/lines/refactor.yaml` | `refactor 2.yaml`, `refactor 3.yaml`, `refactor 4.yaml` | `f5a0b6e30e641313e41dd2165df226fcd8853f0ea90d8c17e56186c42441c5d9` |
| `.tinkerbot/lines/release.yaml` | `release 2.yaml`, `release 3.yaml`, `release 4.yaml` | `ba7dff250cb57dfb2fa5c70d5e537996964c6ac4ce9947ec8fbe14e382486863` |
| `.tinkerbot/lines/security.yaml` | `security 2.yaml`, `security 3.yaml`, `security 4.yaml` | `1d74ad6b09860ef8dfb5cadc5db79ea1e915ea5a7330cf2fe9a8b8382ad92a57` |
| `.tinkerbot/runners/sandbox.toml` | `sandbox 2.toml`, `sandbox 3.toml`, `sandbox 4.toml` | `413cd6ee8093dd7a947346f6b3000d850623624ce675f65c0c303eb1b445cb72` |
| `.tinkerbot/runners/sandbox.yaml` | `sandbox 2.yaml`, `sandbox 3.yaml`, `sandbox 4.yaml` | `8c9a35b44d34453966b80676fe29cf38dca4feb853e4a3025cbc728bbe431c27` |
| `.tinkerbot/skills/evaluator.yaml` | `evaluator 2.yaml`, `evaluator 3.yaml`, `evaluator 4.yaml` | `831fac1d6d923a93b638d4455ddab56b8d7996f7df27b0d527c6b3dba6da93fa` |
| `.tinkerbot/skills/factory-analyst.yaml` | `factory-analyst 2.yaml`, `factory-analyst 3.yaml`, `factory-analyst 4.yaml` | `4f40c9408ae05667ea4775f1913a2b82864443b5fce8bb9ac23e27e625345815` |
| `.tinkerbot/skills/implementer.yaml` | `implementer 2.yaml`, `implementer 3.yaml`, `implementer 4.yaml` | `33913ad416009f4475e3037b189b93405c7129302ac567a80163501c33883158` |
| `.tinkerbot/skills/release-steward.yaml` | `release-steward 2.yaml`, `release-steward 3.yaml`, `release-steward 4.yaml` | `a34e2f13c44c9b8d133ccbae0c7360fb8c6a91dee3a498da1c700aea7a0fe5c9` |
| `.tinkerbot/skills/skill-builder.yaml` | `skill-builder 2.yaml`, `skill-builder 3.yaml`, `skill-builder 4.yaml` | `509e1dadb3a0cd049e04bca784ba7a772adffb7c6c2bef5725e35774792ba454` |
| `.tinkerbot/skills/verification.md` | `verification 2.md`, `verification 3.md`, `verification 4.md` | `81ff2e59fea951b406be2ce61a79302867b29d57447b91d8fad72b9e8d7e098d` |
| `.tinkerbot/skills/verification.yaml` | `verification 2.yaml`, `verification 3.yaml`, `verification 4.yaml` | `44b1e4abc01b0a93e3c7b6f787466dd014bb4032998b1914168065b9bb0590ea` |

The four `.tinkerbot/` files with no duplicate in this snapshot are
`product.yaml`, `evolution.yaml`, `autonomy.yaml`, and `factory.yaml`.
