import { assertCredentialRef } from "./runtime";

/** Harnesses owned by Tinkerbot or by the repository's verification workflow. */
export const BUILTIN_HARNESSES = ["tinkerbot-sandbox", "github_actions", "none", "default"] as const;

/** Well-known customer-owned harness aliases. They are never executed by a hosted Worker. */
export const EXTERNAL_HARNESSES = ["codex", "claude", "claude-code", "gemini", "oz", "warp", "warp-agent"] as const;

export type HarnessProtocol = "stdio-json" | "text";
export type HarnessNetwork = "none" | "egress";

export interface FactoryHarnessDefinition {
  id: string;
  /** Executable name or absolute path. It is always invoked without a shell. */
  command: string;
  args: string[];
  protocol: HarnessProtocol;
  /** Network is denied by default; `egress` is an explicit customer opt-in for provider-backed CLIs. */
  network?: HarnessNetwork;
  /** `local` or `self_hosted[:worker-id]`; hosted Workers reject external harness execution. */
  workerHost?: string;
  /** Environment variable -> credential reference. Values are never stored in a definition. */
  env: Record<string, string>;
  timeoutSeconds: number;
}

const HARNESS_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const COMMAND_PATTERN = /^[^\u0000-\u001f\u007f\s]+$/;
const WORKER_HOST_PATTERN = /^(local|self_hosted(?::[a-z0-9._-]{1,64})?|warp|github_actions|tinkerbot-sandbox)$/;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeHarnessId(value: unknown, context = "harness"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty identifier.`);
  const id = value.trim().toLowerCase();
  if (!HARNESS_ID_PATTERN.test(id)) throw new Error(`${context} must match ${HARNESS_ID_PATTERN.source}.`);
  return id;
}

export function isExternalHarness(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const id = value.trim().toLowerCase();
  return !(BUILTIN_HARNESSES as readonly string[]).includes(id);
}

export function isSelfHostedWorkerHost(value: unknown): boolean {
  return typeof value === "string" && /^self_hosted(?::[a-z0-9._-]{1,64})?$/.test(value.trim().toLowerCase());
}

export function assertHarnessWorkerHost(value: unknown, context: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !WORKER_HOST_PATTERN.test(value.trim().toLowerCase())) {
    throw new Error(`${context} workerHost must be local, self_hosted[:id], warp, github_actions, or tinkerbot-sandbox.`);
  }
  return value.trim().toLowerCase();
}

export function defaultHarnessDefinition(idInput: string): FactoryHarnessDefinition {
  const id = normalizeHarnessId(idInput);
  const command = id === "claude-code" ? "claude" : id === "warp" ? "warp-agent" : id;
  return { id, command, args: [], protocol: "stdio-json", env: {}, timeoutSeconds: 3_600 };
}

function parseCommand(value: unknown, context: string, fallback: string): string {
  const command = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (command.length > 256 || command.startsWith("-") || !COMMAND_PATTERN.test(command)) throw new Error(`${context} command must be a single executable token without control characters or shell syntax.`);
  return command;
}

function parseArgs(value: unknown, context: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${context} args must be an array of at most 64 strings.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) {
      throw new Error(`${context} args[${index}] contains invalid control data.`);
    }
    return item;
  });
}

function parseEnvironment(value: unknown, context: string): Record<string, string> {
  const raw = recordValue(value);
  const env: Record<string, string> = {};
  for (const [name, ref] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error(`${context} environment key '${name}' is invalid.`);
    if (["PATH", "HOME", "PWD", "LD_PRELOAD", "NODE_OPTIONS"].includes(name)) throw new Error(`${context} environment key '${name}' is reserved by the sandbox.`);
    if (typeof ref !== "string") throw new Error(`${context}.${name} must be a credential reference.`);
    env[name] = assertCredentialRef(ref, `${context}.${name}`) ?? "";
  }
  return env;
}

export function parseHarnessDefinition(idInput: string, rawInput: unknown): FactoryHarnessDefinition {
  const id = normalizeHarnessId(idInput, "harness id");
  const raw = recordValue(rawInput);
  const fallback = defaultHarnessDefinition(id);
  const protocol = raw.protocol == null ? fallback.protocol : raw.protocol;
  if (protocol !== "stdio-json" && protocol !== "text") throw new Error(`Harness ${id} protocol must be stdio-json or text.`);
  const network = raw.network == null ? "none" : raw.network;
  if (network !== "none" && network !== "egress") throw new Error(`Harness ${id} network must be none or egress.`);
  const timeoutSeconds = Number(raw.timeoutSeconds ?? fallback.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) throw new Error(`Harness ${id} timeoutSeconds must be between 1 and 86400.`);
  return {
    id,
    command: parseCommand(raw.command, `Harness ${id}`, fallback.command),
    args: parseArgs(raw.args, `Harness ${id}`),
    protocol,
    network,
    workerHost: assertHarnessWorkerHost(raw.workerHost, `Harness ${id}`),
    env: parseEnvironment(raw.env ?? raw.environment, `Harness ${id}.env`),
    timeoutSeconds,
  };
}

export function parseHarnessDefinitions(rawInput: unknown): Record<string, FactoryHarnessDefinition> {
  const raw = recordValue(rawInput);
  const definitions: Record<string, FactoryHarnessDefinition> = {};
  for (const [id, value] of Object.entries(raw)) {
    const normalized = normalizeHarnessId(id, "harness id");
    if ((BUILTIN_HARNESSES as readonly string[]).includes(normalized)) throw new Error(`Built-in harness '${normalized}' cannot be redefined.`);
    if (definitions[normalized]) throw new Error(`Harness '${normalized}' is defined more than once.`);
    definitions[normalized] = parseHarnessDefinition(normalized, value);
  }
  return definitions;
}

export function harnessCapability(idInput: string, definitions: Record<string, FactoryHarnessDefinition> = {}): {
  id: string;
  ownership: "tinkerbot" | "customer";
  execution: "managed" | "github_actions" | "none" | "local" | "self_hosted";
  requiresExplicitOptIn: boolean;
  configured: boolean;
} {
  const id = normalizeHarnessId(idInput);
  if (id === "none") return { id, ownership: "tinkerbot", execution: "none", requiresExplicitOptIn: false, configured: true };
  if (id === "github_actions") return { id, ownership: "tinkerbot", execution: "github_actions", requiresExplicitOptIn: false, configured: true };
  if ((BUILTIN_HARNESSES as readonly string[]).includes(id)) return { id, ownership: "tinkerbot", execution: "managed", requiresExplicitOptIn: false, configured: true };
  const definition = definitions[id];
  const workerHost = definition?.workerHost;
  return {
    id,
    ownership: "customer",
    execution: isSelfHostedWorkerHost(workerHost) ? "self_hosted" : "local",
    requiresExplicitOptIn: true,
    configured: Boolean(definition),
  };
}

export function validateHarnessBindings(input: { agents: Array<{ id: string; harness: string; workerHost?: string }>; harnesses: Record<string, FactoryHarnessDefinition>; controlPlane: string; runnerType: string; runtimeWorkerHost?: string }): string[] {
  const errors: string[] = [];
  for (const agent of input.agents) {
    if (!isExternalHarness(agent.harness)) continue;
    const binding = input.harnesses[agent.harness];
    if (!binding) {
      errors.push(`Agent ${agent.id} uses customer harness '${agent.harness}' without a harness definition.`);
      continue;
    }
    const selfHosted = input.controlPlane === "local" || (input.runnerType === "self_hosted" && isSelfHostedWorkerHost(input.runtimeWorkerHost));
    if (!selfHosted) errors.push(`Agent ${agent.id} uses customer harness '${agent.harness}'; hosted Workers require runner.type self_hosted or a local control plane.`);
    // A hosted self-hosted factory has one explicit worker identity. Reject a
    // harness/agent binding that points at a different worker so a queue or
    // HTTPS adapter cannot execute the reviewed definition on the wrong host.
    if (input.controlPlane === "hosted" && input.runnerType === "self_hosted") {
      const target = input.runtimeWorkerHost;
      if (!isSelfHostedWorkerHost(target)) continue;
      if (agent.workerHost && agent.workerHost !== target) errors.push(`Agent ${agent.id} workerHost must match runtime workerHost '${target}'.`);
      if (binding.workerHost && binding.workerHost !== target) errors.push(`Harness '${agent.harness}' workerHost must match runtime workerHost '${target}'.`);
    }
  }
  return errors;
}
