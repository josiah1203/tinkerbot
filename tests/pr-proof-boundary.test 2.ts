import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const ROOTS = ["packages/factory", "packages/tui", "apps/control-plane-worker"];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|js|sql|jsonc)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test("factory, TUI, and hosted worker stay free of pr-proof identifiers", () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(path.resolve(root))) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("pr-proof")) hits.push(file);
    }
  }
  expect(hits).toEqual([]);
});
