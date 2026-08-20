# Factories

A Tinkerbot factory is a standing workflow: a Foreman routes each work item through triage, specification, implementation, review, and verification. The factory does repetitive work. Your team stays in the loop at spec approval and merge. AI workers are optional: Git, `tb`, CI, `tb check`, and humans are enough.

## Factory Graph and migration

The Factory Graph is the shared source of truth behind the CLI, TUI, Control Plane, reports, and integrations. Its append-only ledger records lifecycle events with actor, organization, factory, correlation, policy, provenance, and external-reference metadata. Read projections keep deterministic verification, review, release, and outcome decisions as separate fields; a passing check is never an approval or release.

`packages/factory/src/graph.ts` defines the portable event, intent, task, worker-contract, receipt, external-reference, authority, economics, and integration-command contracts. Local SQLite and hosted D1 stores persist the same append-only events and materialize read projections without requiring a hosted account for local verification. A micro intent only needs why and expected behavior, while standard and strategic intents progressively require governance and outcome fields.

`tb factory status <work-order-id>` and `tb work graph <work-order-id>` reconstruct the local lifecycle and cost projection from the append-only ledger. `tb work approve <work-order-id>` records a human approval locally, and `tb outcome record --input outcome.json --work-order <work-order-id>` records a graph-backed observation (use `--outcome-status ... --mature` for explicit maturity). `tb intent "..."` starts an accountless micro intent; add `--intent-mode standard` or `--intent-mode strategic` for progressive governance and outcome fields, then use `tb work new "..."` to create the corresponding local work order.

The former GitHub App template is deprecated and retained for historical migration only. New GitHub, Slack, Jira, Linear, and webhook integrations use `@tinkerbot` commands and `ExternalReference` mapping rather than provider-owned task state. Customer-owned, least-privilege GitHub Actions remain supported for deterministic verification.

`tb check` is the only verification verdict. Agents never merge. Local run receipts now map to `worker.session_*`, `worker.claim_emitted`, `change.proposed`, and `evidence.receipt_created` graph events. Seat billing is unchanged. Hosted Workers AI is the intelligence plane (routing hints, judges, Steward drafts), not the customer coding model. `@tinker` is the external command handle on GitHub/Slack/Jira/Linear.

## Definition as code

`tb factory init` inspects the repository and writes a conservative starter. `tb factory new` and `/app/factories/new` write a named starter `.tinkerbot` tree (MCP `create_factory` is the same payload). `tb factory validate` parses the tree. `tb factory check` compiles an immutable FactoryPlan. `tb factory plan` prints a dry-run ExecutionPlan and CostEstimate with no WorkOrder or branch. `tb factory sync` uploads it to the control plane. `tb run --local` starts a local run against SQLite (schema 16) + Docker. Local runs emit canonical work-order, task-plan, verification, release-request, outcome-measurement, and cost events. The process runner is opt-in (`--allow-process-runner`) and prints a warning. Tests and CI use a stub sandbox unless `TINKERBOT_STUB_SANDBOX=0`. When Docker is missing, the stub sandbox is used and documented on stderr. `tb eval` runs portable personal suites. Scorers never upgrade `tb check`. `tb tui /graph <id>` and the master terminal `/graph <id>` are read-only graph views. `tb dashboard --local` serves the control-plane SPA with a local SQLite adapter (`organizationId = local`). Optional outbox replay POSTs to `/runtime/sync` when you are logged in and `sync` is `hosted` or `manual`.

```text
.tinkerbot/factory.yaml
.tinkerbot/agents/<name>.md          # or agents/<name>/agent.md
.tinkerbot/automations/<name>/automation.md
.tinkerbot/runners/*.yaml            # linux Cloudflare sandbox; sandbox.toml still loads
.tinkerbot/lines/*.yaml
.tinkerbot/skills/*.yaml
.tinkerbot/autonomy.yaml
.tinkerbot/evolution.yaml
```

`factory.yaml` accepts the current `version: 1` shape, Warp-shaped `schemaVersion: v1alpha1`, and additive `schemaVersion: v1alpha2` with a `runtime` profile (`collaboration`, `controlPlane`, `pipeline`, `runner`, `workerHost`, `inference.credentialRef`, `approval`, `sync`). Older schemas parse with hosted defaults. `agentDefaults` may set `model` or `harness`, not both. Built-in harnesses are `tinkerbot-sandbox`, `github_actions`, `none`, and `default`; customer-owned harness IDs such as Claude Code, Codex, Gemini, Warp, or an internal wrapper are supported only with a local or explicitly self-hosted execution boundary. Hosted Workers never execute customer harness commands. Hosted BYOK/local inference likewise requires `runner.type: self_hosted` plus `workerHost: self_hosted[:worker-id]`; YAML stores credential refs, never raw keys.

