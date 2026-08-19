import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SandboxPort {
  start(input: { repositoryRoot: string; workOrderId: string; image?: string }): Promise<{ worktree: string; branch: string; cleanup: () => Promise<void> }>;
  exec(worktree: string, argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function dockerAvailable(execFn: typeof spawnSync = spawnSync): boolean {
  const probe = execFn("docker", ["info"], { encoding: "utf8", timeout: 8_000 });
  return (probe.status ?? 1) === 0;
}

function copyIsolatedWorktree(repositoryRoot: string, worktree: string): void {
  try {
    fs.cpSync(repositoryRoot, worktree, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base === "node_modules" || base === ".git") return false;
        return !src.includes(`${path.sep}node_modules${path.sep}`);
      },
    });
  } catch {
    /* empty worktree is still isolated */
  }
}

function createBranchWorktree(repositoryRoot: string, worktree: string, branch: string, execFn: typeof spawnSync): boolean {
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) return false;
  const created = execFn("git", ["-C", repositoryRoot, "worktree", "add", "-B", branch, worktree], { encoding: "utf8", timeout: 30_000 });
  return (created.status ?? 1) === 0;
}

export function dockerSandboxPort(execFn: typeof spawnSync = spawnSync): SandboxPort {
  return {
    async start(input) {
      if (!dockerAvailable(execFn)) {
        throw new Error("Docker is required for the local factory runner. process runner is opt-in via --allow-process-runner. Tests and CI use the stub sandbox when Docker is unavailable (TINKERBOT_STUB_SANDBOX=1).");
      }
      const branch = `tinkerbot/${input.workOrderId.slice(0, 8)}`;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-sandbox-"));
      fs.rmSync(worktree, { recursive: true, force: true });
      const usedGit = createBranchWorktree(input.repositoryRoot, worktree, branch, execFn);
      if (!usedGit) {
        fs.mkdirSync(worktree, { recursive: true });
        copyIsolatedWorktree(input.repositoryRoot, worktree);
      }
      return {
        worktree,
        branch,
        cleanup: async () => {
          if (usedGit) {
            execFn("git", ["-C", input.repositoryRoot, "worktree", "remove", "--force", worktree], { encoding: "utf8", timeout: 30_000 });
            execFn("git", ["-C", input.repositoryRoot, "branch", "-D", branch], { encoding: "utf8", timeout: 15_000 });
          }
          fs.rmSync(worktree, { recursive: true, force: true });
        },
      };
    },
    async exec(worktree, argv, options) {
      const image = "cloudflare/sandbox:next";
      const result = execFn("docker", ["run", "--rm", "--network", "none", "-v", `${worktree}:/work`, "-w", "/work", image, ...argv], {
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
      copyIsolatedWorktree(input.repositoryRoot, worktree);
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

export function selectLocalSandbox(input: { allowProcessRunner?: boolean; env?: NodeJS.ProcessEnv; execFn?: typeof spawnSync }): { sandbox: SandboxPort; warning?: string } {
  const env = input.env ?? process.env;
  const execFn = input.execFn ?? spawnSync;
  if (env.TINKERBOT_STUB_SANDBOX === "1" || (env.VITEST && env.TINKERBOT_STUB_SANDBOX !== "0")) {
    return { sandbox: stubSandboxPort(), warning: "Using stub sandbox (tests/CI). Set TINKERBOT_STUB_SANDBOX=0 to require Docker." };
  }
  if (input.allowProcessRunner) {
    return { sandbox: processSandboxPort(true, execFn), warning: "process runner is opt-in and is not isolated like Docker." };
  }
  if (dockerAvailable(execFn) && env.TINKERBOT_STUB_SANDBOX !== "1") {
    return { sandbox: dockerSandboxPort(execFn) };
  }
  return { sandbox: stubSandboxPort(), warning: "Docker is unavailable; using stub sandbox. Install Docker or pass --allow-process-runner." };
}
