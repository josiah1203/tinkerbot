import fs from "node:fs";
import path from "node:path";
import { parseUnifiedDiff } from "../packages/git/src";
import { analyzeTestDiffs } from "../packages/test-integrity/src";
import { finalizeReport } from "../packages/core/src";
import { renderJson, renderMarkdown, renderSarif } from "../packages/reporters/src";

test("runs the real test-integrity rule fixture matrix", () => {
  const root = path.resolve("fixtures/test-integrity");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as Array<{ name: string; rule: string | null; severity: string | null }>;
  for (const fixture of manifest) {
    const patch = fs.readFileSync(path.join(root, fixture.name, "patch.diff"), "utf8");
    const result = analyzeTestDiffs(parseUnifiedDiff(patch), root);
    if (!fixture.rule) expect(result.findings).toHaveLength(0);
    else {
      const finding = result.findings.find((item) => item.ruleId === fixture.rule);
      expect(finding, fixture.name).toBeDefined();
      expect(finding?.severity, fixture.name).toBe(fixture.severity);
      expect(finding?.file, fixture.name).toBe("tests/example.test.ts");
      expect(finding?.line, fixture.name).toBeGreaterThan(0);
      expect(finding?.message, fixture.name).toBeTruthy();
      expect(finding?.suggestedAction, fixture.name).toBeTruthy();
      const report = finalizeReport({ schemaVersion: 1, toolVersion: "0.1.0", repository: "fixture", base: "base-sha", head: "head-sha", verdict: "UNKNOWN", reviewAssessment: "NEEDS_HUMAN_REVIEW", summary: { assertionsWeakened: 1, newTests: 0, testsPassingOnBase: 0, changedLinesCoveredPercentage: null, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 0, downstreamConsumers: 0, impactedTests: 0, impactedPathsExecuted: 0, impactedPathsTotal: 0, unverifiedPaths: 0 }, findings: [finding!], limitations: [] });
      expect(renderJson(report)).toContain(`"ruleId": "${fixture.rule}"`);
      expect(renderMarkdown(report)).toContain(finding?.message ?? "");
      expect(renderSarif(report)).toContain(`"startLine": ${finding?.line}`);
    }
  }
});
