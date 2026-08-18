# Policy packs

Policy is an explicit interpretation layer over deterministic evidence. It does not invent evidence and it cannot turn a heuristic relationship into runtime proof.

List packs:

```sh
pr-proof policy list
pr-proof policy list --format json
pr-proof policy explain public-api
```

Available packs:

| Pack | Intended use | Unknown handling |
| --- | --- | --- |
| `default` | Normal local development and advisory CI | advisory |
| `strict` | Repositories that explicitly gate incomplete evidence | fail |
| `public-api` | Public exports, API contracts, and downstream consumers | fail |
| `security-sensitive` | Authentication, authorization, token, credential, and security paths | fail |
| `database-change` | Migrations, schema, data-access, and rollback review | fail |
| `agent-authored-change` | Agent-assisted work where a receipt is context only | advisory |
| `monorepo` | Cross-package consumers and package-boundary impact | fail |

Configure a pack without changing the default:

```yaml
policy:
  pack: public-api
```

Blocking is still explicit. A pack can raise severity or require unknown evidence to be reviewed, but the repository must opt into blocking mode or set `baseline.fail_on_new: true` when that result should fail CI. `default` remains advisory. Path exclusions and future pack-specific limits belong in the configuration rather than hidden code.

Policy rationale and unknown handling are included in every finalized report under `policy`. The Action accepts the same choice with its `policy` input.
