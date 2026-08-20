import { parse as parseYaml } from "yaml";
import { defaultModelForAgent } from "./warp";
import {
  assertHarnessWorkerHost,
  defaultHarnessDefinition,
  isExternalHarness,
  parseHarnessDefinitions,
  type FactoryHarnessDefinition,
} from "./harness";

export type { FactoryHarnessDefinition } from "./harness";

export const FACTORY_SCHEMA_V1ALPHA1 = "v1alpha1" as const;
export const FACTORY_SCHEMA_V1ALPHA2 = "v1alpha2" as const;
export const FORBIDDEN_HARNESS_TYPES = ["oz", "claude", "claude-code", "codex", "gemini"] as const;
export const ALLOWED_HARNESSES = ["tinkerbot-sandbox", "github_actions", "none", "default"] as const;
export const AGENT_TYPES = ["CUSTOM", "FOREMAN", "TRIAGE", "SPEC", "IMPLEMENT", "REVIEW", "VERIFY"] as const;
export const ACTIVITY_COLUMN_LABELS = {
  triage: "Triage",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  blocked: "Blocked",
  done: "Done",
} as const;

export type FactorySchemaVersion = "v1" | "v1alpha1" | "v1alpha2";
export type FactoryAgentType = (typeof AGENT_TYPES)[number];
export type FactoryCredentialStrategy = "EXECUTOR" | "CREATOR";
export type FactoryIntegrationType = "slack" | "linear" | "jira";
export type FactoryAutomationProvider = "github" | "gitlab" | "linear" | "jira" | "slack" | "schedule" | "factory" | "mcp" | "manual";

export interface FactoryAgentFile {
  id: string;
  agentType: FactoryAgentType;
  description?: string;
  model?: string;
  harness?: string;
  workerHost?: string;
  secrets: string[];
  mcpServers: string[];
  instructions: string;
}

export interface FactoryAutomationTrigger {
  provider: FactoryAutomationProvider;
  event: string;
  filter?: Record<string, string[]>;
  schedule?: { name?: string; cron: string };
}

export interface FactoryAutomationDefinition {
  name: string;
  enabled: boolean;
  agent: string;
  triggers: FactoryAutomationTrigger[];
  prompt: string;
}

export interface FactoryRunnerDefinition {
  name: string;
  description?: string;
  image: string;
  setupCommands: string[];
  platformOs: "linux" | "macos" | "windows";
  workerHost?: string;
  timeoutSeconds?: number;
}

export interface FactoryDashboardMetrics {
  opened: number;
  merged: number;
  blocked: number;
  waiting: number;
  autonomyShare: number | null;
  caption: string;
}

const ALIAS_PATTERN = /^[A-Za-z0-9 ._-]{1,60}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUNNER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/@:-]{0,255}$/;

function assertRunnerImage(value: string, context: string): string {
  const image = value.trim();
  if (!image || !RUNNER_IMAGE_PATTERN.test(image) || image.startsWith("-") || image.includes("..")) throw new Error(`${context} image must be a safe container image or local runner identifier.`);
  return image;
}

export function parseMarkdownDocument(contents: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: contents.trim() };
  const parsed = parseYaml(match[1]);
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return { frontmatter, body: match[2].trim() };
}

export function parseAlias(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const alias = value.trim();
  if (!ALIAS_PATTERN.test(alias)) throw new Error("Factory alias must be 1-60 characters: letters, numbers, spaces, '.', '_', or '-'.");
  return alias;
}

export function parseRepositories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const owner = typeof record.owner === "string" ? record.owner.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      return owner && name ? `${owner}/${name}` : "";
    }
    return "";
  }).filter((item) => item.length > 0);
}

export function assertAllowedHarness(value: unknown, context: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    const type = String((value as { type?: unknown }).type ?? "");
    if (!type) throw new Error(`${context} harness type is invalid.`);
    return assertAllowedHarness(type, context);
  }
  if (typeof value !== "string") throw new Error(`${context} harness is invalid.`);
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(normalized)) throw new Error(`${context} harness must be a safe identifier.`);
  if (!(ALLOWED_HARNESSES as readonly string[]).includes(normalized) && normalized !== "workers-ai" && isExternalHarness(normalized)) return normalized;
  return normalized === "workers-ai" ? "default" : normalized;
}

export function parseAgentType(value: unknown): FactoryAgentType {
  if (value == null || value === "") return "CUSTOM";
  const normalized = String(value).trim().toUpperCase();
  if (normalized === "MAIN") return "FOREMAN";
  if ((AGENT_TYPES as readonly string[]).includes(normalized)) return normalized as FactoryAgentType;
  throw new Error(`Unknown agentType: ${String(value)}`);
}

