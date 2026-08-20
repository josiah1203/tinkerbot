import type { AssuranceBundle, EvidenceContract } from "./assurance-types";

export type Severity = "info" | "warning" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type ReviewAssessment = "CLEAR" | "NEEDS_HUMAN_REVIEW" | "REVISE";
export type LanguageId = "typescript" | "javascript" | "python" | "go" | "rust" | "c" | "cpp";
export type LanguageMode = "auto" | "explicit";

export interface LanguageConfig {
  mode: LanguageMode;
  include: LanguageId[];
  exclude: LanguageId[];
}

export interface LanguageCapabilities {
  syntax: boolean;
  imports: boolean;
  symbols: boolean;
  tests: boolean;
  coverage: string[];
  mutation: string[];
}

export interface LanguageSupportSummary {
  language: LanguageId;
  files: number;
  capabilities: LanguageCapabilities;
  unknowns: string[];
}
export type FindingCategory = "test_integrity" | "coverage" | "mutation" | "impact" | "contract" | "fixture" | "artifact" | "baseline" | "dependency" | "scope" | "release" | "system";
export type ResolutionState = "open" | "unknown" | "informational" | "not_applicable";
export type ImpactVerificationState = "verified" | "partially_verified" | "unverified" | "unknown" | "not_applicable";
export type BaselineFindingState = "new" | "existing" | "resolved" | "unknown" | "waived" | "expired";
export type ModuleStatus = "pass" | "needs_review" | "unknown" | "not_run" | "fail";

export interface RuleIgnore {
  rule: string;
  path?: string;
  reason: string;
}

export interface Evidence {
  before?: string;
  after?: string;
  detail?: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  file?: string;
  line?: number;
  column?: number;
  startLine?: number;
  endLine?: number;
  message: string;
  explanation: string;
  evidence?: Evidence;
  suggestedAction: string;
  confidence: Confidence;
  title?: string;
  fingerprint?: string;
  module?: string;
  evidenceRefs?: string[];
  baselineState?: BaselineFindingState;
  resolution?: ResolutionState;
  toolVersion?: string;
  baseSha?: string;
  headSha?: string;
  classification?: string;
  blocking?: boolean;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  additions: number;
  deletions: number;
  changedLines: number[];
  deletedLines: number[];
  hunks: DiffHunk[];
  patch: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: string[];
}

export interface FrameworkConfig {
  test_runner: "vitest" | "jest" | string;
  command: string;
  coverage_file?: string;
  test_timeout_seconds: number;
}

export interface MutationConfig {
  enabled: boolean;
  max_mutants: number;
  changed_lines_only: boolean;
  timeout_seconds: number;
  command?: string;
}

export interface TestIntegrityConfig {
  mode: "advisory" | "blocking";
  require_new_tests_fail_on_base: boolean;
  run_base_tests: boolean;
  mutation_testing: MutationConfig;
  ignores: RuleIgnore[];
}

export interface ImpactConfig {
  max_dependency_depth: number;
  include_tests: boolean;
  include_public_exports: boolean;
  include_routes: boolean;
  fail_on: string[];
}

export interface OutputConfig {
  check_run: boolean;
  sticky_comment: boolean;
  sarif: boolean;
  annotations: boolean;
  fail_on_unknown: boolean;
}

export interface AnalysisLimits {
  max_changed_files: number;
  max_changed_lines: number;
  max_files_analyzed: number;
  max_symbols_analyzed: number;
  max_findings: number;
  analysis_timeout_seconds: number;
}

export interface ValidationConfig {
  strict: boolean;
  allow_shell_commands: boolean;
  /** Run bounded, read-only language toolchain syntax checks during static analysis. */
  toolchain_checks: boolean;
}

export interface BaselineConfig {
  path: string;
  enabled: boolean;
  fail_on_new: boolean;
  waivers: Waiver[];
}

export interface FixtureConfig {
  enabled: boolean;
  max_snapshot_lines: number;
  approved_paths: string[];
  generated_paths: string[];
  require_acknowledgement: boolean;
}

export interface SelectionConfig {
  confidence_threshold: Confidence;
  full_suite_on_unknown: boolean;
}

export interface PolicyConfig {
  pack: string;
}

export interface PrProofConfig {
  version: number;
  framework: FrameworkConfig;
  languages: LanguageConfig;
  base: { ref: string };
  test_integrity: TestIntegrityConfig;
  impact: ImpactConfig;
  output: OutputConfig;
  limits: AnalysisLimits;
  validation: ValidationConfig;
  baseline: BaselineConfig;
  fixtures: FixtureConfig;
  selection: SelectionConfig;
  policy: PolicyConfig;
  [key: string]: unknown;
}

