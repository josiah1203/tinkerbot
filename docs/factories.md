# Factories

A Tinkerbot factory is a standing workflow: a Foreman routes each work item through triage, specification, implementation, review, and verification. The factory does repetitive work. Your team stays in the loop at spec approval and merge. AI workers are optional: Git, `tb`, CI, `tb check`, and humans are enough.

`tb check` is the only verification verdict. Agents never merge. Seat billing is unchanged. Hosted Workers AI is the intelligence plane (routing hints, judges, Steward drafts), not the customer coding model. `@tinker` is the external command handle on GitHub/Slack/Jira/Linear.

## Definition as code

`tb factory init` inspects the repository and writes a conservative starter. `tb factory new` and `/app/factories/new` write a named starter `.tinkerbot` tree (MCP `create_factory` is the same payload). `tb factory validate` parses the tree. `tb factory check` compiles an immutable FactoryPlan. `tb factory plan` prints a dry-run ExecutionPlan and CostEstimate with no WorkOrder or branch. `tb factory sync` uploads it to the control plane. `tb run --local` starts a local run against SQLite (schema 14) + Docker. The process runner is opt-in (`--allow-process-runner`) and prints a warning. Tests and CI use a stub sandbox unless `TINKERBOT_STUB_SANDBOX=0`. When Docker is missing, the stub sandbox is used and documented on stderr. `tb eval` runs portable personal suites. Scorers never upgrade `tb check`. `tb dashboard --local` serves the control-plane SPA with a local SQLite adapter (`organizationId = local`). Optional outbox replay POSTs to `/runtime/sync` when you are logged in and `sync` is `hosted` or `manual`.

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

`factory.yaml` accepts the current `version: 1` shape, Warp-shaped `schemaVersion: v1alpha1`, and additive `schemaVersion: v1alpha2` with a `runtime` profile (`collaboration`, `controlPlane`, `pipeline`, `runner`, `inference.credentialRef`, `approval`, `sync`). Older schemas parse with hosted defaults. `agentDefaults` may set `model` or `harness`, not both. Allowed harnesses are `tinkerbot-sandbox`, `github_actions`, `none`, and `default`. Claude Code, Codex, Gemini, and Warp `oz` harnesses are rejected. BYOK is local-runner-only; YAML stores credential refs, never raw keys.

Agent Markdown uses YAML frontmatter (`agentType`, `model` or `harness`, `secrets`, `mcpServers`) plus a durable prompt body. Exactly one `FOREMAN` (`MAIN` is an alias) is required when the tree declares agent types. `VERIFY` review notes cannot change `tb check`.

Automations declare `triggers` (`github`, `gitlab`, `slack`, `linear`, `jira`, `schedule`, `mcp`, `manual`). Filters AND together. GitLab **merge request and issue** events are intake only; pipeline, job, deployment, and system hooks are rejected. Tinkerbot never merges a GitLab MR. Linear and Jira cannot both be attached. Filters choose which events start work; they do not expand what a running agent can reach.

## Lifecycle

Intake → Foreman → Triage → optional Spec (human approval by default) → Implement (Sandbox branch/PR) → Review (advisory; may request revision) → `tb check` on GitHub Actions (OIDC ingest; missing ingest is UNKNOWN) → human merge.

The org Inbox stays exception-first (`/exceptions` on the local dashboard) and is not a kanban. Aftercare/warranty records attach to every release; the maintenance line scans decay (stale deps, secret expiry, API/config drift, test decay, unowned services, stale waivers).

## Dashboard

`/app/factories/:id` is the factory operator surface: Dashboard (estimated COGS, not an invoice), Activity, Runs, Agents, Automations, Scorers, Self-improvement, Definition. `/app/factories/new` is the five-minute wizard. Agents, Automations, and Definition stay read-only. Steer remains on `/app/work/:id`. Scorers never upgrade a verdict. Self-improvement tasks cannot auto-merge. The Steward cannot self-approve.

## Factory MCP

`tb factory mcp` prints the MCP URL. Tools: `send_task`, `get_task`, `message_foreman`, `get_conversation`, `create_factory`. `get_task` with `startWorking` returns git commands to continue a `tinkerbot/*` branch locally. Agents still cannot merge from MCP.
