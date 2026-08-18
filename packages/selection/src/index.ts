import type { FileDiff, ImpactReport, PrProofConfig, TestSelectionPlan, Confidence } from "../../core/src/types";
import { isTestFile, listFilesAtRevision } from "../../git/src";
import { languageEnabled } from "../../language-core/src";

const confidenceRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export interface SelectionOptions {
  root: string;
  head: string;
  diffs: FileDiff[];
  impact: ImpactReport;
  config: PrProofConfig;
}

export function selectTests(options: SelectionOptions): TestSelectionPlan {
  const tests = listFilesAtRevision(options.head, options.root).filter((file) => isTestFile(file) && languageEnabled(file, options.config.languages)).sort();
  const unknownReasons = [...options.impact.unknowns];
  const changedLines = options.diffs.reduce((total, diff) => total + diff.changedLines.length + diff.deletedLines.length, 0);
  const largeDiff = options.diffs.length > options.config.limits.max_changed_files || changedLines > options.config.limits.max_changed_lines;
  if (largeDiff) unknownReasons.push(`Diff exceeds selection bounds (${options.diffs.length} files, ${changedLines} changed/deleted lines); full-suite fallback is required.`);
  const generatedOrDynamic = options.impact.paths.some((item) => item.verificationState === "unknown" || item.classification === "runtime_unknown" || item.classification === "generated");
  const uncertain = generatedOrDynamic || options.impact.unknowns.length > 0 || largeDiff;
  const requiresFullSuite = uncertain && options.config.selection.full_suite_on_unknown;
  const pathByTest = new Map<string, Array<{ file: string; symbol?: string; verified: boolean; reason: string; confidence: Confidence }>>();
  for (const item of options.impact.paths) {
    for (const testFile of item.testFiles) {
      const entries = pathByTest.get(testFile) ?? [];
      entries.push({ file: item.sourceFile, symbol: item.sourceSymbol, verified: item.verificationState === "verified", reason: item.reason, confidence: item.verificationState === "verified" ? "high" : item.verificationState === "partially_verified" ? "medium" : "low" });
      pathByTest.set(testFile, entries);
    }
  }
  const selected: string[] = [];
  const related: string[] = [];
  const unrelated: string[] = [];
  const unknown: string[] = [];
  const reasons: TestSelectionPlan["reasons"] = [];
  for (const testFile of tests) {
    const links = pathByTest.get(testFile) ?? [];
    const strongest = links.reduce<Confidence>((current, item) => confidenceRank[item.confidence] > confidenceRank[current] ? item.confidence : current, "low");
    const meetsThreshold = confidenceRank[strongest] >= confidenceRank[options.config.selection.confidence_threshold];
    let status: "selected" | "related" | "unrelated" | "unknown" = "unrelated";
    if (requiresFullSuite) { selected.push(testFile); status = "selected"; }
    else if (links.length && meetsThreshold) { selected.push(testFile); status = "selected"; }
    else if (links.length && links.some((item) => item.confidence !== "low")) { related.push(testFile); status = "related"; }
    else if (links.length) { unknown.push(testFile); status = "unknown"; }
    else unrelated.push(testFile);
    const impactedFiles = [...new Set(links.map((item) => item.file))].sort();
    const impactedSymbols = [...new Set(links.map((item) => item.symbol).filter((item): item is string => Boolean(item)))].sort();
    reasons.push({ testFile, status, reason: requiresFullSuite ? "Full-suite fallback was selected because impact evidence is uncertain." : links.length ? links.map((item) => item.reason).join(" ") : "No changed symbol or impacted path links to this test.", impactedFiles, impactedSymbols, confidence: strongest });
  }
  if (!tests.length) unknownReasons.push("No test files were found at the head revision.");
  const confidence: Confidence = requiresFullSuite ? "low" : selected.length && selected.every((file) => reasons.find((reason) => reason.testFile === file)?.confidence === "high") ? "high" : selected.length ? "medium" : "low";
  return { status: unknownReasons.length ? "unknown" : "pass", confidence, selected, related, unrelated, unknown, requiresFullSuite, fallback: requiresFullSuite ? "Run the repository's full suite using the configured test command; the narrowed set is not safe under current uncertainty." : "Run the selected tests first, then run the full suite before merge.", reasons, unknowns: unknownReasons };
}
