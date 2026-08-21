import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface TuiLaunchOptions {
  base?: string;
  head?: string;
  config?: string;
  cwd?: string;
  repository?: string;
}

function entries(moduleDirectory: string, cwd: string): string[] {
  return [
    process.env.TINKERBOT_TUI_ENTRY,
    path.resolve(cwd, "dist/packages/tui/index.js"),
    path.resolve(cwd, "packages/tui/dist/index.js"),
    path.resolve(cwd, "packages/tui/src/index.tsx"),
    path.resolve(moduleDirectory, "../../../../dist/packages/tui/index.js"),
    path.resolve(moduleDirectory, "../../../tui/dist/index.js"),
    path.resolve(moduleDirectory, "../../tui/src/index.tsx"),
  ].filter((entry): entry is string => Boolean(entry && fs.existsSync(entry)));
}

export function runTui(options: TuiLaunchOptions = {}): number {
  const cwd = path.resolve(options.repository ?? options.cwd ?? process.cwd());
  const entry = entries(__dirname, cwd)[0];
  const runtime = process.env.TINKERBOT_TUI_RUNTIME || "bun";
  if (!entry) {
    process.stderr.write("Tinkerbot TUI is not built or available. Install Bun and run `pnpm --filter @tinkerbot/tui build`, or set TINKERBOT_TUI_ENTRY.\n");
    return 4;
  }
  const args = [entry];
  if (options.base) args.push("--base", options.base);
  if (options.head && options.head !== "HEAD") args.push("--head", options.head);
  if (options.config) args.push("--config", options.config);
  if (options.repository) args.push("--repository", options.repository);
  const cliPath = path.resolve(__dirname, "index.js");
  const environment = { ...process.env, TINKERBOT_CLI: fs.existsSync(cliPath) ? cliPath : process.env.TINKERBOT_CLI, TINKERBOT_CLI_RUNTIME: process.execPath };
  const result = spawnSync(runtime, args, { cwd, env: environment, stdio: "inherit", shell: false });
  if (result.error) {
    process.stderr.write(`Tinkerbot TUI could not start: ${result.error.message}\n`);
    return 4;
  }
  return result.status ?? 4;
}