export function parseAgentFile(id: string, contents: string): FactoryAgentFile {
  const { frontmatter, body } = parseMarkdownDocument(contents);
  if (frontmatter.model != null && frontmatter.harness != null) throw new Error(`Agent ${id} cannot set both model and harness.`);
  const harness = assertAllowedHarness(frontmatter.harness, `Agent ${id}`);
  const workerHost = assertHarnessWorkerHost(frontmatter.workerHost, `Agent ${id}`);
  const secrets = Array.isArray(frontmatter.secrets) ? frontmatter.secrets.filter((item): item is string => typeof item === "string") : [];
  const mcpServers = mcpServerNames(frontmatter.mcpServers);
  return {
    id,
    agentType: parseAgentType(frontmatter.agentType),
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    model: typeof frontmatter.model === "string" ? (frontmatter.model === "auto" ? defaultModelForAgent(id) : frontmatter.model) : undefined,
    harness,
    workerHost,
    secrets,
    mcpServers,
    instructions: body,
  };
}

export function parseAutomationFile(name: string, contents: string): FactoryAutomationDefinition {
  const { frontmatter, body } = parseMarkdownDocument(contents);
  const triggersRaw = Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [];
  const triggers = triggersRaw.map((item, index) => parseTrigger(name, item, index));
  if (!triggers.length) throw new Error(`Automation ${name} requires at least one trigger.`);
  return {
    name,
    enabled: frontmatter.enabled !== false,
    agent: typeof frontmatter.agent === "string" && frontmatter.agent.trim() ? frontmatter.agent.trim() : "foreman",
    triggers,
    prompt: body,
  };
}

