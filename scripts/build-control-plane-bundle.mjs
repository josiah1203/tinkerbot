import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("..", import.meta.url);
const hostedSource = await readFile(new URL("packages/hosted-integrations/src/index.ts", root), "utf8");
const workerSource = await readFile(new URL("apps/control-plane-worker/src/index.ts", root), "utf8");

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: false,
      removeComments: false,
    },
  }).outputText;
}

const hosted = transpile(hostedSource, "packages/hosted-integrations/src/index.ts")
  .replace(/\bexport\s+(?=(?:async\s+)?(?:class|function|const|let|var)\b)/g, "");
const worker = transpile(workerSource, "apps/control-plane-worker/src/index.ts")
  .replace(/^import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/m, "")
  .replace(/^export default\s+/m, "const workerDefault = ");
const bundle = `${hosted}\n${worker}\nexport default workerDefault;\n`;

if (process.argv.includes("--check")) {
  new Function(bundle.replace(/export default workerDefault;\s*$/, ""));
  console.log(JSON.stringify({ valid: true, bytes: Buffer.byteLength(bundle), modules: ["hosted-integrations", "control-plane-worker"] }));
} else {
  process.stdout.write(bundle);
}
