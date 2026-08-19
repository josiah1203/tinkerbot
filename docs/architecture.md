# Architecture

Tinkerbot is a software production operating system. Cloudflare hosts the control plane when `controlPlane: hosted`. A local control plane (`packages/local-runtime`, `organizationId = local`) can run the same WorkOrder contracts offline. GitHub remains source control and merge authority. GitHub Actions are work cells for `tb check`. The deterministic engine is the quality laboratory woven through every stage.

```text
Organization → Portfolio → Product → Factory
  → Production line → Work cell → Work order
    → Run → Stage → Evidence → Decision → Outcome
```

Demand adapters (GitHub issues/PRs, GitLab MR/issues, Dependabot, code/secret scanning, Slack, Linear, Jira, MCP, incidents, support, roadmap, cron) normalize into a WorkOrder. The Foreman routes onto a versioned production line. It cannot invent workflows.

```text
Demand
  → Product intent
  → Specification and architecture
  → Work cell (Sandbox / Actions / branch)
  → Specialist agents
  → tb check (authoritative verdict)
  → Review / approval
  → Release candidate / deployment record / rollback
  → Outcome
  → Factory Steward (proposals only; humans activate)
```

## Non-negotiables

- `tb check` is the only verification verdict. Agents explain; they never rewrite findings, evidence, severity, or pass/fail.
- Humans merge. The GitHub App never merges, never uses `pull_request_target`, and never auto-merges factory-definition or skill PRs.
- Autonomy is risk-based (advisory, assisted, approval-gated, policy-autonomous, restricted). Formatting may open a PR autonomously; auth/billing/release stay restricted. Policy-autonomous still cannot merge.
- Factory Steward may propose versioned skills or definition changes. Activation requires a distinct human approver. The Steward cannot approve itself, lower standards, or train on raw customer source.

## Five systems

1. Demand — WorkOrder normalization
2. Production — lines and leased work cells
3. Quality — assurance checkpoints plus `tb check`
4. Delivery — PR, merge readiness, release candidates, GitHub Environment dispatch, rollback work orders, outcomes
5. Learning — Factory Analyst / Skill Builder / Evaluator / Reviewer / Release Steward

Customer production deploys are orchestrated and evidenced, not executed by Tinkerbot on the customer cluster.

The interactive terminal is `tb tui`: a tabbed master in `packages/tui` on a TTY, and a Node `--once` transcript for CI. Nested vendor CLIs are user-owned PTYs. The browser control tower remains `tb dashboard`. OpenTUI is isolated from the Node engine, Action, and hosted inference.
