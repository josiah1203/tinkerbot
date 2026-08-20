import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SandboxPort {
  /** Identifies whether execution is isolated, host-process, or a test stub. */
  readonly kind?: "docker" | "process" | "stub";
  start(input: { repositoryRoot: string; workOrderId: string; image?: string }): Promise<{ worktree: string; branch: string; cleanup: () => Promise<void> }>;
  exec(worktree: string, argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number; stdin?: string; network?: "none" | "egress" }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function executionEnvironment(overrides?: Record<string, string>): Record<string, string> {
  // Never forward the invoking shell's environment wholesale. Provider keys and
  // session cookies commonly live there; only explicit harness bindings may cross
  // the execution boundary.
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/tinkerbot-home",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...overrides,
  };
}

export function dockerAvailable(execFn: typeof spawnSync = spawnSync): boolean {
  const probe = execFn("docker", ["info"], { encoding: "utf8", timeout: 8_000 });
  return (probe.status ?? 1) === 0;
}

function copyIsolatedWorktree(repositoryRoot: string, worktree: string): void {
  try {
    fs.cpSync(repositoryRoot, worktree, {
      recursive: true,
      // Never follow repository symlinks while creating an execution cell. A
      // link such as `node_modules/.cache -> $HOME` would otherwise copy host
      // secrets into the customer-run harness boundary.
      dereference: false,
      filter: (src) => {
        const base = path.basename(src);
        if (base === "node_modules" || base === ".git") return false;
        if (src.includes(`${path.sep}node_modules${path.sep}`)) return false;
        try {
          if (fs.lstatSync(src).isSymbolicLink()) return false;
        } catch {
          return false;
        }
        return true;
      },
    });
  } catch {
    /* empty worktree is still isolated */
  }
}

function removeExternalWorktreeLinks(worktree: string): void {
  const pending = [worktree];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const resolved = fs.realpathSync.native(fullPath);
          const relative = path.relative(worktree, resolved);
          if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fs.unlinkSync(fullPath);
        } catch {
          try { fs.unlinkSync(fullPath); } catch { /* cleanup is best effort */ }
        }
      } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        pending.push(fullPath);
      }
    }
  }
}

function assertSafeImage(image: string): string {
  const normalized = image.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/@:-]{0,255}$/.test(normalized) || normalized.includes("..")) throw new Error("Runner image is not a safe image reference.");
  return normalized;
}

function createBranchWorktree(repositoryRoot: string, worktree: string, branch: string, execFn: typeof spawnSync): boolean {
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) return false;
  const created = execFn("git", ["-C", repositoryRoot, "worktree", "add", "-B", branch, worktree], { encoding: "utf8", timeout: 30_000 });
  return (created.status ?? 1) === 0;
}

/**
 * A git worktree's `.git` file points at an absolute host path and is not
 * usable when the worktree is bind-mounted at `/work` in Docker. Clone the
 * local repository instead, copying objects rather than hard-linking them,
 * and restore the original remote URL for a harness that needs to push its
 * `tinkerbot/*` branch.
 */
function createContainerGitClone(repositoryRoot: string, worktree: string, branch: string, execFn: typeof spawnSync): boolean {
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) return false;
  const cloned = execFn("git", ["clone", "--local", "--no-hardlinks", "--no-recurse-submodules", repositoryRoot, worktree], { encoding: "utf8", timeout: 120_000 });
  if ((cloned.status ?? 1) !== 0) {
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
    return false;
  }
  const checked = execFn("git", ["-C", worktree, "checkout", "-B", branch], { encoding: "utf8", timeout: 30_000 });
  if ((checked.status ?? 1) !== 0) {
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
    return false;
  }
  const remote = execFn("git", ["-C", repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 15_000 });
  if ((remote.status ?? 1) === 0) {
    const value = String(remote.stdout ?? "").trim();
    if (value) {
      // Do not copy embedded HTTP credentials into the execution cell.
      let sanitized = value;
      try {
        const parsed = new URL(value);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        sanitized = parsed.toString();
      } catch { /* scp-style git remotes are already credential-free tokens */ }
      execFn("git", ["-C", worktree, "remote", "set-url", "origin", sanitized], { encoding: "utf8", timeout: 15_000 });
    }
  }
  return true;
}

