import type { PrProofConfig, Finding, FileDiff, NonVacuityResult, TestIntegrityReport, LanguageConfig } from "../../core/src/types";
import { isTestFile, runCommandAtRevision } from "../../git/src";
import { calculateChangedLineCoverage, readCoverage, readCoverageAtRevision } from "../../coverage/src";
import type { CoverageReport } from "../../core/src/types";
import { languageEnabled, languageForFile } from "../../language-core/src";
import { buildGraph } from "../../parser/src";

interface PatchLine {
  sign: "+" | "-" | " ";
  text: string;
  line: number;
}

function patchLines(diff: FileDiff): PatchLine[] {
  const result: PatchLine[] = [];
  for (const hunk of diff.hunks) {
    let newLine = hunk.newStart;
    let oldLine = hunk.oldStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith("+")) result.push({ sign: "+", text: raw.slice(1), line: newLine++ });
      else if (raw.startsWith("-")) result.push({ sign: "-", text: raw.slice(1), line: oldLine++ });
      else result.push({ sign: " ", text: raw.slice(1), line: newLine++ }), oldLine++;
    }
  }
  return result;
}

const ASSERTION = /\b(expect\s*\(|assert(?:\.|\s)|to(?:Be|Equal|StrictEqual|BeTruthy|BeFalsy|BeDefined|BeUndefined|BeNull|BeInstanceOf|Match|Contain|HaveLength|Throw|Rejects|resolves|BeGreaterThan|BeLessThan|BeCloseTo)\b)/;
const TEST_DECLARATION = /\b(?:it|test|specify)\s*\(/;
const BROAD_MATCHER = /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeNull|toContain|toMatchObject|toHaveProperty)\s*\(/;

function isAssertion(text: string, file: string): boolean {
  if (ASSERTION.test(text)) return true;
  const language = languageForFile(file);
  if (language === "python") return /\bassert\b|pytest\.(?:raises|fail|approx)\s*\(|\.assert(?:Equal|True|False|Raises|In|Is|IsNone)\s*\(/.test(text);
  if (language === "go") return /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow|Log|Logf)\s*\(|\b(?:require|assert)\.(?:NoError|Error|Equal|True|False)\s*\(/.test(text);
  if (language === "rust") return /\b(?:assert|assert_eq|assert_ne|debug_assert|panic)!\s*\(/.test(text);
  if (language === "c" || language === "cpp") return /\b(?:ASSERT|EXPECT|REQUIRE)_[A-Z_]+\s*\(|\b(?:ck_assert|TEST_CHECK|TEST_ASSERT)\s*\(/.test(text);
  return false;
}

function isTestDeclaration(text: string, file: string): boolean {
  if (TEST_DECLARATION.test(text)) return true;
  const language = languageForFile(file);
  if (language === "python") return /^\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(/.test(text);
  if (language === "go") return /^\s*func\s+Test[A-Z]\w*\s*\(/.test(text);
  if (language === "rust") return /#\s*\[\s*test\s*\]|\bfn\s+test_[A-Za-z0-9_]*\s*\(/.test(text);
  if (language === "c" || language === "cpp") return /\b(?:TEST|TEST_F|TEST_CASE|SCENARIO)\s*\(/.test(text);
  return false;
}

function isErrorAssertion(text: string, file: string): boolean {
  if (/toThrow|rejects|toBeRejected|toThrowError|assert\.throws/.test(text)) return true;
  const language = languageForFile(file);
  if (language === "python") return /pytest\.raises|assertRaises|with\s+raises\s*\(/.test(text);
  if (language === "go") return /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\b(?:require|assert)\.Error\s*\(/.test(text);
  if (language === "rust") return /\b(?:should_panic|assert_ne|panic)!\s*\(/.test(text);
  if (language === "c" || language === "cpp") return /\b(?:ASSERT|EXPECT|REQUIRE)_(?:THROW|DEATH|FAIL)/.test(text);
  return false;
}

function finding(diff: FileDiff, ruleId: string, severity: Finding["severity"], message: string, explanation: string, line: number | undefined, evidence: { before?: string; after?: string }, suggestedAction: string, confidence: Finding["confidence"] = "high"): Finding {
  return {
    id: `${ruleId}:${diff.path}:${line ?? 1}`,
    ruleId,
    category: "test_integrity",
    severity,
    file: diff.path,
    line,
    message,
    explanation,
    evidence,
    suggestedAction,
    confidence,
    blocking: severity === "critical" || severity === "high",
  };
}

function normalizedAssertion(text: string): string {
  return text.replace(/\b(?:test|it|specify)\s*\(\s*["'][^"']*["']/, "test(").replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}

export function analyzeTestDiffs(diffs: FileDiff[], root: string, languages?: LanguageConfig): { findings: Finding[]; newTests: number; modifiedTests: number; deletedTests: number } {
  const findings: Finding[] = [];
  let newTests = 0;
  let modifiedTests = 0;
  let deletedTests = 0;
  for (const diff of diffs) {
    const lines = patchLines(diff);
    const language = languageForFile(diff.path);
    const inlineRustTest = language === "rust" && lines.some((line) => /#\s*\[(?:cfg\s*\(\s*test\s*\)|test)\]|\bfn\s+test_/.test(line.text));
    const test = (isTestFile(diff.path) || isTestFile(diff.oldPath ?? "") || inlineRustTest) && (!languages || languageEnabled(diff.path, languages) || languageEnabled(diff.oldPath ?? "", languages));
    if (!test) continue;
    if (diff.status === "added" || diff.additions > 0) modifiedTests += 1;
    const added = lines.filter((line) => line.sign === "+");
    const removed = lines.filter((line) => line.sign === "-");
    newTests += added.filter((line) => isTestDeclaration(line.text, diff.path) && !/\.todo\s*\(/.test(line.text)).length;
    deletedTests += removed.filter((line) => isTestDeclaration(line.text, diff.path)).length;

    const removedAssertions = removed.filter((line) => isAssertion(line.text, diff.path));
    const addedAssertions = added.filter((line) => isAssertion(line.text, diff.path));
    for (const line of removedAssertions) {
      if (!addedAssertions.some((candidate) => normalizedAssertion(candidate.text) === normalizedAssertion(line.text))) {
        findings.push(finding(diff, "assertion.removed", "high", "Assertion removed from a changed test", "The deleted line contained an assertion and no equivalent assertion was found in the added lines for this hunk.", line.line, { before: line.text }, "Restore the assertion or document why the behavior is no longer part of the contract."));
      }
    }
    if (removedAssertions.length > addedAssertions.length) {
      findings.push(finding(diff, "assertion.count-reduced", "warning", "Assertion count reduced", `The hunk removes ${removedAssertions.length} assertion(s) and adds ${addedAssertions.length}.`, addedAssertions[0]?.line ?? removedAssertions[0]?.line, { before: `${removedAssertions.length} assertions`, after: `${addedAssertions.length} assertions` }, "Review the test contract and ensure each meaningful behavior remains asserted."));
    }

    const removedExact = removed.find((line) => /\.toBe\s*\(|\.toStrictEqual\s*\(/.test(line.text));
    const addedBroad = added.find((line) => BROAD_MATCHER.test(line.text));
    if (removedExact && addedBroad) {
      findings.push(finding(diff, "matcher.weakened", "high", "Exact matcher replaced with a broader matcher", "The changed test no longer checks the same exact value or structure.", addedBroad.line, { before: removedExact.text, after: addedBroad.text }, "Keep the exact matcher unless the broader contract is intentional and documented."));
    }
    const removedStrongAssertion = removed.find((line) => language === "python" && /\bassert\b[^#]*(?:==|!=|<=|>=|<|>)/.test(line.text))
      ?? removed.find((line) => language === "go" && /\bt\.(?:Error|Fatal|Fail)/.test(line.text))
      ?? removed.find((line) => (language === "rust" || language === "c" || language === "cpp") && isAssertion(line.text, diff.path));
    const addedWeakAssertion = added.find((line) => language === "python" && /^\s*assert\b(?!.*(?:==|!=|<=|>=|[<>]))/.test(line.text))
      ?? added.find((line) => language === "go" && /\bt\.Log(?:f)?\s*\(/.test(line.text));
    if (removedStrongAssertion && addedWeakAssertion) {
      findings.push(finding(diff, "assertion.weakened", "high", "Language-native assertion was weakened", "The replacement keeps a test statement but removes the value, error, or failure condition that made the assertion meaningful.", addedWeakAssertion.line, { before: removedStrongAssertion.text, after: addedWeakAssertion.text }, "Preserve the explicit expected value or failure assertion for this behavior."));
    }
    const oldClose = removed.map((line) => line.text.match(/toBeCloseTo\([^,]+,\s*(\d+)/)?.[1]).find(Boolean);
    const newClose = added.map((line) => line.text.match(/toBeCloseTo\([^,]+,\s*(\d+)/)?.[1]).find(Boolean);
    if (oldClose && newClose && Number(newClose) < Number(oldClose)) {
      const after = added.find((line) => line.text.includes("toBeCloseTo"));
      findings.push(finding(diff, "tolerance.widened", "warning", "Numeric tolerance widened", `toBeCloseTo precision changed from ${oldClose} to ${newClose}; lower precision accepts more outcomes.`, after?.line, { before: `precision ${oldClose}`, after: `precision ${newClose}` }, "Confirm that the lower precision still protects the changed behavior."));
    }
    const oldTimeout = removed.map((line) => line.text.match(/(?:timeout|interval)\s*:\s*(\d+)/)?.[1]).find(Boolean);
    const newTimeout = added.map((line) => line.text.match(/(?:timeout|interval)\s*:\s*(\d+)/)?.[1]).find(Boolean);
    if (oldTimeout && newTimeout && Number(newTimeout) > Number(oldTimeout)) {
      const after = added.find((line) => /(?:timeout|interval)\s*:/.test(line.text));
      findings.push(finding(diff, "tolerance.widened", "warning", "Test timeout or interval widened", `The timing tolerance increased from ${oldTimeout} to ${newTimeout}.`, after?.line, { before: oldTimeout, after: newTimeout }, "Check that the wider timing window does not hide a regression."));
    }

    for (const line of added) {
      if (/\b(?:it|test|describe|suite)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|pytest\.mark\.skip|#\s*\[\s*ignore\s*\]|\b(?:skip|skipif)\s*=/.test(line.text)) {
        findings.push(finding(diff, "test.disabled", /\.only\s*\(/.test(line.text) ? "critical" : "high", "Test disabled or restricted", "The change adds a skip/only/x-prefixed test declaration that changes which tests execute.", line.line, { after: line.text }, "Remove the modifier before merging, or explicitly document the temporary exception."));
      }
      if (/\b(?:test|it|describe)\.todo\s*\(/.test(line.text)) {
        findings.push(finding(diff, "test.todo-added", "warning", "New test.todo introduced", "A todo is not an executable regression test.", line.line, { after: line.text }, "Implement the test or explain why the behavior is intentionally deferred."));
      }
      if (/\b(?:mockResolvedValue|mockReturnValue|mockImplementation)\s*\(\s*(?:true|false|null|undefined|\{?\s*(?:ok|success)\s*:\s*true)/.test(line.text) || /=>\s*(?:true|false|Promise\.resolve\s*\(\s*(?:true|undefined|null))/.test(line.text) || /\b(?:return|=>)\s*(?:True|False|nil|None)\s*;?\s*$/.test(line.text)) {
        findings.push(finding(diff, "mock.unconditional-success", "high", "Mock now returns an unconditional result", "The mock can make a success path pass without exercising the real behavior or error handling.", line.line, { after: line.text }, "Prefer a behavior-specific mock and add an assertion that the real boundary was exercised."));
      }
      if (/\b(?:vi|jest)\.mock\s*\(/.test(line.text)) {
        findings.push(finding(diff, "mock.broad-replacement", "warning", "Broad module mock introduced", "A module-wide mock can bypass the changed implementation and its integration behavior.", line.line, { after: line.text }, "Use a narrow dependency seam or add an integration test for the changed path.", "medium"));
      }
      if (/(?:istanbul|c8|nyc)\s+ignore|coverage\s+ignore|@ts-ignore|#\s*pragma:\s*no\s*cover|\/\/\s*go:build\s+ignore|#\s*if\s+0/.test(line.text)) {
        findings.push(finding(diff, "coverage.exclusion-added", "high", "Coverage or type-check exclusion introduced in a test change", "The new exclusion can hide an unverified changed path.", line.line, { after: line.text }, "Remove the exclusion or justify it with a focused test and review note."));
      }
    }
    for (const line of removed) {
      if (isTestDeclaration(line.text, diff.path) && !added.some((candidate) => isTestDeclaration(candidate.text, diff.path))) {
        findings.push(finding(diff, "test.deleted", "high", "Test case deleted", "A test declaration was removed from the pull request.", line.line, { before: line.text }, "Confirm the behavior is obsolete or restore a regression test."));
      }
      if (isErrorAssertion(line.text, diff.path) && !added.some((candidate) => isErrorAssertion(candidate.text, diff.path))) {
        findings.push(finding(diff, "error-assertion.removed", "high", "Error assertion removed", "The deleted assertion protected an error or rejection path.", line.line, { before: line.text }, "Keep an explicit error-path assertion for authorization, validation, and failure behavior."));
      }
    }
  }
  return { findings, newTests, modifiedTests, deletedTests };
}

function testFilesFromDiffs(diffs: FileDiff[], languages?: LanguageConfig): Set<string> {
  return new Set(diffs.filter((diff) => {
    const inlineRustTest = languageForFile(diff.path) === "rust" && /#\s*\[(?:cfg\s*\(\s*test\s*\)|test)\]|\bfn\s+test_/.test(diff.patch);
    return (isTestFile(diff.path) || inlineRustTest) && (!languages || languageEnabled(diff.path, languages));
  }).map((diff) => diff.path));
}

function relatedSourceFiles(root: string, diffs: FileDiff[], testFiles: Set<string>): Set<string> {
  const related = new Set<string>();
  const graph = buildGraph(root, [...testFiles]);
  for (const testFile of testFiles) for (const imported of graph.modules.get(testFile)?.imports ?? []) if (imported.resolvedFile) related.add(imported.resolvedFile);
  return related;
}

export function analyzeNonVacuity(root: string, base: string, head: string, config: PrProofConfig, newTestFiles: string[]): { results: NonVacuityResult[]; unknowns: string[] } {
  if (!newTestFiles.length) return { results: [], unknowns: [] };
  if (!config.test_integrity.run_base_tests) return { results: newTestFiles.map((testFile) => ({ testFile, status: "not_run", message: "Base/head execution is disabled by configuration." })), unknowns: ["Base/head test execution was disabled."] };
  const baseResult = runCommandAtRevision(root, base, config.framework.command, config.framework.test_timeout_seconds, config.validation.allow_shell_commands);
  const headResult = runCommandAtRevision(root, head, config.framework.command, config.framework.test_timeout_seconds, config.validation.allow_shell_commands);
  const results: NonVacuityResult[] = [];
  for (const testFile of newTestFiles) {
    if (baseResult.timedOut || baseResult.error || headResult.timedOut || headResult.error) results.push({ testFile, status: "base_unknown", baseExitCode: baseResult.status, headExitCode: headResult.status, message: "The base or head revision could not be run safely; this is unknown rather than a failure." });
    else if (headResult.status !== 0) results.push({ testFile, status: "head_failed", baseExitCode: baseResult.status, headExitCode: headResult.status, message: "The head test command failed before this test could prove the changed behavior." });
    else if (baseResult.status === 0) results.push({ testFile, status: "passes_on_base", baseExitCode: baseResult.status, headExitCode: headResult.status, message: "This test passes on both base and PR. It may not prove the behavior introduced by this change." });
    else results.push({ testFile, status: "meaningful", baseExitCode: baseResult.status, headExitCode: headResult.status, message: "The base command failed and the head command passed; this is evidence of a meaningful behavior change." });
  }
  return { results, unknowns: results.some((result) => result.status === "base_unknown") ? ["At least one base test execution was unavailable."] : [] };
}

export interface TestIntegrityOptions {
  base?: string;
  head?: string;
  coverage?: CoverageReport;
}

export function analyzeTestIntegrity(root: string, diffs: FileDiff[], config: PrProofConfig, options: TestIntegrityOptions = {}): TestIntegrityReport {
  const diffResult = analyzeTestDiffs(diffs, root, config.languages);
  const testFiles = testFilesFromDiffs(diffs, config.languages);
  const nonVacuityResult = options.base && options.head ? analyzeNonVacuity(root, options.base, options.head, config, [...testFiles]) : { results: [], unknowns: [] };
  const nonVacuity = nonVacuityResult.results;
  const unknowns: string[] = [...nonVacuityResult.unknowns];
  if (!options.base || !options.head) unknowns.push("Base/head test execution was not requested.");
  const coverage = options.coverage ?? readCoverage(root, config.framework.coverage_file);
  const coverageSummary = calculateChangedLineCoverage(root, diffs, coverage, relatedSourceFiles(root, diffs, testFiles));
  if (options.base && coverage.available) {
    const baseCoverage = readCoverageAtRevision(root, options.base, config.framework.coverage_file);
    if (baseCoverage.available) {
      const headLines = Object.values(coverage.files).flatMap((file) => Object.values(file.lines));
      const baseLines = Object.values(baseCoverage.files).flatMap((file) => Object.values(file.lines));
      const headPercentage = headLines.length ? (headLines.filter((count) => count > 0).length / headLines.length) * 100 : null;
      const basePercentage = baseLines.length ? (baseLines.filter((count) => count > 0).length / baseLines.length) * 100 : null;
      coverageSummary.coverageDelta = headPercentage !== null && basePercentage !== null ? headPercentage - basePercentage : null;
    }
  }
  if (!coverageSummary.available) unknowns.push("No recognized coverage artifact (LCOV, Istanbul, coverage.py, Go coverprofile, or LLVM coverage) was available.");
  if (config.test_integrity.require_new_tests_fail_on_base && nonVacuity.some((result) => result.status === "passes_on_base")) {
    unknowns.push("A configured new-test base failure requirement was not met.");
  }
  const coverageFindings: Finding[] = [];
  if (coverageSummary.available && coverageSummary.uncoveredLines.length) {
    const first = coverageSummary.uncoveredLines[0].match(/^(.*):(\d+)$/);
    coverageFindings.push({
      id: `coverage.uncovered:${coverageSummary.uncoveredLines.join(",")}`,
      ruleId: "coverage.changed-line-uncovered",
      category: "coverage",
      severity: "warning",
      file: first?.[1],
      line: first ? Number(first[2]) : undefined,
      message: "Changed executable line is not covered by the available artifact",
      explanation: `${coverageSummary.changedLinesNotCovered} changed executable line(s) have no recorded execution in the supplied coverage artifact. Coverage is evidence, not proof of assertion quality.`,
      evidence: { detail: coverageSummary.uncoveredLines.join(", ") },
      suggestedAction: "Add or run a focused test for the changed path and inspect the generated coverage artifact.",
      confidence: "medium",
      blocking: false,
    });
  }
  const nonVacuityFindings: Finding[] = nonVacuity.filter((result) => result.status === "passes_on_base").map((result) => ({
    id: `test.non-vacuous:${result.testFile}`,
    ruleId: "test.non-vacuous",
    category: "test_integrity",
    severity: config.test_integrity.require_new_tests_fail_on_base ? "high" : "warning",
    file: result.testFile,
    line: result.line,
    message: "New test passes on base and head",
    explanation: result.message,
    suggestedAction: "Make the test exercise behavior introduced by this pull request, or classify it as a refactor test.",
    confidence: "medium",
    blocking: config.test_integrity.require_new_tests_fail_on_base,
  }));
  return {
    findings: [...diffResult.findings, ...coverageFindings, ...nonVacuityFindings],
    newTests: diffResult.newTests,
    modifiedTests: diffResult.modifiedTests,
    deletedTests: diffResult.deletedTests,
    testsPassingOnBase: nonVacuity.filter((result) => result.status === "passes_on_base").length,
    nonVacuity,
    coverage: coverageSummary,
    unknowns,
  };
}
