# Release readiness

The factory source tree is not a hosted production release until Cloudflare, WorkOS, Stripe, and signing identities are provisioned and validated. GitHub App registration is an optional source-control adapter gate, not a prerequisite for core factory use.

The closure sequence and differentiation dependency rules are defined in
[ADR-0011](./adr/0011-hosted-production-closure-and-differentiation-sequencing.md).

| Area | Source status | Release gate |
| --- | --- | --- |
| Factory domain + CLI | local/hosted application spine implemented; Worker executor, Foreman admission/decision routing, bounded request parsing, scheduled maintenance, WorkOS sync, billing route, tenant-auth and routes, hosted assurance, provider intake routes, GitHub integration, signed self-hosted completion, factory graph persistence, workspace metadata, factory definition persistence, graph-derived read models, artifact persistence, Factory operations metadata, D1 projection, D1 telemetry, hosted D1 storage, evidence, and provider protocol boundaries extracted; 53 files / 337 tests green | commit staged canonical-tree cleanup; hosted URL/session issuance; one complete hosted lifecycle |
| Factory Workstation + local platform MCP | source, package bins, and tests | clean-install client smoke test; optional claude-code-kit dist build |
| Dashboard | Worker APIs + SPA; local in-memory backend is explicitly preview-only and production-mode static serving rejects API calls | production assets domain and graph-derived Worker API validation |
| Factory Graph projection authority | Memory/SQLite/D1 conformance, local replay checks, schema verifier, and opt-in scheduled read-only shadow sweep | run the staging shadow-read sweep for at least the accepted soak window with zero unexplained divergence |
| Cloudflare Workflow binding | `FACTORY_RUN` is declared in Wrangler, but the current `FactoryRunWorkflow` is not an official `WorkflowEntrypoint`/`WorkflowStep` implementation and no production caller creates Workflow instances; Queue → Foreman is the active path | implement the durable Workflow adapter with `step.do` and a runtime smoke test, or remove the unused binding before deployment claims |
| API boundary | typed WorkOrder list/detail/graph/mutation, run, and core collection contracts, including decision/steer acknowledgements, with Worker and CLI/TUI contract tests | extend the contract to remaining dashboard/MCP resources as those surfaces become release-critical |
| Worker type contract | Wrangler 4.124.0 config and a local `types` script exist, but the source still maintains hand-written `Env`/`FactoryEnv` shapes and manual queue/scheduled batch types | generate binding types after config changes and adopt the platform handler/event types before production deployment |
| Command observability | correlation-safe command telemetry plus a typed operational-signal ledger cover async/sync commit, replay, failure, latency, projection, delivery, shadow-read, and retention signals; both D1 ledgers have bounded cleanup | connect the D1/console signal path to the deployed telemetry sink and record retention/SLO evidence |
| Hosted executor | signed self-hosted path is the selected hosted contract; Cloudflare Sandbox is feature-gated and fails closed with a graph-visible block | prove one complete self-hosted lifecycle; Sandbox is not an alternate release path while disabled |
| Source tree | staged canonical cleanup and quarantine; current tree passes `pnpm verify:tree` | review/commit the staged cleanup and verify from a fresh checkout |
| Branch provenance | canonical `main` and parallel historical refs are inventoried | reconcile or archive divergent refs before treating the repository as single-source |
| GitHub App publisher (optional adapter) | implemented | App registration, private key, webhook URL |
| Action OIDC (optional adapter) | JWKS RS256 + installation required | App install + customer `id-token: write` |
| Billing | seat catalog, trial, grace | real Stripe Price IDs |
| CI matrix | ubuntu/macOS/Windows | live green run |
| Artifact signing | `"signed": false` | keys + workflow |

The spine is not yet production-authoritative. The application-level command
cutover is complete and locally verified. The remaining gates are release and
environment evidence, not an unimplemented local lifecycle authority.

Open gates are:

- repair the declared Cloudflare Workflow contract with an official
  `WorkflowEntrypoint`/`WorkflowStep` implementation and a real caller, or
  remove the unused binding and make Queue → Foreman the explicit hosted path;
- review and commit the staged canonical-tree cleanup, then run a fresh-checkout
  build and tree verification;
- run the graph replay/shadow-read soak against provisioned staging resources;
- prove one end-to-end hosted self-hosted lifecycle, including dispatch,
  signed completion, deterministic verification ingest, and reconciliation;
- provision and validate Cloudflare, WorkOS, Stripe, and signing identities;
- complete artifact signing and record live CI/provider evidence; and
- reconcile or archive divergent branches and worktrees under the policy in the
  [branch/source inventory](./repo-hygiene/branch-source-inventory.md).

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm release:dry-run
pnpm release:clients
pnpm verify:release-gates
```

`pnpm verify:release-gates` is intentionally a local evidence report. A
successful `local_pass_external_pending` result does not promote the ADR or
make the system production-authoritative; it prints the remaining staging,
provisioning, signing, branch, and decomposition gates.