export interface CoverageFile {
  file: string;
  lines: Record<number, number>;
  functions?: Record<string, number>;
  branches?: Record<string, number>;
}

export interface CoverageReport {
  format: "lcov" | "istanbul" | "coverage.py" | "go-coverprofile" | "gcov" | "llvm-cov" | "unknown";
  files: Record<string, CoverageFile>;
  source?: string;
  available: boolean;
  unknowns?: string[];
}

export interface CoverageSummary {
  available: boolean;
  changedExecutableLines: number;
  changedLinesCovered: number;
  changedLinesCoveredByModifiedTests: number;
  changedLinesNotCovered: number;
  percentage: number | null;
  coverageDelta: number | null;
  highRiskUncovered: string[];
  uncoveredLines: string[];
}

export type MutationState = "killed" | "survived" | "timeout" | "no_coverage" | "not_run" | "unknown";

export interface MutationResult {
  id: string;
  file?: string;
  line?: number;
  mutator?: string;
  description?: string;
  status: MutationState;
  reason?: string;
}

export interface MutationSummary {
  enabled: boolean;
  attempted: boolean;
  results: MutationResult[];
  killed: number;
  survived: number;
  timedOut: number;
  noCoverage: number;
  notRun: number;
  unknown: number;
  cacheHit: boolean;
  scope: string[];
  limitation?: string;
}

export interface ProvenanceRecord {
  testFile: string;
  testName?: string;
  sourceFile: string;
  sourceSymbol?: string;
  changedLines: number[];
  coverageEvidence: { available: boolean; coveredLines: number[]; changedLineCovered: boolean };
  executionEvidence: "executed" | "not_executed" | "unknown";
  provenanceMethod: "runtime_coverage" | "ast_symbol" | "import_graph" | "file_proximity" | "naming_convention" | "unresolved";
  confidence: Confidence;
  relationship: "direct" | "indirect" | "nearby" | "unresolved";
  rationale: string;
}

export interface NonVacuityResult {
  testFile: string;
  line?: number;
  status: "meaningful" | "passes_on_base" | "head_failed" | "base_unknown" | "not_run" | "unknown";
  baseExitCode?: number | null;
  headExitCode?: number | null;
  message: string;
}

export interface TestIntegrityReport {
  findings: Finding[];
  newTests: number;
  modifiedTests: number;
  deletedTests: number;
  testsPassingOnBase: number;
  nonVacuity: NonVacuityResult[];
  coverage: CoverageSummary;
  mutation?: MutationSummary;
  provenance?: ProvenanceRecord[];
  unknowns: string[];
}

export type ImpactClassification = "direct" | "downstream" | "public_api" | "cross_package" | "runtime_unknown" | "test_only" | "generated";

export interface ImpactPath {
  id: string;
  sourceFile: string;
  sourceSymbol?: string;
  file: string;
  symbol?: string;
  classification: ImpactClassification;
  reason: string;
  testFiles: string[];
  verified: boolean;
  coverageLines?: number[];
  modifiedByPr: boolean;
  verificationState: ImpactVerificationState;
  dynamic?: boolean;
}

export interface ChangedSymbol {
  name: string;
  file: string;
  line: number;
  kind: string;
  change: "added" | "modified" | "deleted" | "renamed" | "file";
  exported: boolean;
}

export interface ImpactReport {
  filesAnalyzed: number;
  symbolsAnalyzed: number;
  changedSymbols: ChangedSymbol[];
  paths: ImpactPath[];
  downstreamConsumers: number;
  impactedTests: number;
  impactedPathsExecuted: number;
  unverifiedPaths: ImpactPath[];
  findings: Finding[];
  unknowns: string[];
}

export interface Waiver {
  ruleId: string;
  fingerprint?: string;
  path?: string;
  reason: string;
  owner: string;
  createdAt: string;
  expiresAt?: string;
  issue?: string;
}

export interface BaselineEntry {
  fingerprint: string;
  ruleId: string;
  file?: string;
  message: string;
  severity: Severity;
  createdAt: string;
  owner?: string;
  rationale?: string;
  issue?: string;
  aliases?: string[];
}

export interface BaselineDocument {
  schemaVersion: 1;
  repository: string;
  revision: string;
  toolVersion: string;
  generatedAt: string;
  entries: BaselineEntry[];
  waivers: Waiver[];
}

