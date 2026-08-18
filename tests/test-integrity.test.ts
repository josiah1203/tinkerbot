import { parseUnifiedDiff } from "../packages/git/src";
import { analyzeTestDiffs } from "../packages/test-integrity/src";

function diff(patch: string) {
  return parseUnifiedDiff(`diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts\n--- a/src/auth/session.test.ts\n+++ b/src/auth/session.test.ts\n${patch}`);
}

test("detects removed assertions, widened matchers, and disabled tests", () => {
  const result = analyzeTestDiffs(diff("@@ -2,5 +2,6 @@\n test(\"refreshes\", () => {\n-  expect(value).toBe(\"user-1\");\n+  expect(value).toBeTruthy();\n });\n+test.skip(\"revoked\", () => {});"), process.cwd());
  expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining(["assertion.removed", "matcher.weakened", "test.disabled"]));
});

test("does not flag an assertion-preserving safe refactor", () => {
  const result = analyzeTestDiffs(diff("@@ -2,3 +2,3 @@\n-test(\"old title\", () => {\n+test(\"new title\", () => {\n   expect(value).toEqual(expected);\n });"), process.cwd());
  expect(result.findings).toHaveLength(0);
});

test("detects tolerance widening and added todos", () => {
  const result = analyzeTestDiffs(diff("@@ -1,2 +1,2 @@\n-expect(value).toBeCloseTo(1, 4);\n+expect(value).toBeCloseTo(1, 2);\n+test.todo(\"add validation regression\");"), process.cwd());
  expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining(["tolerance.widened", "test.todo-added"]));
});
