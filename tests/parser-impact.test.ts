import fs from "node:fs";
import path from "node:path";
import { buildGraph } from "../packages/parser/src";

test("builds import, export, call, route, and dynamic uncertainty nodes", () => {
  const root = path.resolve("fixtures/impact-analysis");
  const graph = buildGraph(root);
  expect(graph.modules.get("src/api/routes.ts")?.imports[0].resolvedFile).toBe("src/auth/session.ts");
  expect(graph.modules.get("src/auth/session.ts")?.exports).toContain("refreshSession");
  expect(graph.modules.get("src/api/routes.ts")?.references.some((reference) => reference.name === "refreshSession")).toBe(true);
  expect(graph.modules.get("src/api/routes.ts")?.routes[0].path).toBe("/session");
  expect(graph.modules.get("src/runtime.ts")?.dynamicReferences).toHaveLength(1);
  expect(fs.existsSync(path.join(root, "src/runtime.ts"))).toBe(true);
});
