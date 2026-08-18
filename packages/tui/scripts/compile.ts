import fs from "node:fs";
import path from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

type CompileTarget =
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64-musl"
  | "bun-linux-arm64-musl"
  | "bun-windows-x64"
  | "bun-windows-arm64";

const supportedTargets = new Set<CompileTarget>([
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-windows-x64",
  "bun-windows-arm64",
]);

function hostTarget(): CompileTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "bun-darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "bun-darwin-x64";
  if (process.platform === "win32" && process.arch === "arm64") return "bun-windows-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "bun-windows-x64";
  if (process.platform === "linux" && process.arch === "arm64") return process.env.OPENTUI_LIBC === "musl" ? "bun-linux-arm64-musl" : "bun-linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return process.env.OPENTUI_LIBC === "musl" ? "bun-linux-x64-musl" : "bun-linux-x64";
  throw new Error(`Unsupported Tinkerbot TUI compile host: ${process.platform}-${process.arch}`);
}

const requested = process.env.TINKERBOT_TUI_TARGET ?? hostTarget();
if (!supportedTargets.has(requested as CompileTarget)) throw new Error(`Unsupported Tinkerbot TUI target: ${requested}`);
const target = requested as CompileTarget;
const outputDirectory = path.resolve("../../dist/tui");
fs.mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `tb-${target.replace(/^bun-/, "")}${target.startsWith("bun-windows") ? ".exe" : ""}`);

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  compile: { target, outfile: output },
  plugins: [solidPlugin],
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Compiled Tinkerbot TUI executable for ${target}: ${output}`);
