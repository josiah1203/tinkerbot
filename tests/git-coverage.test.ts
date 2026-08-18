import fs from "node:fs";
import path from "node:path";
import { parseUnifiedDiff } from "../packages/git/src";
import { parseGcov, parseIstanbulJson, parseLcov } from "../packages/coverage/src";

test("normalizes a unified diff to exact changed lines", () => {
  const diffs = parseUnifiedDiff("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;");
  expect(diffs[0].changedLines).toEqual([2]);
  expect(diffs[0].additions).toBe(1);
});

test("reads LCOV and Istanbul coverage artifacts", () => {
  const root = path.resolve("fixtures/test-integrity/head");
  const lcov = parseLcov(fs.readFileSync(path.join(root, "coverage/lcov.info"), "utf8"), root);
  expect(lcov.files["src/auth/session.ts"].lines[2]).toBe(1);
  const istanbul = parseIstanbulJson(JSON.stringify({ [path.join(root, "src/auth/session.ts")]: { statementMap: { "0": { start: { line: 2 }, end: { line: 2 } } }, s: { "0": 1 } } }), root);
  expect(istanbul.files["src/auth/session.ts"].lines[2]).toBe(1);
  const gcov = parseGcov("        -:    0:Source:src/auth/session.c\n        1:    2:int main()\n    #####:    3:return 0;\n", root);
  expect(gcov.format).toBe("gcov");
  expect(gcov.files["src/auth/session.c"].lines[2]).toBe(1);
});
