# Factories

A Tinkerbot factory is a standing workflow: a Foreman routes each work item through triage, specification, implementation, review, and verification. The factory does repetitive work. Your team stays in the loop at spec approval and merge.

`tb check` is the only verification verdict. Agents never merge. Seat billing is unchanged. Inference is Workers AI via AI Gateway.

## Definition as code

`tb factory new` and `/app/factories/new` write a starter `.tinkerbot` tree (MCP `create_factory` is the same payload). `tb factory validate` checks the tree. `tb factory sync` uploads it to the control plane.

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

`factory.yaml` accepts the current `version: 1` shape and Warp-shaped `schemaVersion: v1alpha1` (`alias`, `agentDefaults`, `repositories` as `owner`/`name`, `integrations`). `agentDefaults` may set `model` or `harness`, not both. Allowed harnesses are `tinkerbot-sandbox`, `github_actions`, `none`, and `default`. Claude Code, Codex, Gemini, and Warp `oz` harnesses are rejected.

Agent Markdown uses YAML frontmatter (`agentType`, `model` or `harness`, `secrets`, `mcpServers`) plus a durable prompt body. Exactly one `FOREMAN` (`MAIN` is an alias) is required when the tree declares agent types. `VERIFY` review notes cannot change `tb check`.

Automations declare `triggers` (`github`, `gitlab`, `slack`, `linear`, `jira`, `schedule`, `mcp`, `manual`). Filters AND together. GitLab **merge request and issue** events are intake only; pipeline, job, deployment, and system hooks are rejected. Tinkerbot never merges a GitLab MR. Linear and Jira cannot both be attached. Filters choose which events start work; they do not expand what a running agent can reach.

## Lifecycle

Intake → Foreman → Triage → optional Spec (human approval by default) → Implement (Sandbox branch/PR) → Review (advisory; may request revision) → `tb check` on GitHub Actions (OIDC ingest; missing ingest is UNKNOWN) → human merge.

The factory dashboard Activity view groups work as Triage, Planning, Building, Reviewing, Blocked, and Done. Org Inbox stays exception-first and is not a kanban.

## Dashboard

`/app/factories/:id` is the factory operator surface: Dashboard (estimated COGS, not an invoice), Activity, Runs, Agents, Automations, Scorers, Self-improvement, Definition. `/app/factories/new` is the five-minute wizard. Agents, Automations, and Definition stay read-only. Steer remains on `/app/work/:id`. Scorers never upgrade a verdict. Self-improvement tasks cannot auto-merge. The Steward cannot self-approve.

## Factory MCP

`tb factory mcp` prints the MCP URL. Tools: `send_task`, `get_task`, `message_foreman`, `get_conversation`, `create_factory`. `get_task` with `startWorking` returns git commands to continue a `tinkerbot/*` branch locally. Agents still cannot merge from MCP.
