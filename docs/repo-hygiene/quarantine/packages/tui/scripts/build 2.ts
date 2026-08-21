import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  // Keep the isolated source package separate while placing the distributable
  // bundle under the root package's existing dist/packages publish boundary.
  outdir: "../../dist/packages/tui",
  target: "bun",
  plugins: [solidPlugin],
  external: [
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-linux-x64-musl",
    "@opentui/core-win32-arm64",
    "@opentui/core-win32-x64",
  ],
  sourcemap: "external",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Built Tinkerbot TUI to dist/packages/tui");
