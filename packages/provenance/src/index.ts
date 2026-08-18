import fs from "node:fs";
import path from "node:path";
import type { FileDiff, ImpactReport, ProvenanceRecord } from "../../core/src/types";
import { languageForFile } from "../../language-core/src";

function testNames(root: string, file: string): string[] {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) return [];
  const source = fs.readFileSync(absolute, "utf8");
  const language = languageForFile(file);
  if (language === "python") return [...source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]!).slice(0, 50);
  if (language === "go") return [...source.matchAll(/^\s*func\s+(Test[A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]!).slice(0, 50);
  if (language === "rust") return [...source.matchAll(/^\s*fn\s+(test_[A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]!).slice(0, 50);
  if (language === "c" || language === "cpp") return [...source.matchAll(/\b(?:TEST|TEST_F|TEST_CASE|SCENARIO)\s*\(\s*([^,)]+)/g)].map((match) => match[1]!.trim()).slice(0, 50);
  return [...source.matchAll(/\b(?:test|it|specify)\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]).slice(0, 50);
}

export function buildProvenance(root: string, diffs: FileDiff[], impact: ImpactReport): ProvenanceRecord[] {
  const linesByFile = new Map(diffs.map((diff) => [diff.path, diff.changedLines]));
  const records: ProvenanceRecord[] = [];
  for (const pathImpact of impact.paths) {
    for (const testFile of pathImpact.testFiles) {
      const changedLines = linesByFile.get(pathImpact.sourceFile) ?? [];
      const coveredLines = pathImpact.coverageLines ?? [];
      const hasCoverage = coveredLines.length > 0;
      const unresolved = pathImpact.verificationState === "unknown" || pathImpact.classification === "runtime_unknown";
      const method = unresolved ? "unresolved" : hasCoverage ? "runtime_coverage" : pathImpact.sourceSymbol ? "ast_symbol" : pathImpact.classification === "downstream" || pathImpact.classification === "cross_package" ? "import_graph" : "file_proximity";
      const confidence = unresolved ? "low" : method === "runtime_coverage" ? "high" : method === "ast_symbol" || method === "import_graph" ? "medium" : "low";
      const executionEvidence = pathImpact.verificationState === "verified" ? "executed" : pathImpact.verificationState === "unknown" ? "unknown" : "not_executed";
      const relationship = pathImpact.classification === "direct" || pathImpact.classification === "public_api" ? "direct" : unresolved ? "unresolved" : pathImpact.classification === "downstream" || pathImpact.classification === "cross_package" ? "indirect" : "nearby";
      const names = testNames(root, testFile);
      for (const testName of (names.length ? names : [undefined])) {
        records.push({
          testFile,
          testName,
          sourceFile: pathImpact.sourceFile,
          sourceSymbol: pathImpact.sourceSymbol,
          changedLines,
          coverageEvidence: { available: hasCoverage, coveredLines, changedLineCovered: pathImpact.verified },
          executionEvidence,
          provenanceMethod: method,
          confidence,
          relationship,
          rationale: `${method} relationship: ${pathImpact.reason}`,
        });
      }
    }
  }
  return [...new Map(records.map((record) => [`${record.testFile}:${record.testName ?? ""}:${record.sourceFile}:${record.sourceSymbol ?? ""}`, record])).values()]
    .sort((left, right) => `${left.testFile}:${left.testName ?? ""}:${left.sourceFile}`.localeCompare(`${right.testFile}:${right.testName ?? ""}:${right.sourceFile}`));
}
