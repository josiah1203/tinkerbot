#!/usr/bin/env node
import path from "node:path";
import { createLocalPlatformMcpContext, PLATFORM_MCP_HELP, runPlatformMcpStdio } from "./index";

export async function mainPlatformMcp(argv: string[] = process.argv.slice(2)): Promise<number> {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(PLATFORM_MCP_HELP);
      return 0;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        process.stderr.write("--root requires a path\n");
        return 3;
      }
      root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }
    process.stderr.write(`Unknown argument: ${arg}\n`);
    return 3;
  }
  try {
    await runPlatformMcpStdio(createLocalPlatformMcpContext(path.resolve(root)));
    return 0;
  } catch (error) {
    process.stderr.write(`platform MCP failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void mainPlatformMcp().then((code) => { process.exitCode = code; });
}
