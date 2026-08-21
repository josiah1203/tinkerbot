export function buildFactoryStarter(input: {
  name: string;
  alias?: string;
  owner: string;
  repository: string;
  model?: string;
  harness?: string;
  integrations?: Array<"slack" | "linear" | "jira">;
}): { yaml: string; files: Array<{ path: string; contents: string }> } {
  const alias = input.alias?.trim() || input.name.replace(/[^A-Za-z0-9 ._-]/g, "-").slice(0, 60);
  const integrations = (input.integrations ?? []).map((type) => `  - type: ${type}`).join("\n");
  const defaults = input.harness
    ? `agentDefaults:\n  harness: ${input.harness}\n  runner: sandbox`
    : `agentDefaults:\n  model: ${input.model ?? "auto"}\n  runner: sandbox`;
  const yaml = [
    "schemaVersion: v1alpha1",
    `name: ${input.name}`,
    `alias: ${alias}`,
    "repositories:",
    `  - owner: ${input.owner}`,
    `    name: ${input.repository}`,
    defaults,
    integrations ? `integrations:\n${integrations}` : "",
  ].filter(Boolean).join("\n") + "\n";
  const files = [
    { path: ".tinkerbot/factory.yaml", contents: yaml },
    {
      path: ".tinkerbot/agents/foreman/agent.md",
      contents: "---\nagentType: FOREMAN\ndescription: Route work. Never merge. Never rewrite tb check.\n---\nYou are the Tinkerbot Foreman. Humans merge. tb check is the only verdict.\n",
    },
    {
      path: ".tinkerbot/runners/sandbox.yaml",
      contents: "name: sandbox\nplatform:\n  os: linux\n  linux:\n    dockerImage: cloudflare/sandbox:next\n",
    },
  ];
  return { yaml, files };
}
