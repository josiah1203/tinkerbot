import path from "node:path";
import type { PrProofConfig, Finding, FileDiff, ImpactPath, ImpactReport, ChangedSymbol, CoverageReport, ImpactVerificationState } from "../../core/src/types";
import { isSourceFile, isTestFile, listFilesAtRevision, readFileAtRevision } from "../../git/src";
import { languageEnabled } from "../../language-core/src";
import { buildGraph, graphForRevision, symbolAtLine, type ModuleNode, type SymbolGraph, type SymbolNode } from "../../parser/src";

function relativeFile(file: string): string {
  return file.split(path.sep).join("/");
}

function isGeneratedFile(file: string): boolean {
  return /(^|\/)(generated|gen|dist|build)(\/|$)|\.generated\.[cm]?[jt]sx?$/.test(file);
}

function impactId(source: string, target: string, classification: string): string {
  return `${classification}:${source}:${target}`;
}

function findingForPath(impact: ImpactPath, blocking: boolean): Finding {
  const severity = impact.classification === "public_api" || impact.classification === "direct" ? "high" : impact.classification === "runtime_unknown" ? "info" : "warning";
  return {
    id: `impact.unverified:${impact.id}`,
    ruleId: impact.dynamic ? "impact.dynamic-unknown" : "impact.unverified",
    category: "impact",
    severity,
    file: impact.file,
    line: undefined,
    message: impact.dynamic ? "Dynamic impact could not be resolved" : "Impacted path has no verified test evidence",
    explanation: impact.dynamic ? impact.reason : `${impact.reason}. Related tests: ${impact.testFiles.length ? impact.testFiles.join(", ") : "none found"}.`,
    suggestedAction: impact.dynamic ? "Review runtime registration or add an explicit integration/contract test." : "Add or run a focused regression, integration, or contract test for this path.",
    confidence: impact.dynamic ? "low" : "medium",
    classification: impact.classification,
    blocking,
  };
}

function changedSymbols(head: SymbolGraph, baseGraph: SymbolGraph, diffs: FileDiff[]): ChangedSymbol[] {
  const result: ChangedSymbol[] = [];
  for (const diff of diffs) {
    const headModule = head.modules.get(diff.path);
    const baseModule = baseGraph.modules.get(diff.oldPath ?? diff.path);
    const found = new Map<string, ChangedSymbol>();
    for (const line of diff.changedLines) {
      const symbol = headModule ? symbolAtLine(headModule, line) : undefined;
      if (symbol) found.set(symbol.id, { name: symbol.name, file: symbol.file, line: symbol.line, kind: symbol.kind, change: diff.status === "added" ? "added" : "modified", exported: symbol.exported });
    }
    for (const line of diff.deletedLines) {
      const symbol = baseModule ? symbolAtLine(baseModule, line) : undefined;
      if (symbol && !headModule?.symbols.some((candidate) => candidate.name === symbol.name)) found.set(`deleted:${symbol.id}`, { name: symbol.name, file: diff.path, line: symbol.line, kind: symbol.kind, change: "deleted", exported: symbol.exported });
    }
    if (!found.size && (diff.additions > 0 || diff.deletions > 0)) {
      result.push({ name: diff.path, file: diff.path, line: diff.changedLines[0] ?? diff.deletedLines[0] ?? 1, kind: "file", change: diff.status === "deleted" ? "deleted" : diff.status === "renamed" ? "renamed" : "file", exported: false });
    } else result.push(...found.values());
  }
  for (const [file, module] of head.modules) {
    const baseModule = baseGraph.modules.get(file);
    if (!baseModule) continue;
    for (const exported of module.exports) {
      if (!baseModule.exports.includes(exported)) {
        const symbol = module.symbols.find((candidate) => candidate.name === exported);
        if (symbol) result.push({ name: exported, file, line: symbol.line, kind: symbol.kind, change: "added", exported: true });
      }
    }
  }
  return [...new Map(result.map((item) => [`${item.file}:${item.name}:${item.line}:${item.change}`, item])).values()];
}

