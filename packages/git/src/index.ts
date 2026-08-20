import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiffHunk, FileDiff } from "../../core/src/types";
import { redactSecrets, repositoryRelativePath, safeChildEnvironment, tokenizeCommand } from "../../core/src/safety";
import { isSupportedSourceFile, isTestFileForLanguage } from "../../language-core/src";

export interface GitContext {
  root: string;
  base: string;
  head: string;
  diffs: FileDiff[];
}

const GIT_TIMEOUT_MS = 30_000;
const REVISION_CACHE = new Map<string, string>();

export class GitCommandError extends Error {
  constructor(public readonly args: string[], public readonly status: number | null, public readonly stderr: string, message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

function gitRaw(args: string[], cwd: string, allowFailure = false, timeout = GIT_TIMEOUT_MS): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout, killSignal: "SIGTERM", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = redactSecrets(typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "");
  if (result.status === 0) return stdout;
  if (allowFailure) return "";
  const timeoutMessage = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "timed out" : result.signal ? `terminated by ${result.signal}` : `exited with ${String(result.status)}`;
  throw new GitCommandError(args, result.status, stderr, `git ${args.join(" ")} ${timeoutMessage}${stderr ? `: ${stderr.trim()}` : ""}`);
}

function git(args: string[], cwd: string, allowFailure = false): string {
  return gitRaw(args, cwd, allowFailure).trimEnd();
}

export function getRepoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function resolveRevision(revision: string, cwd: string): string {
  const key = `${path.resolve(cwd)}\0${revision}`;
  const cached = REVISION_CACHE.get(key);
  if (cached) return cached;
  const resolved = git(["rev-parse", "--verify", "--end-of-options", revision], cwd);
  if (REVISION_CACHE.size >= 128) REVISION_CACHE.delete(REVISION_CACHE.keys().next().value as string);
  REVISION_CACHE.set(key, resolved);
  return resolved;
}

export function listFilesAtRevision(revision: string, cwd: string): string[] {
  const resolved = resolveRevision(revision, cwd);
  const output = gitRaw(["ls-tree", "-r", "-z", "--name-only", resolved], cwd);
  return output.split("\0").map((line) => line.trim()).filter(Boolean);
}

export function readFileAtRevision(revision: string, file: string, cwd: string): string | undefined {
  const relative = repositoryRelativePath(cwd, file);
  if (relative === ".") return undefined;
  const resolved = resolveRevision(revision, cwd);
  try {
    return gitRaw(["show", `${resolved}:${relative}`], cwd, false, GIT_TIMEOUT_MS).replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
}

function parseCount(value: string | undefined): number {
  if (!value) return 1;
  return Number(value) || 0;
}

function parseHunkHeader(header: string): DiffHunk | undefined {
  const match = header.match(/^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/);
  if (!match?.groups) return undefined;
  return {
    oldStart: Number(match.groups.oldStart),
    oldCount: parseCount(match.groups.oldCount),
    newStart: Number(match.groups.newStart),
    newCount: parseCount(match.groups.newCount),
    header,
    lines: [],
  };
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const chunks: Buffer[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") { chunks.push(Buffer.from(body[index] ?? "")); continue; }
    const next = body[index + 1] ?? "";
    if (/^[0-7]{3}$/.test(body.slice(index + 1, index + 4))) {
      chunks.push(Buffer.from([Number.parseInt(body.slice(index + 1, index + 4), 8)]));
      index += 3;
    } else {
      const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"' };
      chunks.push(Buffer.from(escaped[next] ?? next));
      index += 1;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function diffHeaderPaths(line: string): { oldPath: string; path: string } | undefined {
  const body = line.slice("diff --git ".length);
  if (body.startsWith('"')) {
    const firstEnd = body.indexOf('" ', 1);
    if (firstEnd >= 0) {
      const first = decodeGitQuotedPath(body.slice(0, firstEnd + 1));
      const second = body.slice(firstEnd + 2).trim();
      const decodedSecond = decodeGitQuotedPath(second);
      if (first.startsWith("a/") && decodedSecond.startsWith("b/")) return { oldPath: first.slice(2), path: decodedSecond.slice(2) };
    }
  }
  const match = body.match(/^a\/(.+?) b\/(.+)$/);
  return match ? { oldPath: match[1]!, path: match[2]! } : undefined;
}

export function parseUnifiedDiff(raw: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  let current: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let newLine = 0;
  let oldLine = 0;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) {
      const match = diffHeaderPaths(line);
      if (!match) continue;
      current = {
        path: match.path,
        oldPath: match.oldPath,
        status: "modified",
        additions: 0,
        deletions: 0,
        changedLines: [],
        deletedLines: [],
        hunks: [],
        patch: line,
      };
      diffs.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) continue;
    current.patch += `\n${line}`;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("similarity index") || line.startsWith("rename from")) current.status = "renamed";
    else if (line.startsWith("@@ ")) {
      hunk = parseHunkHeader(line);
      if (!hunk) continue;
      current.hunks.push(hunk);
      newLine = hunk.newStart;
      oldLine = hunk.oldStart;
    } else if (hunk && line !== "\\ No newline at end of file") {
      hunk.lines.push(line);
      if (line.startsWith("+")) {
        current.additions += 1;
        current.changedLines.push(newLine);
        newLine += 1;
      } else if (line.startsWith("-")) {
        current.deletions += 1;
        current.deletedLines.push(oldLine);
        oldLine += 1;
      } else {
        newLine += 1;
        oldLine += 1;
      }
    }
  }
  return diffs;
}

export function getDiff(base: string, head: string, cwd: string): FileDiff[] {
  const resolvedBase = resolveRevision(base, cwd);
  const resolvedHead = resolveRevision(head, cwd);
  const raw = git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--unified=0", "--no-color", resolvedBase, resolvedHead, "--"], cwd);
  const diffs = parseUnifiedDiff(raw);
  const statusTokens = gitRaw(["-c", "core.quotePath=false", "diff", "--name-status", "--find-renames", "-z", resolvedBase, resolvedHead, "--"], cwd).split("\0").filter(Boolean);
  for (let index = 0; index < statusTokens.length;) {
    const status = statusTokens[index++] ?? "";
    const code = status[0];
    const oldPath = code === "R" || code === "C" ? statusTokens[index++] : undefined;
    const file = statusTokens[index++];
    if (!file) continue;
    const found = diffs.find((diff) => diff.path === file || diff.oldPath === file || diff.path === oldPath || diff.oldPath === oldPath);
    const mappedStatus: FileDiff["status"] = code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : code === "C" ? "copied" : "modified";
    if (found) {
      found.path = file;
      found.status = mappedStatus;
      if (oldPath) found.oldPath = oldPath;
    } else {
      diffs.push({ path: file, oldPath, status: mappedStatus, additions: 0, deletions: 0, changedLines: [], deletedLines: [], hunks: [], patch: "" });
    }
  }
  return diffs.sort((left, right) => `${left.path}:${left.status}`.localeCompare(`${right.path}:${right.status}`));
}

export function createGitContext(cwd: string, base: string, head: string): GitContext {
  const root = getRepoRoot(cwd);
  const resolvedBase = resolveRevision(base, root);
  const resolvedHead = resolveRevision(head, root);
  return { root, base: resolvedBase, head: resolvedHead, diffs: getDiff(resolvedBase, resolvedHead, root) };
}

export function isTestFile(file: string): boolean {
  return isTestFileForLanguage(file);
}

export function isSourceFile(file: string): boolean {
  return isSupportedSourceFile(file);
}

export function makeTempWorktree(root: string, revision: string): { directory: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-worktree-"));
  fs.rmSync(directory, { recursive: true, force: true });
  let attached = false;
  try {
    const result = spawnSync("git", ["worktree", "add", "--detach", directory, revision], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Unable to create a temporary worktree: ${redactSecrets(result.stderr || result.stdout || result.error?.message || "unknown Git error")}`);
    attached = true;
    const sharedNodeModules = path.join(root, "node_modules");
    const worktreeNodeModules = path.join(directory, "node_modules");
    if (fs.existsSync(sharedNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        fs.symlinkSync(sharedNodeModules, worktreeNodeModules, "dir");
      } catch {
        // Symlinks are an optional acceleration for local dependencies. Some
        // Windows runners deny link creation; the isolated worktree remains
        // valid without sharing node_modules.
      }
    }
    let cleaned = false;
    return {
      directory,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try { if (fs.lstatSync(worktreeNodeModules).isSymbolicLink()) fs.unlinkSync(worktreeNodeModules); } catch { /* already removed */ }
        if (attached) spawnSync("git", ["worktree", "remove", "--force", directory], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024 });
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort after Git cleanup */ }
      },
    };
  } catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function runCommandAtRevision(root: string, revision: string, command: string, timeoutSeconds: number, allowShellCommands = false): { status: number | null; timedOut: boolean; error?: string; signal?: string; stdout?: string; stderr?: string } {
  let worktree: ReturnType<typeof makeTempWorktree> | undefined;
  try {
    const args = allowShellCommands ? undefined : tokenizeCommand(command);
    worktree = makeTempWorktree(root, revision);
    const result = args
      ? spawnSync(args[0], args.slice(1), { cwd: worktree.directory, shell: false, env: safeChildEnvironment(), encoding: "utf8", timeout: timeoutSeconds * 1000, killSignal: "SIGTERM", maxBuffer: 8 * 1024 * 1024 })
      : spawnSync(command, { cwd: worktree.directory, shell: true, env: safeChildEnvironment(), encoding: "utf8", timeout: timeoutSeconds * 1000, killSignal: "SIGTERM", maxBuffer: 8 * 1024 * 1024 });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (result.status === null && result.signal === "SIGTERM");
    return { status: result.status, timedOut, signal: result.signal ?? undefined, error: result.error ? redactSecrets(result.error.message) : undefined, stdout: redactSecrets(result.stdout ?? ""), stderr: redactSecrets(result.stderr ?? "") };
  } catch (error) {
    return { status: null, timedOut: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  } finally {
    worktree?.cleanup();
  }
}