export function dockerSandboxPort(execFn: typeof spawnSync = spawnSync): SandboxPort {
  const images = new Map<string, string>();
  return {
    kind: "docker",
    async start(input) {
      if (!dockerAvailable(execFn)) {
        throw new Error("Docker is required for the local factory runner. process runner is opt-in via --allow-process-runner. Tests and CI use the stub sandbox when Docker is unavailable (TINKERBOT_STUB_SANDBOX=1).");
      }
      const branch = `tinkerbot/${input.workOrderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "work"}`;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-sandbox-"));
      fs.rmSync(worktree, { recursive: true, force: true });
      const workspaceMode = createContainerGitClone(input.repositoryRoot, worktree, branch, execFn)
        ? "clone"
        : createBranchWorktree(input.repositoryRoot, worktree, branch, execFn) ? "worktree" : "copy";
      if (workspaceMode === "copy") {
        fs.mkdirSync(worktree, { recursive: true });
        copyIsolatedWorktree(input.repositoryRoot, worktree);
      } else removeExternalWorktreeLinks(worktree);
      images.set(worktree, assertSafeImage(input.image?.trim() || "cloudflare/sandbox:next"));
      return {
        worktree,
        branch,
        cleanup: async () => {
          if (workspaceMode === "worktree") {
            execFn("git", ["-C", input.repositoryRoot, "worktree", "remove", "--force", worktree], { encoding: "utf8", timeout: 30_000 });
            execFn("git", ["-C", input.repositoryRoot, "branch", "-D", branch], { encoding: "utf8", timeout: 15_000 });
          }
          images.delete(worktree);
          fs.rmSync(worktree, { recursive: true, force: true });
        },
      };
    },
    async exec(worktree, argv, options) {
      const image = images.get(worktree) ?? "cloudflare/sandbox:next";
      const network = options?.network === "egress" ? "bridge" : "none";
      const explicitEnv = options?.env ?? {};
      // `env` on spawnSync configures the Docker client, not the container.
      // Pass names with `--env` while keeping values out of the argv/process
      // list; Docker reads the values from the client's explicit environment.
      const envFlags = Object.keys(explicitEnv).flatMap((name) => ["--env", name]);
      const result = execFn("docker", ["run", "--rm", "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "2g", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", ...envFlags, "-v", `${worktree}:/work`, "-w", "/work", image, ...argv], {
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 120_000,
        input: options?.stdin,
        env: executionEnvironment(explicitEnv),
        maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 };
    },
  };
}

export function processSandboxPort(allow: boolean, execFn: typeof spawnSync = spawnSync): SandboxPort {
  if (!allow) throw new Error("process runner requires --allow-process-runner.");
  return {
    kind: "process",
    async start(input) {
      const branch = `tinkerbot/${input.workOrderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "work"}`;
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-process-"));
      if (!createContainerGitClone(input.repositoryRoot, worktree, branch, execFn)) {
        fs.mkdirSync(worktree, { recursive: true });
        copyIsolatedWorktree(input.repositoryRoot, worktree);
      } else removeExternalWorktreeLinks(worktree);
      return { worktree, branch, cleanup: async () => { fs.rmSync(worktree, { recursive: true, force: true }); } };
    },
    async exec(worktree, argv, options) {
      const result = execFn(argv[0] ?? "true", argv.slice(1), { cwd: worktree, encoding: "utf8", timeout: options?.timeoutMs ?? 60_000, input: options?.stdin, env: executionEnvironment(options?.env), maxBuffer: 2 * 1024 * 1024 });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), exitCode: result.status ?? 1 };
    },
  };
}

export function stubSandboxPort(): SandboxPort {
  return {
    kind: "stub",
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