function moduleTests(graph: SymbolGraph, targetFile: string, targetName?: string): string[] {
  const tests: string[] = [];
  for (const [file, module] of graph.modules) {
    if (!isTestFile(file)) continue;
    const importsTarget = module.imports.some((item) => item.resolvedFile === targetFile);
    const referencesTarget = targetName ? module.references.some((item) => item.name === targetName) : false;
    if (importsTarget || referencesTarget) tests.push(file);
  }
  return tests.sort();
}

function coverageFor(coverage: CoverageReport | undefined, file: string, line: number | undefined): { verified: boolean; lines: number[] } {
  if (!coverage?.available || line === undefined) return { verified: false, lines: [] };
  const data = coverage.files[relativeFile(file)];
  if (!data) return { verified: false, lines: [] };
  const lines = Object.entries(data.lines).filter(([, count]) => count > 0).map(([coveredLine]) => Number(coveredLine));
  return { verified: lines.includes(line), lines };
}

function verificationState(verified: boolean, testFiles: string[], coverage: CoverageReport | undefined, dynamic = false): ImpactVerificationState {
  if (dynamic) return "unknown";
  if (verified) return "verified";
  if (!coverage?.available) return testFiles.length ? "partially_verified" : "unknown";
  return "unverified";
}

function changedSymbolsForDiffs(diffs: FileDiff[]): ChangedSymbol[] {
  return diffs.map((diff) => ({
    name: diff.path,
    file: diff.path,
    line: diff.changedLines[0] ?? diff.deletedLines[0] ?? 1,
    kind: "file",
    change: diff.status === "deleted" ? "deleted" : diff.status === "renamed" ? "renamed" : "file",
    exported: false,
  }));
}

function unknownReport(changedSymbols: ChangedSymbol[], reason: string): ImpactReport {
  return {
    filesAnalyzed: 0,
    symbolsAnalyzed: 0,
    changedSymbols,
    paths: [],
    downstreamConsumers: 0,
    impactedTests: 0,
    impactedPathsExecuted: 0,
    unverifiedPaths: [],
    findings: [{ id: "impact.analysis-unknown", ruleId: "impact.analysis-unknown", category: "impact", severity: "info", message: "Impact analysis could not complete within its configured limit", explanation: reason, suggestedAction: "Review the diff in smaller changes or raise the configured analysis limit after measuring runner performance.", confidence: "high", resolution: "unknown", blocking: false }],
    unknowns: [reason],
  };
}

export interface ImpactOptions {
  root: string;
  base: string;
  head: string;
  diffs: FileDiff[];
  config: PrProofConfig;
  coverage?: CoverageReport;
}

