import type { Finding, PrProofReport, Verdict } from "../../core/src/types";
import { redactSecrets } from "../../core/src/safety";

export type ReportFormat = "terminal" | "json" | "markdown" | "sarif" | "review-context" | "receipt" | "change-assurance" | "release-manifest";

function sanitizeValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, nested: unknown) => typeof nested === "string" ? redactSecrets(nested) : nested)) as T;
}

function sanitizeReport(report: PrProofReport): PrProofReport {
  return sanitizeValue(report);
}

function oneLine(value: string): string {
  return redactSecrets(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function markdownText(value: string): string {
  return oneLine(value).replace(/([\\`*_[\]|])/g, "\\$1");
}

function percentage(value: number | null): string {
  return value === null ? "unknown" : `${value.toFixed(0)}%`;
}

export function renderJson(report: PrProofReport): string {
  return `${JSON.stringify(sanitizeReport(report), null, 2)}\n`;
}

/** A portable, source-minimized context for external reviewers and CI tools. */
export function renderReviewContext(report: PrProofReport): string {
  const context = {
    schemaVersion: report.schemaVersion,
    schemaId: report.schemaId,
    toolVersion: report.toolVersion,
    repository: report.repository,
    base: report.base,
    head: report.head,
    verdict: report.verdict,
    summary: report.summary,
    findings: report.findings.map((finding) => ({
      id: finding.id,
      fingerprint: finding.fingerprint,
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      file: finding.file,
      startLine: finding.startLine ?? finding.line,
      endLine: finding.endLine ?? finding.startLine ?? finding.line,
      title: finding.title ?? finding.message,
      explanation: finding.explanation,
      suggestedAction: finding.suggestedAction,
      confidence: finding.confidence,
      resolution: finding.resolution,
      baselineState: finding.baselineState,
      evidenceRefs: finding.evidenceRefs,
    })),
    impact: report.impact ? {
      changedSymbols: report.impact.changedSymbols,
      paths: report.impact.paths.map((item) => ({ id: item.id, sourceFile: item.sourceFile, sourceSymbol: item.sourceSymbol, file: item.file, symbol: item.symbol, classification: item.classification, verificationState: item.verificationState, testFiles: item.testFiles, reason: item.reason })),
      unknowns: report.impact.unknowns,
    } : undefined,
    assurance: report.assurance ? {
      recordId: report.assurance.record?.id,
      receiptIds: report.assurance.receipts.map((receipt) => receipt.id),
      graphIds: report.assurance.graphs.map((graph) => graph.id),
      coverageId: report.assurance.coverage?.id,
      contractAssessment: report.assurance.contractAssessment?.status,
      unknowns: report.assurance.unknowns,
    } : undefined,
    evidence: report.evidence ? {
      schemaVersion: report.evidence.schemaVersion,
      schemaId: report.evidence.schemaId,
      runId: report.evidence.runId,
      receiptId: report.evidence.receiptId,
      verdict: report.evidence.verdict,
      policy: report.evidence.policy,
      unknownStates: report.evidence.unknownStates,
      staleStates: report.evidence.staleStates,
      evidenceHashes: report.evidence.evidenceHashes,
      affectedFiles: report.evidence.affectedFiles,
      affectedSymbols: report.evidence.affectedSymbols,
      sourceUpload: report.evidence.sourceUpload,
      diffUpload: report.evidence.diffUpload,
      integrity: report.evidence.integrity,
    } : undefined,
    limitations: report.limitations,
  };
  return `${JSON.stringify(sanitizeReport(context as unknown as PrProofReport), null, 2)}\n`;
}

export function renderTerminal(report: PrProofReport): string {
  const lines: string[] = [];
  lines.push("PR Proof");
  lines.push(`Verdict: ${report.verdict}`);
  lines.push("");
  lines.push("Test integrity");
  if (report.testIntegrity) {
    const test = report.testIntegrity;
    lines.push(`  Assertions weakened: ${test.findings.filter((finding) => /assertion|matcher|tolerance|disabled|deleted/.test(finding.ruleId)).length}`);
    lines.push(`  New tests: ${test.newTests}`);
    lines.push(`  Tests passing on base: ${test.testsPassingOnBase}`);
    lines.push(`  Changed lines covered: ${percentage(test.coverage.percentage)}`);
    lines.push(`  Changed lines covered by modified tests: ${test.coverage.changedLinesCoveredByModifiedTests}`);
    if (test.coverage.coverageDelta !== null) lines.push(`  Coverage delta from base: ${test.coverage.coverageDelta.toFixed(1)} percentage points`);
    if (test.mutation) lines.push(`  Mutants killed: ${test.mutation.killed}/${test.mutation.results.length}`);
    if (!test.coverage.available) lines.push("  Coverage: unavailable (not a failure)");
  } else lines.push("  Not run");
  if (report.policy) lines.push(`  Policy: ${report.policy.pack} (${report.policy.unknownHandling} unknowns)`);
  if (report.baseline) {
    lines.push("", "Baseline");
    lines.push(`  New: ${report.baseline.newCount}  Existing: ${report.baseline.existingCount}  Resolved: ${report.baseline.resolvedCount}  Waived: ${report.baseline.waivedCount}`);
    if (report.baseline.stale) lines.push("  Status: stale or unresolved");
  }
  if (report.selection) {
    lines.push("", "Test selection");
    lines.push(`  Status: ${report.selection.status}  Confidence: ${report.selection.confidence}`);
    lines.push(`  Selected: ${report.selection.selected.length}  Related: ${report.selection.related.length}  Full suite: ${report.selection.requiresFullSuite ? "required" : "not required"}`);
  }
  if (report.contracts) lines.push("", "Contracts", `  Changes: ${report.contracts.changes.length}  Files analyzed: ${report.contracts.filesAnalyzed}`);
  if (report.fixtures) lines.push("", "Fixtures", `  Snapshot files: ${report.fixtures.snapshotFiles.length}  Files analyzed: ${report.fixtures.filesAnalyzed}`);
  if (report.artifacts?.length) lines.push("", "Artifacts", `  Parsed: ${report.artifacts.filter((artifact) => artifact.status === "parsed").length}/${report.artifacts.length}`);
  if (report.languages?.length) {
    lines.push("", "Languages");
    for (const language of report.languages) lines.push(`  ${language.language}: ${language.files} file(s); coverage ${language.capabilities.coverage.join(", ")}; mutation ${language.capabilities.mutation.join(", ")}`);
  }
  lines.push("");
  lines.push("Change impact");
  if (report.impact) {
    const impact = report.impact;
    lines.push(`  Changed symbols: ${impact.changedSymbols.length}`);
    lines.push(`  Downstream consumers: ${impact.downstreamConsumers}`);
    lines.push(`  Impacted tests: ${impact.impactedTests}`);
    lines.push(`  Impacted paths executed: ${impact.impactedPathsExecuted}/${impact.paths.length}`);
    lines.push(`  Unverified paths: ${impact.unverifiedPaths.length}`);
  } else lines.push("  Not run");
  lines.push("");
  lines.push("Highest-priority findings");
  if (!report.findings.length) lines.push("  None");
  else for (const [index, finding] of report.findings.slice(0, 10).entries()) lines.push(`  ${index + 1}. ${formatFinding(finding)}`);
  if (report.limitations.length) {
    lines.push("");
    lines.push("Limitations");
    for (const limitation of report.limitations) lines.push(`  ${limitation}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatFinding(finding: Finding): string {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "repository";
  return `[${finding.severity}] ${oneLine(finding.message)} (${oneLine(finding.ruleId)}) — ${oneLine(location)}`;
}

export function renderMarkdown(report: PrProofReport): string {
  const lines = [`# Tinkerbot Verify`, ``, `**Verdict: ${report.verdict}**`, ``, `## Test integrity`, ``, `| Metric | Value |`, `| --- | ---: |`];
  if (report.testIntegrity) {
    const test = report.testIntegrity;
    lines.push(`| Assertions weakened | ${test.findings.filter((finding) => /assertion|matcher|tolerance|disabled|deleted/.test(finding.ruleId)).length} |`);
    lines.push(`| New tests | ${test.newTests} |`);
    lines.push(`| Tests passing on base | ${test.testsPassingOnBase} |`);
    lines.push(`| Changed lines covered by any test | ${percentage(test.coverage.percentage)} |`);
    lines.push(`| Changed lines covered by modified tests | ${test.coverage.changedLinesCoveredByModifiedTests} |`);
    if (test.coverage.coverageDelta !== null) lines.push(`| Coverage delta from base | ${test.coverage.coverageDelta.toFixed(1)} percentage points |`);
    if (test.mutation) lines.push(`| Mutants killed | ${test.mutation.killed}/${test.mutation.results.length} |`);
  } else lines.push("| Status | Not run |");
  lines.push("", "## Change impact", "", "| Metric | Value |", "| --- | ---: |");
  if (report.impact) {
    lines.push(`| Changed symbols | ${report.impact.changedSymbols.length} |`, `| Downstream consumers | ${report.impact.downstreamConsumers} |`, `| Impacted tests | ${report.impact.impactedTests} |`, `| Impacted paths executed | ${report.impact.impactedPathsExecuted}/${report.impact.paths.length} |`, `| Unverified paths | ${report.impact.unverifiedPaths.length} |`);
  } else lines.push("| Status | Not run |");
  if (report.policy) lines.push("", "## Policy", "", `Pack: **${report.policy.pack}**`, "", report.policy.rationale, "", `Unknown handling: **${report.policy.unknownHandling}**`);
  if (report.evidence) lines.push("", "## Evidence contract", "", `State: **${report.evidence.verdict}**`, `Receipt: \`${markdownText(report.evidence.receiptId)}\``, `Freshness: ${report.evidence.staleStates.length ? "STALE" : "fresh"}; unknown states: ${report.evidence.unknownStates.length}`, `Source upload: **${report.evidence.sourceUpload}**; diff upload: **${report.evidence.diffUpload}**`);
  if (report.baseline) {
    lines.push("", "## Baseline", "", "| New | Existing | Resolved | Waived |", "| ---: | ---: | ---: | ---: |", `| ${report.baseline.newCount} | ${report.baseline.existingCount} | ${report.baseline.resolvedCount} | ${report.baseline.waivedCount} |`);
    if (report.baseline.stale) lines.push("", "Baseline status: **stale or unresolved**");
  }
  if (report.selection) lines.push("", "## Test selection", "", `Status: **${report.selection.status}**, confidence: **${report.selection.confidence}**. Selected ${report.selection.selected.length} tests; ${report.selection.requiresFullSuite ? "full suite required" : "full suite remains recommended before merge"}.`);
  if (report.contracts) lines.push("", "## Contracts", "", `Analyzed ${report.contracts.filesAnalyzed} files and found ${report.contracts.changes.length} contract changes.`);
  if (report.fixtures) lines.push("", "## Fixtures", "", `Analyzed ${report.fixtures.filesAnalyzed} files and found ${report.fixtures.findings.length} fixture findings.`);
  if (report.languages?.length) {
    lines.push("", "## Languages", "", "| Language | Files | Coverage adapters | Mutation adapters |", "| --- | ---: | --- | --- |");
    for (const language of report.languages) lines.push(`| ${markdownText(language.language)} | ${language.files} | ${markdownText(language.capabilities.coverage.join(", "))} | ${markdownText(language.capabilities.mutation.join(", "))} |`);
  }
  lines.push("", "## Highest-priority findings", "");
  if (!report.findings.length) lines.push("No findings.");
  for (const finding of report.findings.slice(0, 20)) {
    const location = finding.file ? ` (\`${markdownText(`${finding.file}${finding.line ? `:${finding.line}` : ""}`)}\`)` : "";
    lines.push(`- **${markdownText(finding.severity)}** \`${markdownText(finding.ruleId)}\`${location}: ${markdownText(finding.message)}. ${markdownText(finding.suggestedAction)}`);
  }
  if (report.limitations.length) lines.push("", "## Limitations", "", ...report.limitations.map((limitation) => `- ${limitation}`));
  return `${lines.join("\n")}\n`;
}

export function renderSarif(report: PrProofReport): string {
  const results = report.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: finding.severity === "critical" || finding.severity === "high" ? "error" : finding.severity === "warning" ? "warning" : "note",
    message: { text: `${finding.message}. ${finding.explanation}` },
    ...(finding.file && finding.file !== "repository" ? { locations: [{ physicalLocation: { artifactLocation: { uri: finding.file }, region: { startLine: finding.startLine ?? finding.line ?? 1, endLine: finding.endLine ?? finding.startLine ?? finding.line ?? 1, startColumn: finding.column ?? 1 } } }] } : {}),
    properties: { confidence: finding.confidence, resolution: finding.resolution, baselineState: finding.baselineState, fingerprint: finding.fingerprint, module: finding.module, suggestedAction: finding.suggestedAction, toolVersion: finding.toolVersion, baseSha: finding.baseSha, headSha: finding.headSha, before: finding.evidence?.before, after: finding.evidence?.after },
  }));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "Tinkerbot Verify", version: report.toolVersion, informationUri: "https://github.com/tinkerbot/tinkerbot", rules: [...new Set(report.findings.map((finding) => finding.ruleId))].sort().map((id) => ({ id, shortDescription: { text: id } })) } }, properties: report.evidence ? { evidenceSchema: report.evidence.schemaId, evidenceReceiptId: report.evidence.receiptId, evidenceVerdict: report.evidence.verdict, sourceUpload: report.evidence.sourceUpload, diffUpload: report.evidence.diffUpload } : undefined, results }],
  };
  return `${JSON.stringify(sanitizeReport(sarif as unknown as PrProofReport), null, 2)}\n`;
}

