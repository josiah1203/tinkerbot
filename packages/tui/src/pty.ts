import { spawn, type ChildProcess } from "node:child_process";
import type { AgentId } from "./agents";
import { spawnSpec } from "./agents";

export interface PtySpawnDeps {
  spawn?: typeof spawn;
}

export function attachAgentPty(id: AgentId, cwd: string, env: NodeJS.ProcessEnv, deps: PtySpawnDeps = {}): { process?: ChildProcess; error?: string; trust: string } {
  const spec = spawnSpec(id, cwd, env);
  if ("error" in spec) return { error: spec.error, trust: "Install the vendor CLI and complete its own login. Tinkerbot does not store OAuth tokens." };
  const run = deps.spawn ?? spawn;
  const child = run(spec.bin, spec.args, { cwd: spec.cwd, env, stdio: "inherit" });
  return { process: child, trust: spec.trust };
}