export function analyzeImpact(options: ImpactOptions): ImpactReport {
  const startedAt = Date.now();
  const timeoutMs = options.config.limits.analysis_timeout_seconds * 1000;
  const timedOut = () => Date.now() - startedAt >= timeoutMs;
  const timeoutReason = `Static impact tracing exceeded the configured ${options.config.limits.analysis_timeout_seconds}-second analysis limit.`;
  const changedLineCount = options.diffs.reduce((total, diff) => total + diff.additions + diff.deletions, 0);
  if (options.diffs.length > options.config.limits.max_changed_files || changedLineCount > options.config.limits.max_changed_lines) {
    const changedSymbols = changedSymbolsForDiffs(options.diffs);
    const reason = `Static impact tracing was bounded because the diff contains ${options.diffs.length} file(s) and ${changedLineCount} changed line(s); limits are ${options.config.limits.max_changed_files} file(s)/${options.config.limits.max_changed_lines} line(s).`;
    return {
      filesAnalyzed: 0,
      symbolsAnalyzed: 0,
      changedSymbols,
      paths: [],
      downstreamConsumers: 0,
      impactedTests: 0,
      impactedPathsExecuted: 0,
      unverifiedPaths: [],
      findings: [{ id: "impact.large-diff-unknown", ruleId: "impact.large-diff-unknown", category: "impact", severity: "info", message: "Impact analysis bounded for a large diff", explanation: reason, suggestedAction: "Review the diff in smaller changes or raise the configured analysis limit after measuring runner performance.", confidence: "high", blocking: false }],
      unknowns: [reason],
    };
  }
  const allSourceFiles = listFilesAtRevision(options.head, options.root).filter((file) => isSourceFile(file) && languageEnabled(file, options.config.languages));
  const sourceFiles = allSourceFiles.slice(0, options.config.limits.max_files_analyzed);
  const graphOptions = {
    validateSyntax: options.config.validation.toolchain_checks,
    validationTimeoutMs: Math.min(5_000, options.config.framework.test_timeout_seconds * 1_000),
    maxValidatedFiles: Math.min(options.config.limits.max_files_analyzed, 250),
  };
  const headGraph = graphForRevision(options.root, options.head, sourceFiles, (revision, file) => readFileAtRevision(revision, file, options.root), graphOptions);
  const allBaseFiles = listFilesAtRevision(options.base, options.root).filter((file) => isSourceFile(file) && languageEnabled(file, options.config.languages));
  const baseFiles = allBaseFiles.slice(0, options.config.limits.max_files_analyzed);
  const baseGraph = graphForRevision(options.root, options.base, baseFiles, (revision, file) => readFileAtRevision(revision, file, options.root), graphOptions);
  if (timedOut()) return unknownReport(changedSymbolsForDiffs(options.diffs), timeoutReason);
  const graphTruncated = allSourceFiles.length > sourceFiles.length || allBaseFiles.length > baseFiles.length;
  const symbolLimitExceeded = headGraph.symbols.size > options.config.limits.max_symbols_analyzed;
  const allChangedSymbols = changedSymbols(headGraph, baseGraph, options.diffs);
  const symbols = allChangedSymbols.slice(0, options.config.limits.max_symbols_analyzed);
  const filesAnalyzed = new Set([...sourceFiles, ...baseFiles]).size;
  const symbolsAnalyzed = headGraph.symbols.size + baseGraph.symbols.size;
  const changedFiles = new Set(options.diffs.map((diff) => diff.path));
  const paths: ImpactPath[] = [];
  const seen = new Set<string>();
  let analysisTimedOut = false;
  const addPath = (candidate: ImpactPath) => {
    if (seen.has(candidate.id)) return;
    seen.add(candidate.id);
    paths.push(candidate);
  };

  for (const changed of symbols) {
    if (timedOut()) { analysisTimedOut = true; break; }
    const target = headGraph.modules.get(changed.file);
    const tests = moduleTests(headGraph, changed.file, changed.name === changed.file ? undefined : changed.name);
    const sourceCoverage = coverageFor(options.coverage, changed.file, changed.line);
    const directId = impactId(`${changed.file}:${changed.name}`, changed.file, "direct");
    const directClassification = isTestFile(changed.file) ? "test_only" : isGeneratedFile(changed.file) ? "generated" : changed.exported ? "public_api" : "direct";
    const directVerificationState = directClassification === "test_only" || directClassification === "generated" ? "not_applicable" : verificationState(sourceCoverage.verified, tests, options.coverage);
    addPath({ id: directId, sourceFile: changed.file, sourceSymbol: changed.name, file: changed.file, symbol: changed.name, classification: directClassification, reason: `Changed ${changed.kind} ${changed.name} is a direct behavior source.`, testFiles: tests, verified: sourceCoverage.verified, verificationState: directVerificationState, coverageLines: sourceCoverage.lines, modifiedByPr: changedFiles.has(changed.file) });

    for (const [file, module] of headGraph.modules) {
      if (timedOut()) { analysisTimedOut = true; break; }
      if (file === changed.file) continue;
      const imports = module.imports.filter((item) => item.resolvedFile === changed.file);
      const references = changed.name !== changed.file ? module.references.filter((item) => item.name === changed.name) : [];
      if (!imports.length && !references.length) continue;
      const relatedTests = isTestFile(file) ? [file] : moduleTests(headGraph, file, changed.name);
      const coverage = coverageFor(options.coverage, file, references[0]?.line);
      const classification = isTestFile(file) ? "test_only" : references.length && !imports.length ? "direct" : module.packageName && target?.packageName && module.packageName !== target.packageName ? "cross_package" : "downstream";
      const verified = coverage.verified || relatedTests.some((test) => options.coverage?.files[test]?.lines && Object.values(options.coverage.files[test].lines).some((count) => count > 0));
      addPath({ id: impactId(`${changed.file}:${changed.name}`, file, classification), sourceFile: changed.file, sourceSymbol: changed.name, file, symbol: changed.name, classification, reason: `${file} imports or references the changed symbol ${changed.name}.`, testFiles: relatedTests, verified, verificationState: classification === "test_only" ? "not_applicable" : verificationState(verified, relatedTests, options.coverage), coverageLines: coverage.lines, modifiedByPr: changedFiles.has(file) });
    }
    if (analysisTimedOut) break;

    const reverseImports = new Map<string, string[]>();
    for (const [file, module] of headGraph.modules) {
      for (const reference of module.imports) {
        if (!reference.resolvedFile) continue;
        const consumers = reverseImports.get(reference.resolvedFile) ?? [];
        consumers.push(file);
        reverseImports.set(reference.resolvedFile, consumers);
      }
    }
    let frontier = new Set([changed.file]);
    const visited = new Set([changed.file]);
    for (let depth = 1; depth <= options.config.impact.max_dependency_depth; depth += 1) {
      if (timedOut()) { analysisTimedOut = true; break; }
      const next = new Set<string>();
      for (const targetFile of frontier) {
        for (const file of reverseImports.get(targetFile) ?? []) {
          if (timedOut()) { analysisTimedOut = true; break; }
          if (visited.has(file)) continue;
          visited.add(file);
          next.add(file);
          const module = headGraph.modules.get(file);
          if (!module) continue;
          const relatedTests = isTestFile(file) ? [file] : moduleTests(headGraph, file, changed.name);
          const coverage = coverageFor(options.coverage, file, module.symbols[0]?.line);
          const classification = isTestFile(file) ? "test_only" : module.packageName && target?.packageName && module.packageName !== target.packageName ? "cross_package" : "downstream";
          addPath({ id: impactId(`${changed.file}:${changed.name}`, file, classification), sourceFile: changed.file, sourceSymbol: changed.name, file, symbol: changed.name, classification, reason: `Depth-${depth} importer of a module already affected by ${changed.name}.`, testFiles: relatedTests, verified: coverage.verified, verificationState: classification === "test_only" ? "not_applicable" : verificationState(coverage.verified, relatedTests, options.coverage), coverageLines: coverage.lines, modifiedByPr: changedFiles.has(file) });
        }
        if (analysisTimedOut) break;
      }
      frontier = next;
      if (!frontier.size) break;
    }
    if (analysisTimedOut) break;

    if (changed.change === "deleted") {
      for (const [file, module] of headGraph.modules) {
        if (timedOut()) { analysisTimedOut = true; break; }
        const references = module.references.filter((item) => item.name === changed.name);
        if (!references.length) continue;
        const testFiles = moduleTests(headGraph, file, changed.name);
        addPath({ id: impactId(`${changed.file}:${changed.name}`, file, "runtime_unknown"), sourceFile: changed.file, sourceSymbol: changed.name, file, symbol: changed.name, classification: "runtime_unknown", reason: `Deleted symbol ${changed.name} still has ${references.length} static reference(s) in ${file}.`, testFiles, verified: false, verificationState: "unknown", modifiedByPr: changedFiles.has(file) });
      }
    }
    if (analysisTimedOut) break;
    if (target?.dynamicReferences.length) {
      addPath({ id: impactId(`${changed.file}:${changed.name}`, changed.file, "runtime_unknown"), sourceFile: changed.file, sourceSymbol: changed.name, file: changed.file, symbol: changed.name, classification: "runtime_unknown", reason: target.dynamicReferences.join("; "), testFiles: tests, verified: false, verificationState: "unknown", modifiedByPr: true, dynamic: true });
    }
    if (options.config.include_routes && target?.routes.length) {
      for (const route of target.routes) {
        if (timedOut()) { analysisTimedOut = true; break; }
        const routeTests = tests.filter((test) => /integration|e2e|route|api/i.test(test)) ;
        const verified = routeTests.length > 0 && Boolean(options.coverage?.available);
        addPath({ id: impactId(`${changed.file}:${changed.name}`, `${changed.file}:${route.line}`, "downstream"), sourceFile: changed.file, sourceSymbol: changed.name, file: changed.file, symbol: `${route.method} ${route.path ?? "<dynamic route>"}`, classification: "downstream", reason: `Route ${route.method} ${route.path ?? "<dynamic>"} is registered near the changed code.`, testFiles: routeTests, verified, verificationState: verificationState(verified, routeTests, options.coverage), modifiedByPr: true });
      }
    }
    if (analysisTimedOut) break;
  }

  const dynamicModules = [...headGraph.modules.values()].filter((module) => module.dynamicReferences.length > 0);
  if (dynamicModules.length && !analysisTimedOut) {
    for (const changed of symbols) {
      if (timedOut()) { analysisTimedOut = true; break; }
      const id = impactId(`dynamic:${dynamicModules.map((module) => module.file).join(",")}`, changed.file, "runtime_unknown");
      const testFiles = moduleTests(headGraph, changed.file, changed.name);
      addPath({ id, sourceFile: changed.file, sourceSymbol: changed.name, file: changed.file, symbol: changed.name, classification: "runtime_unknown", reason: `Unresolved dynamic references exist in ${dynamicModules.map((module) => module.file).join(", ")}; their runtime target may include changed behavior.`, testFiles, verified: false, verificationState: "unknown", modifiedByPr: true, dynamic: true });
    }
  }

  const unresolvedImports = [...headGraph.modules.values()].flatMap((module) => module.imports.filter((item) => item.specifier.startsWith(".") && !item.resolvedFile).map((item) => `${module.file}:${item.line} → ${item.specifier}`));
  if (unresolvedImports.length && !analysisTimedOut) {
    for (const changed of symbols) {
      if (timedOut()) { analysisTimedOut = true; break; }
      const testFiles = moduleTests(headGraph, changed.file, changed.name);
      addPath({ id: impactId(`unresolved:${unresolvedImports.join(",")}`, changed.file, "runtime_unknown"), sourceFile: changed.file, sourceSymbol: changed.name, file: changed.file, symbol: changed.name, classification: "runtime_unknown", reason: `Unresolved relative imports remain in the graph: ${unresolvedImports.join(", ")}.`, testFiles, verified: false, verificationState: "unknown", modifiedByPr: true });
    }
  }
  const unverifiedPaths = paths.filter((item) => item.verificationState !== "verified" && item.verificationState !== "not_applicable");
  const findings = unverifiedPaths.map((item) => findingForPath(item, options.config.test_integrity.mode === "blocking" && options.config.impact.fail_on.includes("critical_unverified_impact")));
  const unknowns: string[] = [];
  unknowns.push(...headGraph.unknowns, ...baseGraph.unknowns);
  if (!options.coverage?.available) unknowns.push("No coverage artifact was available for impact verification.");
  if (paths.some((item) => item.dynamic)) unknowns.push("Dynamic imports or runtime references could not be resolved statically.");
  if (graphTruncated) unknowns.push(`Static graph file analysis was capped at ${options.config.limits.max_files_analyzed} files.`);
  if (symbolLimitExceeded) unknowns.push(`Static graph symbol analysis exceeded the configured limit of ${options.config.limits.max_symbols_analyzed} symbols.`);
  if (analysisTimedOut || timedOut()) unknowns.push(timeoutReason);
  const finalUnknowns = [...new Set(unknowns)].sort();
  return {
    filesAnalyzed,
    symbolsAnalyzed,
    changedSymbols: [...symbols].sort((a, b) => `${a.file}:${a.line}:${a.name}`.localeCompare(`${b.file}:${b.line}:${b.name}`)),
    paths: [...paths].sort((a, b) => `${a.file}:${a.symbol ?? ""}:${a.id}`.localeCompare(`${b.file}:${b.symbol ?? ""}:${b.id}`)),
    downstreamConsumers: paths.filter((item) => !["direct", "public_api", "test_only", "generated", "runtime_unknown"].includes(item.classification)).length,
    impactedTests: new Set(paths.flatMap((item) => item.testFiles)).size,
    impactedPathsExecuted: paths.filter((item) => item.verificationState === "verified").length,
    unverifiedPaths: [...unverifiedPaths].sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => `${a.file}:${a.line}:${a.ruleId}`.localeCompare(`${b.file}:${b.line}:${b.ruleId}`)),
    unknowns: finalUnknowns,
  };
}
