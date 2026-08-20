import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ["mascot-island.tsx"],
  outfile: "mascot-island.js",
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  jsx: "automatic",
  logLevel: "info",
});

await build({
  absWorkingDir: root,
  entryPoints: ["component-library-preview.tsx"],
  outfile: "component-library-preview.js",
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  jsx: "automatic",
  logLevel: "info",
});

await build({
  absWorkingDir: root,
  entryPoints: ["teams-library-preview.tsx"],
  outfile: "teams-library-preview.js",
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  jsx: "automatic",
  logLevel: "info",
});

await build({
  absWorkingDir: root,
  entryPoints: ["tinkerbot-fonts.css"],
  outfile: "tinkerbot-fonts.bundle.css",
  bundle: true,
  assetNames: "fonts/[name]-[hash]",
  loader: { ".woff": "file", ".woff2": "file" },
  logLevel: "info",
});