Agent Markdown uses YAML frontmatter (`agentType`, `model` or `harness`, `workerHost`, `secrets`, `mcpServers`) plus a durable prompt body. Exactly one `FOREMAN` (`MAIN` is an alias) is required when the tree declares agent types. `VERIFY` review notes cannot change `tb check`.

For a customer harness, define a command without shell interpolation and bind only credential references:

```yaml
harnesses:
  codex:
    command: codex
    args: ["--request", "${requestFile}", "--worktree", "${worktree}"]
    protocol: stdio-json
    env:
      OPENAI_API_KEY: env:OPENAI_API_KEY
agents:
  - id: implementation
    harness: codex
runtime:
  controlPlane: hosted
  runner:
    type: self_hosted
    workerHost: self_hosted:runner-1
  inference:
    mode: byok
    provider: openai
    credentialRef: env:OPENAI_API_KEY
```

`tb run --local --allow-external-harness` is the explicit local opt-in. Hosted mode publishes a credential-free handoff to the optional `SELF_HOSTED_WORK` queue; the worker must return through the existing deterministic verification/OIDC path. A queue handoff never grants merge, release, or verdict authority.

Automations declare `triggers` (`github`, `gitlab`, `slack`, `linear`, `jira`, `schedule`, `mcp`, `manual`). Filters AND together. GitLab **merge request and issue** events are intake only; pipeline, job, deployment, and system hooks are rejected. Tinkerbot never merges a GitLab MR. Linear and Jira cannot both be attached. Filters choose which events start work; they do not expand what a running agent can reach.

## Lifecycle

Intake → Foreman → Triage → optional Spec (human approval by default) → Implement (Sandbox branch/PR) → Review (advisory; may request revision) → `tb check` on GitHub Actions (OIDC ingest; missing ingest is UNKNOWN) → human merge.

The org Inbox stays exception-first (`/exceptions` on the local dashboard) and is not a kanban. Aftercare/warranty records attach to every release; the maintenance line scans decay (stale deps, secret expiry, API/config drift, test decay, unowned services, stale waivers).

## Dashboard

`/app/factories/:id` is the factory operator surface: Dashboard (estimated COGS, not an invoice), Activity, Runs, Agents, Automations, Scorers, Self-improvement, Definition. `/app/factories/new` is the five-minute wizard. Agents, Automations, and Definition stay read-only. Steer remains on `/app/work/:id`. Scorers never upgrade a verdict. Self-improvement tasks cannot auto-merge. The Steward cannot self-approve.

## Factory MCP

There are two MCP transports backed by the same Factory Graph:

- The hosted `/mcp` endpoint is selected by `tb factory mcp` after login. It exposes `send_task`, `get_task`, `message_foreman`, `get_conversation`, and `create_factory` for account-scoped work.
- The local platform server is newline-delimited JSON-RPC over stdio. Run `tinkerbot-mcp --root /path/to/repo` (or `tinkerbot-factory mcp serve --root /path/to/repo`) from an MCP client. It adds `factory_status`, `factory_check`, `intent_create`, `work_create`, `work_list`, `work_approve`, `graph_status`, and `outcome_record` while retaining the hosted tool names. Local state is `.tinkerbot/state.sqlite`, unless `TINKERBOT_LOCAL_DB` is set.

Example client configuration:

```json
{
  "mcpServers": {
    "tinkerbot-platform": {
      "command": "tinkerbot-mcp",
      "args": ["--root", "/absolute/path/to/repository"]
    }
  }
}
```

The separate `tinkerbot-factory` CLI delegates ordinary commands to the current `tb` implementation, so new factory, graph, outcome, evidence, runtime, and verification functions do not fork. `tinkerbot-tui` opens the kit-aware Factory Workstation. `TINKERBOT_CLAUDE_CODE_KIT_ROOT` can point at a built `claude-code-kit` checkout; the workstation deliberately falls back to its compatible terminal renderer when the supplied source-only checkout has no `dist` packages. `get_task` with `startWorking` returns git commands to continue a `tinkerbot/*` branch locally. Agents still cannot merge from MCP.