export function renderReport(report: PrProofReport, format: ReportFormat): string {
  if (format === "json") return renderJson(report);
  if (format === "markdown") return renderMarkdown(report);
  if (format === "sarif") return renderSarif(report);
  if (format === "review-context") return renderReviewContext(report);
  if (format === "receipt") return `${JSON.stringify(sanitizeValue(report.assurance?.receipts?.[0] ?? { kind: "verification-receipt", status: "unknown", unknowns: ["No verification receipt was provided."] }), null, 2)}\n`;
  if (format === "change-assurance") {
    const assurance = report.assurance ?? { kind: "assurance-bundle", status: "unknown", unknowns: ["No assurance bundle was provided."] };
    return `${JSON.stringify(sanitizeValue(report.evidence ? { ...assurance, evidence: report.evidence } : assurance), null, 2)}\n`;
  }
  if (format === "release-manifest") return `${JSON.stringify(sanitizeValue(report.assurance?.releaseManifests?.[0] ?? { kind: "release-manifest", status: "unknown", unknowns: ["No release manifest was provided."] }), null, 2)}\n`;
  return renderTerminal(report);
}

export function verdictEmoji(verdict: Verdict): string {
  return verdict === "PASS" ? "✅" : verdict === "NEEDS_REVIEW" ? "⚠️" : verdict === "FAIL" ? "❌" : "❔";
}
