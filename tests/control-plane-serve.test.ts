import path from "node:path";
import { resolveControlPlaneDirectory, safeControlPlaneFilePath } from "../packages/cli/src/serve";

test("local control-plane serving stays inside the preview directory", () => {
  const root = resolveControlPlaneDirectory(path.resolve("apps/control-plane"));
  expect(root).toBe(path.resolve("apps/control-plane"));
  expect(safeControlPlaneFilePath(root, "/index.html")).toBe(path.join(root, "index.html"));
  expect(safeControlPlaneFilePath(root, "/../package.json")).toBeNull();
  expect(safeControlPlaneFilePath(root, "/%E0%A4%A")).toBeNull();
});