export function parseRunnerYaml(name: string, contents: string): FactoryRunnerDefinition {
  const parsed = parseYaml(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Runner ${name} must be a mapping.`);
  const raw = parsed as Record<string, unknown>;
  const platform = raw.platform && typeof raw.platform === "object" && !Array.isArray(raw.platform) ? raw.platform as Record<string, unknown> : {};
  const os = typeof platform.os === "string" ? platform.os : "linux";
  if (os !== "linux" && os !== "macos" && os !== "windows") throw new Error(`Runner ${name} platform.os must be linux, macos, or windows.`);
  const linux = platform.linux && typeof platform.linux === "object" && !Array.isArray(platform.linux) ? platform.linux as Record<string, unknown> : {};
  const image = assertRunnerImage(typeof linux.dockerImage === "string" && linux.dockerImage.trim() ? linux.dockerImage : typeof raw.image === "string" ? raw.image : os === "linux" ? "cloudflare/sandbox:next" : os, `Runner ${name}`);
  if (raw.setupCommands != null && !Array.isArray(raw.setupCommands)) throw new Error(`Runner ${name} setupCommands must be an array.`);
  const setupCommands = (Array.isArray(raw.setupCommands) ? raw.setupCommands : []).map((item, index) => {
    if (typeof item !== "string" || item.length > 4_096 || /[\u0000-\u001f\u007f]/.test(item)) throw new Error(`Runner ${name} setupCommands[${index}] contains invalid control data.`);
    return item;
  });
  if (setupCommands.length > 64) throw new Error(`Runner ${name} setupCommands cannot contain more than 64 commands.`);
  const timeoutRaw = raw.timeoutSeconds == null ? undefined : Number(raw.timeoutSeconds);
  if (timeoutRaw !== undefined && (!Number.isFinite(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > 86_400)) throw new Error(`Runner ${name} timeoutSeconds must be between 1 and 86400.`);
  return { name, description: typeof raw.description === "string" ? raw.description : undefined, image, setupCommands, platformOs: os, workerHost: assertHarnessWorkerHost(raw.workerHost, `Runner ${name}`), timeoutSeconds: timeoutRaw };
}

export function parseFactorySchemaVersion(raw: Record<string, unknown>): FactorySchemaVersion {
  if (raw.schemaVersion === FACTORY_SCHEMA_V1ALPHA2 || raw.schemaVersion === "v1alpha2") return "v1alpha2";
  if (raw.schemaVersion === FACTORY_SCHEMA_V1ALPHA1 || raw.schemaVersion === "v1alpha1") return "v1alpha1";
  const version = Number(raw.version ?? 1);
  if (version !== 1) throw new Error("Unsupported factory definition version.");
  return "v1";
}

export function parseIntegrations(raw: unknown): Array<{ type: FactoryIntegrationType }> {
  if (!Array.isArray(raw)) return [];
  const integrations = raw.map((item) => {
    const type = item && typeof item === "object" ? (item as { type?: unknown }).type : item;
    if (type !== "slack" && type !== "linear" && type !== "jira") throw new Error("Factory integrations type must be slack, linear, or jira.");
    return { type };
  });
  const trackers = integrations.filter((item) => item.type === "linear" || item.type === "jira");
  if (trackers.length > 1) throw new Error("A factory can use Linear or Jira, not both.");
  return integrations;
}

export function parseCredentialStrategy(value: unknown): FactoryCredentialStrategy {
  if (value == null || value === "") return "EXECUTOR";
  if (value === "EXECUTOR" || value === "CREATOR") return value;
  throw new Error("credentialStrategy must be EXECUTOR or CREATOR.");
}

export function parseAgentDefaults(raw: unknown): { model?: string; harness?: string; runner?: string; workerHost?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  if (record.model != null && record.harness != null) throw new Error("agentDefaults cannot set both model and harness.");
  const harness = assertAllowedHarness(record.harness, "agentDefaults");
  const workerHost = typeof record.workerHost === "string" ? record.workerHost : undefined;
  const normalizedWorkerHost = assertHarnessWorkerHost(workerHost, "agentDefaults");
  const model = typeof record.model === "string" ? record.model : undefined;
  return { model: model === "auto" ? undefined : model, harness, runner: typeof record.runner === "string" ? record.runner : undefined, workerHost: normalizedWorkerHost };
}

export function mcpServerNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>);
  return [];
}

export function agentFileId(relativePath: string): string | undefined {
  const nested = relativePath.match(/^\.tinkerbot\/agents\/([^/]+)\/agent\.md$/);
  if (nested) return nested[1];
  const flat = relativePath.match(/^\.tinkerbot\/agents\/([^/]+)\.md$/);
  return flat?.[1];
}

export function automationFileName(relativePath: string): string | undefined {
  return relativePath.match(/^\.tinkerbot\/automations\/([^/]+)\/automation\.md$/)?.[1];
}

export function runnerFileName(relativePath: string): string | undefined {
  return relativePath.match(/^\.tinkerbot\/runners\/([^/]+)\.ya?ml$/)?.[1];
}

export function applyFactoryTree<T extends {
  agents: Array<{ id: string; model: string; provider: "workers-ai" | "gateway" | "none"; harness: string; timeoutSeconds: number; agentType?: FactoryAgentType; description?: string; workerHost?: string; secretRefs?: string[]; mcpServers?: string[] }>;
  agentInstructions: Record<string, string>;
  secretRefs: string[];
  mcpServers: string[];
  sources: Array<{ type: string; enabled: boolean }>;
  harnesses: Record<string, FactoryHarnessDefinition>;
  automations?: FactoryAutomationDefinition[];
  runners?: FactoryRunnerDefinition[];
  alias?: string;
}>(definition: T, files: Array<{ path: string; contents: string }>): T {
  const nestedIds = new Set(files.map((file) => agentFileId(file.path)).filter((id): id is string => Boolean(id) && files.some((item) => item.path === `.tinkerbot/agents/${id}/agent.md`)));
  const agents = [...definition.agents];
  const instructions = { ...definition.agentInstructions };
  const secretRefs = [...definition.secretRefs];
  const mcpServers = [...definition.mcpServers];
  for (const file of files) {
    const id = agentFileId(file.path);
    if (!id) continue;
    if (nestedIds.has(id) && !file.path.endsWith("/agent.md")) continue;
    const parsed = parseAgentFile(id, file.contents);
    if (parsed.harness && isExternalHarness(parsed.harness) && !definition.harnesses[parsed.harness]) {
      definition.harnesses[parsed.harness] = defaultHarnessDefinition(parsed.harness);
    }
    instructions[id] = parsed.instructions;
    const existing = agents.findIndex((agent) => agent.id === id);
    const next = {
      id,
      model: parsed.model ?? (existing >= 0 ? agents[existing]!.model : defaultModelForAgent(id)),
      provider: (existing >= 0 ? agents[existing]!.provider : "workers-ai") as "workers-ai" | "gateway" | "none",
      harness: parsed.harness ?? (existing >= 0 ? agents[existing]!.harness : id === "implement" || id === "implementation" ? "tinkerbot-sandbox" : "default"),
      timeoutSeconds: existing >= 0 ? agents[existing]!.timeoutSeconds : 60,
      agentType: parsed.agentType,
      description: parsed.description,
      workerHost: parsed.workerHost ?? (existing >= 0 ? agents[existing]!.workerHost : undefined),
      secretRefs: parsed.secrets.map((secret) => secret.startsWith("secret://") || secret.startsWith("env:") ? secret : `secret://${secret}`),
      mcpServers: parsed.mcpServers,
    };
    if (existing >= 0) agents[existing] = next;
    else agents.push(next);
    for (const secret of parsed.secrets) {
      const ref = secret.startsWith("secret://") || secret.startsWith("env:") ? secret : `secret://${secret}`;
      if (!secretRefs.includes(ref)) secretRefs.push(ref);
    }
    for (const server of parsed.mcpServers) if (!mcpServers.includes(server)) mcpServers.push(server);
  }
  const automations = files.flatMap((file) => {
    const name = automationFileName(file.path);
    return name ? [parseAutomationFile(name, file.contents)] : [];
  });
  const runners = files.flatMap((file) => {
    const name = runnerFileName(file.path);
    return name ? [parseRunnerYaml(name, file.contents)] : [];
  });
  const sources = [...definition.sources];
  for (const automation of automations) {
    for (const trigger of automation.triggers) {
      const type = sourceTypeFromTrigger(trigger);
      if (type && !sources.some((source) => source.type === type)) sources.push({ type, enabled: automation.enabled });
    }
  }
  return { ...definition, agents, agentInstructions: instructions, secretRefs, mcpServers, sources, automations, runners };
}

