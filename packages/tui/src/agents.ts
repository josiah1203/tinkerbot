import fs from "node:fs";
import path from "node:path";

export const AGENT_IDS = ["claude", "gemini", "codex", "cursor", "shell"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

const ENV_BINS: Record<Exclude<AgentId, "shell">, string> = {
  claude: "TINKERBOT_CLAUDE_BIN",
  gemini: "TINKERBOT_GEMINI_BIN",
  codex: "TINKERBOT_CODEX_BIN",
  cursor: "TINKERBOT_CURSOR_BIN",
};

const DEFAULT_BINS: Record<Exclude<AgentId, "shell">, string[]> = {
  claude: ["claude"],
  gemini: ["gemini"],
  codex: ["codex"],
  cursor: ["cursor", "agent"],
};

export interface DetectedAgent {
  id: AgentId;
  label: string;
  bin?: string;
  present: boolean;
  oauth: "child-cli";
  note: string;
}

function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
    if (process.platform === "win32" && fs.existsSync(`${candidate}.cmd`)) return `${candidate}.cmd`;
  }
  return undefined;
}

export function resolveAgentBin(id: AgentId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (id === "shell") return env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const override = env[ENV_BINS[id]];
  if (override) return which(override, env) ?? (fs.existsSync(override) ? override : undefined);
  for (const name of DEFAULT_BINS[id]) {
    const found = which(name, env);
    if (found) return found;
  }
  return undefined;
}

export function detectAgents(env: NodeJS.ProcessEnv = process.env): DetectedAgent[] {
  const labels: Record<AgentId, string> = {
    claude: "Claude Code",
    gemini: "Gemini CLI",
    codex: "Codex CLI",
    cursor: "Cursor Agent",
    shell: "Shell",
  };
  return AGENT_IDS.map((id) => {
    const bin = resolveAgentBin(id, env);
    return {
      id,
      label: labels[id],
      bin,
      present: Boolean(bin),
      oauth: "child-cli",
      note: id === "shell"
        ? "Nested $SHELL. Tinkerbot does not merge."
        : bin
          ? "Uses this CLI’s own OAuth. Tinkerbot does not store vendor tokens. Nested agents cannot write a tb check verdict."
          : `Not on PATH. Install the ${labels[id]} CLI or set ${id === "cursor" ? "TINKERBOT_CURSOR_BIN" : ENV_BINS[id]}.`,
    };
  });
}

const MERGE_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_PROMPT_DISABLED"];

export function agentSpawnEnv(id: AgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (id === "shell") return { ...env };
  const next: NodeJS.ProcessEnv = { ...env, TINKERBOT_NEVER_MERGE: "1" };
  for (const key of MERGE_ENV_KEYS) delete next[key];
  return next;
}

export function agentArgsForbidMerge(args: string[]): boolean {
  return !/\bgh(\.exe)?(\s+|$)|\bpr\s+merge\b/.test(args.join(" "));
}

export function spawnSpec(id: AgentId, cwd: string, env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[]; cwd: string; trust: string; env: NodeJS.ProcessEnv } | { error: string } {
  const bin = resolveAgentBin(id, env);
  if (!bin) return { error: `${id} CLI was not found on PATH. Tinkerbot does not log you into vendor accounts.` };
  const args: string[] = [];
  if (!agentArgsForbidMerge(args)) return { error: "Nested agent arguments cannot include merge." };
  return {
    bin,
    args,
    cwd,
    env: agentSpawnEnv(id, env),
    trust: id === "shell"
      ? "Nested PTY is user-owned. Tinkerbot will not merge. A raw terminal can still run gh pr merge if you could. tb check remains the only verdict."
      : "Nested agent PTY has merge tokens stripped. Tinkerbot will not merge. tb check remains the only verdict.",
  };
}
