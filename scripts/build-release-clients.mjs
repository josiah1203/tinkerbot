import { spawnSync } from "node:child_process";

const host = (() => {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const libc = process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : "";
  return `bun-${platform}-${process.arch}${libc}`;
})();

const targets = (process.env.TINKERBOT_TUI_TARGETS ?? host)
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);

if (targets.length === 0) throw new Error("Set TINKERBOT_TUI_TARGETS to one or more Bun compile targets.");

for (const target of targets) {
  const result = spawnSync("bun", ["--cwd", "packages/tui", "scripts/compile.ts"], {
    stdio: "inherit",
    env: { ...process.env, TINKERBOT_TUI_TARGET: target },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