export interface BaselineComparison {
  schemaVersion: 1;
  baselineRevision: string;
  currentRevision: string;
  stale: boolean;
  unknowns: string[];
  newCount: number;
  existingCount: number;
  resolvedCount: number;
  waivedCount: number;
  expiredWaiverCount: number;
  findings: Array<{ fingerprint: string; ruleId: string; file?: string; state: BaselineFindingState; reason?: string }>;
  resolved: BaselineEntry[];
}

export interface ArtifactEvidence {
  type: "lcov" | "istanbul" | "coverage.py" | "go-coverprofile" | "gcov" | "llvm-cov" | "junit" | "jest" | "vitest" | "stryker" | "sarif" | "generic";
  producer?: string;
  producerVersion?: string;
  revision?: string;
  timestamp?: string;
  source: string;
  status: "parsed" | "partial" | "malformed" | "missing";
  completeness: "complete" | "partial" | "unknown";
  unknowns: string[];
  metrics: Record<string, number | string | boolean | null>;
  records: Array<Record<string, unknown>>;
}

export interface TestSelectionPlan {
  status: ModuleStatus;
  confidence: Confidence;
  selected: string[];
  related: string[];
  unrelated: string[];
  unknown: string[];
  requiresFullSuite: boolean;
  fallback: string;
  reasons: Array<{ testFile: string; status: "selected" | "related" | "unrelated" | "unknown"; reason: string; impactedFiles: string[]; impactedSymbols: string[]; confidence: Confidence }>;
  unknowns: string[];
}

export interface ContractChange {
  kind: "breaking" | "potentially_breaking" | "additive" | "internal" | "unknown";
  contractType: "openapi" | "typescript_exports" | "source_exports" | "graphql";
  location: string;
  before?: string;
  after?: string;
  affectedConsumers: string[];
  relatedTests: string[];
  confidence: Confidence;
}

export interface ContractReport {
  filesAnalyzed: number;
  changes: ContractChange[];
  findings: Finding[];
  unknowns: string[];
}

export interface FixtureReport {
  filesAnalyzed: number;
  snapshotFiles: string[];
  findings: Finding[];
  unknowns: string[];
}

export interface HistoryRecord {
  schemaVersion: 1;
  repository: string;
  base: string;
  head: string;
  toolVersion: string;
  recordedAt: string;
  verdict: Verdict;
  findingsByRule: Record<string, number>;
  unknownRate: number | null;
  coverage: number | null;
  mutantsAttempted: number;
  mutantsKilled: number;
  selectedTests: number | null;
  durationMs: number | null;
  changedFiles: number | null;
  baselineChanges: number | null;
  reviewStatus?: string;
}

export interface ReportSummary {
  assertionsWeakened: number;
  newTests: number;
  testsPassingOnBase: number;
  changedLinesCoveredPercentage: number | null;
  mutantsKilled: number;
  mutantsTotal: number;
  changedSymbols: number;
  downstreamConsumers: number;
  impactedTests: number;
  impactedPathsExecuted: number;
  impactedPathsTotal: number;
  unverifiedPaths: number;
}

export interface PrProofReport {
  schemaVersion: 1;
  schemaId?: string;
  toolVersion: string;
  repository: string;
  base: string;
  head: string;
  generatedAt?: string;
  verdict: Verdict;
  /** Advisory only. Never copied into `verdict`. */
  reviewAssessment?: ReviewAssessment;
  summary: ReportSummary;
  findings: Finding[];
  testIntegrity?: TestIntegrityReport;
  impact?: ImpactReport;
  baseline?: BaselineComparison;
  policy?: { pack: string; rationale: string; unknownHandling: "advisory" | "fail" };
  provenance?: ProvenanceRecord[];
  artifacts?: ArtifactEvidence[];
  selection?: TestSelectionPlan;
  contracts?: ContractReport;
  fixtures?: FixtureReport;
  languages?: LanguageSupportSummary[];
  /** Optional additive change-assurance data. The deterministic report remains authoritative. */
  assurance?: AssuranceBundle;
  /** Versioned source-minimized evidence envelope. It is additive and never overrides verdict/findings. */
  evidence?: EvidenceContract;
  limitations: string[];
}

export interface UsageSummary {
  durationMs: number;
  filesAnalyzed: number;
  symbolsAnalyzed: number;
  mutantsAttempted: number;
  mutationCache: "hit" | "miss" | "disabled" | "not_run";
  coverage: "available" | "unavailable";
  findingsByRule: Record<string, number>;
  verdict: Verdict;
  unknownReasons: string[];
}
