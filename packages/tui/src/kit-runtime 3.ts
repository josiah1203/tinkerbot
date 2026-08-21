import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeCodeKitRuntime {
  root: string;
  version?: string;
  packages: readonly ["@claude-code-kit/ui", "@claude-code-kit/ink-renderer"];
  rendererEntry: string;
  uiEntry: string;
  ready: boolean;
  reason: string;
}

export interface LoadedClaudeCodeKit extends ClaudeCodeKitRuntime {
  renderer: Record<string, unknown>;
  ui: Record<string, unknown>;
}

const KIT_PACKAGES = ["@claude-code-kit/ui", "@claude-code-kit/ink-renderer"] as const;

function packageVersion(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function defaultClaudeCodeKitRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env.TINKERBOT_CLAUDE_CODE_KIT_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const downloaded = path.join(os.homedir(), "Downloads", "claude-code-kit-main");
  if (fs.existsSync(downloaded)) return downloaded;
  return path.resolve(cwd, "claude-code-kit-main");
}

export function discoverClaudeCodeKit(root = defaultClaudeCodeKitRoot()): ClaudeCodeKitRuntime {
  const resolved = path.resolve(root);
  const rendererEntry = path.join(resolved, "packages", "ink-renderer", "dist", "index.js");
  const uiEntry = path.join(resolved, "packages", "ui", "dist", "index.js");
  const uiPackage = path.join(resolved, "packages", "ui", "package.json");
  const ready = fs.existsSync(rendererEntry) && fs.existsSync(uiEntry);
  return {
    root: resolved,
    version: packageVersion(uiPackage),
    packages: KIT_PACKAGES,
    rendererEntry,
    uiEntry,
    ready,
    reason: ready
      ? "Built claude-code-kit renderer and UI packages are available."
      : "Kit source was found, but its dist packages are not built; using the Tinkerbot-compatible fallback surface.",
  };
}

export function loadClaudeCodeKit(runtime = discoverClaudeCodeKit()): LoadedClaudeCodeKit | undefined {
  if (!runtime.ready) return undefined;
  try {
    // The kit is an optional UI runtime. It is deliberately loaded at the edge
    // so the verification engine, Worker, and non-TTY CLI never depend on it.
    const renderer = require(runtime.rendererEntry) as Record<string, unknown>;
    const ui = require(runtime.uiEntry) as Record<string, unknown>;
    return { ...runtime, renderer, ui };
  } catch {
    return undefined;
  }
}