export function sourceTypeFromTrigger(trigger: FactoryAutomationTrigger): string | undefined {
  if (trigger.provider === "github") return trigger.event.startsWith("pull_request") || trigger.event === "push" ? "github_pull_request" : trigger.event.startsWith("issue") ? "github_issue" : undefined;
  if (trigger.provider === "slack") return "slack";
  if (trigger.provider === "linear") return "linear";
  if (trigger.provider === "jira") return "jira";
  if (trigger.provider === "schedule") return "scheduled";
  if (trigger.provider === "mcp") return "mcp";
  if (trigger.provider === "manual") return "manual";
  if (trigger.provider === "gitlab") return trigger.event.includes("merge_request") || trigger.event === "Merge Request Hook" ? "gitlab_merge_request" : "gitlab_issue";
  return undefined;
}

export function automationMatches(automation: FactoryAutomationDefinition, event: { provider: string; event: string; repo?: string; labels?: string[]; channel?: string }): boolean {
  if (!automation.enabled) return false;
  return automation.triggers.some((trigger) => {
    if (trigger.provider !== event.provider || trigger.event !== event.event) return false;
    const filter = trigger.filter ?? {};
    if (filter.repos?.length && event.repo && !filter.repos.includes(event.repo)) return false;
    if (filter.labels?.length && !(event.labels ?? []).some((label) => filter.labels!.includes(label))) return false;
    if (filter.channels?.length && event.channel && !filter.channels.includes(event.channel)) return false;
    return true;
  });
}

export function factoryDashboardMetrics(input: { statuses: string[] }): FactoryDashboardMetrics {
  const opened = input.statuses.filter((status) => ["implementation", "review", "verification", "approval", "ready", "merged", "released"].includes(status)).length;
  const merged = input.statuses.filter((status) => status === "merged" || status === "released").length;
  const blocked = input.statuses.filter((status) => status === "blocked").length;
  const waiting = input.statuses.filter((status) => ["specification", "approval", "ready"].includes(status)).length;
  return {
    opened,
    merged,
    blocked,
    waiting,
    autonomyShare: null,
    caption: "Opened, merged, blocked, and waiting work. Hosted inference is included on your plan. Autonomy requires GitHub App merge history after install. Scorers cannot upgrade tb check.",
  };
}

function parseTrigger(automation: string, item: unknown, index: number): FactoryAutomationTrigger {
  const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const provider = String(record.provider ?? "");
  const event = String(record.event ?? "");
  if (!provider || !event) throw new Error(`Automation ${automation} trigger ${index} requires provider and event.`);
  if (!["github", "gitlab", "linear", "jira", "slack", "schedule", "factory", "mcp", "manual"].includes(provider)) throw new Error(`Automation ${automation} trigger provider is invalid.`);
  if (provider === "gitlab" && /pipeline|job|deployment|system/i.test(event)) throw new Error(`Automation ${automation} GitLab ${event} hooks are privileged and not intake.`);
  const filterRaw = record.filter && typeof record.filter === "object" && !Array.isArray(record.filter) ? record.filter as Record<string, unknown> : {};
  const filter = Object.fromEntries(Object.entries(filterRaw).map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : typeof value === "object" && value && Array.isArray((value as { in?: unknown }).in) ? ((value as { in: unknown[] }).in).map(String) : []]).filter((entry) => entry[1].length));
  const scheduleRaw = record.schedule && typeof record.schedule === "object" && !Array.isArray(record.schedule) ? record.schedule as Record<string, unknown> : undefined;
  const schedule = scheduleRaw && typeof scheduleRaw.cron === "string" ? { name: typeof scheduleRaw.name === "string" ? scheduleRaw.name : undefined, cron: scheduleRaw.cron } : undefined;
  return { provider: provider as FactoryAutomationProvider, event, filter: Object.keys(filter).length ? filter : undefined, schedule };
}
