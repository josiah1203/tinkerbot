import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SandboxPort {
  start(input: { repositoryRoot: string; workOrderId: string; image?: string }): Promise<{ worktree: string; branch: string; cleanup: () => Promise<void> }>;
  exec(worktree: string, argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function dockerSandboxPort(execFn: typeof spawnSync = spawnSync): SandboxPort {
  return {
    async start(input) {
      const branch = `tinkerbot/${input.workOrderId.slice(0, 8)}`;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-sandbox-"));
      const probe = execFn("docker", ["info"], { encoding: "utf8", timeout: 8_000 });
      if ((probe.status ?? 1) !== 0) {
        fs.rmSync(worktree, { recursive: true, force: true });
        throw new Error("Docker is required for the local factory runner. process runner is opt-in via --allow-process-runner.");
      }
      try {
        fs.cpSync(input.repositoryRoot, worktree, { recursive: true, dereference: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && path.basename(src) !== "node_modules" });
      } catch {
        /* isolated empty worktree is still a sandbox; callers can exec into it */
      }
      return {
        worktree,
        branch,
        cleanup: async () => {
          fs.rmSync(worktree, { recursive: true, force: true });
        },
      };
    },
    async exec(worktree, argv, options) {
      const result = execFn("docker", ["run", "--rm", "-v", `${worktree}:/work`, "-w", "/work", "cloudflare/sandbox:next", ...argv], {
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 120_000,
        env: { ...process.env, ...options?.env },
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 };
    },
  };
}

export function processSandboxPort(allow: boolean, execFn: typeof spawnSync = spawnSync): SandboxPort {
  if (!allow) throw new Error("process runner requires --allow-process-runner.");
  return {
    async start(input) {
      const branch = `tinkerbot/${input.workOrderId.slice(0, 8)}`;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-process-"));
      return { worktree, branch, cleanup: async () => { fs.rmSync(worktree, { recursive: true, force: true }); } };
    },
    async exec(worktree, argv, options) {
      const result = execFn(argv[0] ?? "true", argv.slice(1), { cwd: worktree, encoding: "utf8", timeout: options?.timeoutMs ?? 60_000, env: { ...process.env, ...options?.env } });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 };
    },
  };
}

export function stubSandboxPort(): SandboxPort {
  return {
    async start(input) {
      const worktree = path.join(os.tmpdir(), `tinkerbot-stub-${crypto.randomUUID()}`);
      fs.mkdirSync(worktree, { recursive: true });
      return { worktree, branch: `tinkerbot/${input.workOrderId.slice(0, 8)}`, cleanup: async () => { fs.rmSync(worktree, { recursive: true, force: true }); } };
    },
    async exec() {
      return { stdout: "stub sandbox", stderr: "", exitCode: 0 };
    },
  };
}
