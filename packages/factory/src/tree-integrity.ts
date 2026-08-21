import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface FactoryTreeIntegrityFile {
  path: string;
  contents: string;
}

export interface FactoryTreeIntegrityOptions {
  root?: string;
  requireTracked?: boolean;
  trackedPaths?: readonly string[];
  expectedDigest?: string;
  enforceSemanticUniqueness?: boolean;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Collapse the copy-suffix convention used by file managers and attachment
 * exports. It is deliberately applied to every path segment so `runners/foo
 * 2.toml` collides with the canonical `runners/foo.toml` as well.
 */
export function semanticFactoryTreePath(value: string): string {
  return normalizePath(value).split("/").map((segment) => segment.replace(/ \d+(?=\.[^.]+$|$)/g, "")).join("/");
}

export function factoryTreeDigestFromFiles(files: readonly FactoryTreeIntegrityFile[]): string {
  const canonical = [...files].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path))).map((file) => `${normalizePath(file.path)}\n${file.contents}`).join("\n---\n");
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function trackedFactoryTreePaths(root: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--", ".tinkerbot"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.split(/\r?\n/).map((value) => normalizePath(value.trim())).filter(Boolean);
  } catch {
    throw new Error("factory_tree_git_index_unavailable");
  }
}

export function assertFactoryTreeIntegrity(files: readonly FactoryTreeIntegrityFile[], options: FactoryTreeIntegrityOptions = {}): void {
  const exact = new Set<string>();
  const semantic = new Map<string, string>();
  for (const file of files) {
    const normalized = normalizePath(file.path);
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("invalid_factory_tree_path");
    if (exact.has(normalized)) throw new Error(`duplicate_factory_tree_path:${normalized}`);
    exact.add(normalized);
    const semanticPath = semanticFactoryTreePath(normalized);
    const prior = semantic.get(semanticPath);
    if (options.enforceSemanticUniqueness !== false && prior && prior !== normalized) throw new Error(`duplicate_factory_semantic_path:${prior}:${normalized}`);
    semantic.set(semanticPath, normalized);
  }

  if (options.requireTracked) {
    const tracked = new Set((options.trackedPaths ?? (options.root ? trackedFactoryTreePaths(options.root) : [])).map(normalizePath));
    for (const file of exact) if (!tracked.has(file)) throw new Error(`untracked_factory_tree_file:${file}`);
  }
  if (options.expectedDigest && factoryTreeDigestFromFiles(files) !== options.expectedDigest) throw new Error("factory_tree_digest_drift");
}

export function factoryTreeIntegritySummary(files: readonly FactoryTreeIntegrityFile[], root?: string): { digest: string; files: string[]; tracked: boolean } {
  const normalized = files.map((file) => ({ path: normalizePath(file.path), contents: file.contents }));
  const tracked = root ? new Set(trackedFactoryTreePaths(root)) : new Set<string>();
  return { digest: factoryTreeDigestFromFiles(normalized), files: normalized.map((file) => file.path), tracked: normalized.every((file) => tracked.has(file.path)) };
}

export function relativeFactoryTreePath(root: string, filePath: string): string {
  return normalizePath(path.relative(root, filePath));
}
