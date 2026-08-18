import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { redactSecrets, repositoryRelativePath, resolveRepositoryPath } from "../../core/src/safety";
import {
  ASSURANCE_SCHEMA_ID,
  ASSURANCE_SCHEMA_VERSION,
  type AgentAdmissionResult,
  type AgentExecutionReceipt,
  type AgentPolicy,
  type AgentPolicyState,
  type ArchitectureBinding,
  type AssuranceBenchmarkCase,
  type AssuranceBundle,
  type AssuranceObjectMetadata,
  type AssuranceProvenance,
  type AssuranceReportInput,
  type AssuranceState,
  type ArtifactReference,
  type AuthorityTier,
  type ChangeAssuranceRecord,
  type ChangeContract,
  type ChangeContractAssessment,
  type ChangeSet,
  type ChangeSetAssessment,
  type ChangedFileFingerprint,
  type ChangedSymbolFingerprint,
  type ContractViolation,
  type CoverageDimension,
  type CoverageDimensionResult,
  type DecisionRecord,
  type EvidenceFreshness,
  type EvidenceFreshnessState,
  EVIDENCE_CONTRACT_SCHEMA_ID,
  EVIDENCE_CONTRACT_SCHEMA_VERSION,
  type EvidenceContract,
  type EvidenceContractFinding,
  type EvidenceResultState,
  type EvidenceReference,
  type FindingLifecycleEvent,
  type FindingLifecycleResult,
  type FindingLifecycleState,
  type FreshnessContext,
  type GraphEdgeType,
  type GraphNodeType,
  type InvocationMetadata,
  type PrivacyClassification,
  type ReleaseManifest,
  type ReleaseSafetyAssessment,
  type ReplayMetadata,
  type ReviewCalibrationEvent,
  type RuntimeOutcome,
  type VerificationCoverage,
  type VerificationCoverageSurface,
  type VerificationGraphEdge,
  type VerificationGraphNode,
  type VerificationGraphSnapshot,
  type VerificationReceipt,
} from "../../core/src/assurance-types";
import type {
  Finding,
  FileDiff,
  ImpactReport,
  PrProofReport,
  Severity,
} from "../../core/src/types";

export * from "../../core/src/assurance-types";

const LIFECYCLE_FILE = ".tinkerbot/finding-lifecycle.jsonl";
const OUTCOME_FILE = ".tinkerbot/outcomes.jsonl";
const CONTRACT_FILE = ".tinkerbot/change-contract.yml";
const ALL_COVERAGE_DIMENSIONS: CoverageDimension[] = [
  "test_evidence",
  "test_execution",
  "branch_evidence",
  "mutation_evidence",
  "contract_evidence",
  "fixture_evidence",
  "ownership_evidence",
  "policy_evidence",
  "rollback_evidence",
  "runtime_evidence",
];

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  id: "default-agent-admission",
  version: "1",
  authRequiresSecurityReview: true,
  migrationsRequireRollbackEvidence: true,
  deploymentsRequireReleaseAssessment: true,
  maxChangedFiles: 100,
  maxChangedSymbols: 250,
  unresolvedHighSeverityBlocks: true,
  agentCannotApproveOwnChange: true,
  sourceUploadAllowed: false,
};

export const ASSURANCE_BENCHMARK_CASES: readonly AssuranceBenchmarkCase[] = [
  { id: "removed-assertion", category: "removed_assertion", expectedStates: ["new", "blocking"], notes: "A weakened assertion remains deterministic test-integrity evidence." },
  { id: "surviving-mutant", category: "surviving_mutant", expectedStates: ["present", "open"], notes: "A surviving mutant is evidence, not a production defect claim." },
  { id: "api-break", category: "api_break", expectedStates: ["violations", "blocking"], notes: "A removed public operation is a deterministic contract finding." },
  { id: "migration-error", category: "migration_error", expectedStates: ["missing", "unknown", "blocking"], notes: "Migration rollback evidence is required when a contract says it is required." },
  { id: "cross-package-impact", category: "cross_package_impact", expectedStates: ["present", "partial", "unknown"], notes: "Cross-package edges are bounded and may remain partial." },
  { id: "auth-path", category: "auth_path", expectedStates: ["agent_policy_blocked", "agent_policy_satisfied"], notes: "Admission uses explicit agent provenance and human review metadata." },
  { id: "fixture-drift", category: "fixture_drift", expectedStates: ["new", "missing", "stale"], notes: "Fixture evidence is separate from line coverage." },
  { id: "unknown-runtime", category: "unknown_runtime", expectedStates: ["unknown", "runtime_unknown"], notes: "Dynamic runtime relationships are never upgraded to verified." },
];

function objectWithoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** Stable JSON with sorted object keys. Array order is preserved because it can carry meaning. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
}

export function deterministicSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableId(namespace: string, value: unknown): string {
  return `${namespace}:${sha256(deterministicSerialize(value)).slice(0, 32)}`;
}

function isoNow(value?: string): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function metadata(kind: string, identity: unknown, now?: string, provenance: AssuranceProvenance[] = [{ source: "tinkerbot", authority: "deterministic" }], privacy: PrivacyClassification = "metadata"): AssuranceObjectMetadata {
  return {
    schemaVersion: ASSURANCE_SCHEMA_VERSION,
    schemaId: ASSURANCE_SCHEMA_ID,
    id: stableId(kind, identity),
    createdAt: isoNow(now),
    provenance,
    privacy,
    exportable: true,
  };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function redactedInvocation(value: InvocationMetadata): InvocationMetadata {
  return {
    command: redactSecrets(value.command),
    arguments: value.arguments?.map((item) => redactSecrets(item)),
    environment: value.environment ? Object.fromEntries(Object.entries(value.environment).map(([key, item]) => [key, redactSecrets(item)])) : undefined,
    exitCode: value.exitCode,
    durationMs: value.durationMs,
    timeoutMs: value.timeoutMs,
    redacted: true,
  };
}

function safeArtifactSource(root: string | undefined, source: string): string {
  if (!root) return normalizePath(path.basename(source));
  try {
    const relative = repositoryRelativePath(root, source);
    return relative === "." ? path.basename(source) : normalizePath(relative);
  } catch {
    return "<external-artifact>";
  }
}

function artifactFromSource(root: string | undefined, source: string, type: string, requiredForReplay: boolean, uploaded = false): ArtifactReference {
  const safeSource = safeArtifactSource(root, source);
  let status: ArtifactReference["status"] = "unknown";
  let digest: string | undefined;
  let sizeBytes: number | undefined;
  if (root) {
    try {
      const file = resolveRepositoryPath(root, source);
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        const bytes = fs.readFileSync(file);
        digest = sha256(bytes);
        sizeBytes = stat.size;
        status = "present";
      } else status = "missing";
    } catch {
      status = "missing";
    }
  }
  return { id: stableId("artifact", { type, source: safeSource, digest }), type, source: safeSource, sha256: digest, sizeBytes, status, requiredForReplay, uploaded };
}

export function changedFileFingerprint(diff: Pick<FileDiff, "path" | "status" | "additions" | "deletions">): ChangedFileFingerprint {
  const file = { path: normalizePath(diff.path), status: diff.status, additions: diff.additions, deletions: diff.deletions };
  return { ...file, fingerprint: `sha256:${sha256(deterministicSerialize(file))}` };
}

export function changedSymbolFingerprint(symbol: { file: string; name: string; change?: string }): ChangedSymbolFingerprint {
  const item = { file: normalizePath(symbol.file), symbol: symbol.name, change: symbol.change ?? "unknown" };
  return { ...item, fingerprint: `sha256:${sha256(deterministicSerialize(item))}` };
}

function evidenceReference(type: string, status: AssuranceState, detail: string, authority: AuthorityTier = "deterministic", source?: string): EvidenceReference {
  const identity = { type, status, detail, source };
  return { id: stableId("evidence", identity), type, status, source, authority, privacy: "metadata", detail };
}

function reportArtifacts(report: PrProofReport | undefined, root: string | undefined): ArtifactReference[] {
  return (report?.artifacts ?? []).map((artifact) => artifactFromSource(root, artifact.source, artifact.type, artifact.status !== "missing"));
}

export interface VerificationReceiptOptions {
  repository: string;
  baseSha: string;
  headSha: string;
  mergeGroupSha?: string;
  report?: PrProofReport;
  impact?: ImpactReport;
  diffs?: FileDiff[];
  root?: string;
  toolName?: string;
  toolVersion?: string;
  adapterVersions?: Record<string, string>;
  commands?: InvocationMetadata[];
  inputArtifacts?: ArtifactReference[];
  outputArtifacts?: ArtifactReference[];
  configurationFingerprint?: string;
  policyVersion?: string;
  replay?: Partial<ReplayMetadata>;
  runtime?: VerificationReceipt["runtime"];
  expiresAt?: string;
  now?: string;
}

function receiptPayload(receipt: VerificationReceipt): Record<string, unknown> {
  const { integrity: _integrity, ...payload } = receipt;
  return payload;
}

export function receiptDigest(receipt: VerificationReceipt): string {
  return `sha256:${sha256(deterministicSerialize(receiptPayload(receipt)))}`;
}

export function createVerificationReceipt(options: VerificationReceiptOptions): VerificationReceipt {
  const report = options.report;
  const impact = options.impact ?? report?.impact;
  const fileFingerprints = (options.diffs ?? []).map(changedFileFingerprint).sort((a, b) => a.path.localeCompare(b.path));
  const changedSymbols = (impact?.changedSymbols ?? []).map((symbol) => changedSymbolFingerprint({ file: symbol.file, name: symbol.name, change: symbol.change })).sort((a, b) => `${a.file}:${a.symbol}`.localeCompare(`${b.file}:${b.symbol}`));
  const tool = { name: options.toolName ?? "tinkerbot", version: options.toolVersion ?? report?.toolVersion ?? "unknown", adapters: Object.fromEntries(Object.entries(options.adapterVersions ?? {}).sort()) };
  const inputArtifacts = [...(options.inputArtifacts ?? []), ...reportArtifacts(report, options.root)].sort((a, b) => a.id.localeCompare(b.id));
  const outputArtifacts = (options.outputArtifacts ?? []).map((artifact) => ({ ...artifact, source: safeArtifactSource(options.root, artifact.source) })).sort((a, b) => a.id.localeCompare(b.id));
  const limitations = [...new Set(report?.limitations ?? [])].sort();
  const unsupported = inputArtifacts.filter((artifact) => artifact.status === "unsupported").map((artifact) => artifact.source);
  const missing = inputArtifacts.filter((artifact) => artifact.status === "missing").map((artifact) => artifact.source);
  const unknown = [...limitations, ...(fileFingerprints.length ? [] : ["Changed-file fingerprints were not supplied."])]
    .filter(Boolean)
    .sort();
  const states = { partial: Boolean(limitations.length || inputArtifacts.some((artifact) => artifact.status !== "present")), missing, unsupported, unknown };
  const evidenceRefs = [
    ...(report?.findings ?? []).map((finding) => evidenceReference(finding.category, finding.resolution === "unknown" ? "unknown" : "present", finding.fingerprint ?? finding.id)),
    ...(impact?.paths ?? []).map((item) => evidenceReference("impact", item.verificationState === "verified" ? "present" : item.verificationState === "not_applicable" ? "not_applicable" : "unknown", item.reason)),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const replay: ReplayMetadata = {
    required: options.replay?.required ?? true,
    dependencies: [...new Set(options.replay?.dependencies ?? [])].sort(),
    commands: [...new Set(options.replay?.commands ?? (options.commands ?? []).map((item) => item.command))].sort(),
    toolVersions: Object.fromEntries(Object.entries(options.replay?.toolVersions ?? { [tool.name]: tool.version }).sort()),
    configurationFingerprint: options.replay?.configurationFingerprint ?? options.configurationFingerprint,
    artifacts: [...new Set(options.replay?.artifacts ?? inputArtifacts.filter((artifact) => artifact.requiredForReplay).map((artifact) => artifact.id))].sort(),
    networkRequired: options.replay?.networkRequired ?? false,
    secretsRequired: options.replay?.secretsRequired ?? false,
    sourceRequired: options.replay?.sourceRequired ?? false,
    limitations: [...new Set(options.replay?.limitations ?? [])].sort(),
  };
  const identity = {
    repository: options.repository,
    baseSha: options.baseSha,
    headSha: options.headSha,
    mergeGroupSha: options.mergeGroupSha,
    changedFiles: fileFingerprints,
    changedSymbols,
    tool,
    configurationFingerprint: options.configurationFingerprint,
  };
  const base = {
    ...metadata("verification-receipt", identity, options.now, [{ source: "tinkerbot", authority: "deterministic", capturedAt: isoNow(options.now) }], "metadata"),
    kind: "verification-receipt" as const,
    repository: options.repository,
    baseSha: options.baseSha,
    headSha: options.headSha,
    mergeGroupSha: options.mergeGroupSha,
    changedFiles: fileFingerprints,
    changedSymbols,
    tool,
    commands: (options.commands ?? []).map(redactedInvocation),
    inputArtifacts,
    outputArtifacts,
    evidenceRefs,
    policyVersion: options.policyVersion ?? report?.policy?.pack,
    configurationFingerprint: options.configurationFingerprint,
    runtime: options.runtime ?? { durationMs: undefined, timeoutMs: undefined },
    states,
    sourceUpload: "not_uploaded" as const,
    diffUpload: "not_uploaded" as const,
    verdict: report?.verdict ?? "UNKNOWN" as const,
    replay,
    expiresAt: options.expiresAt,
  };
  const receipt = { ...base, integrity: { algorithm: "sha256" as const, digest: "" } };
  receipt.integrity.digest = receiptDigest(receipt);
  return receipt;
}

export interface EvidenceContractOptions {
  report: PrProofReport;
  repository?: string;
  baseSha?: string;
  headSha?: string;
  treeSha?: string;
  changeId?: string;
  pullRequestNumber?: number;
  branch?: string;
  policyVersion?: string;
  configuration?: unknown;
  configurationHash?: string;
  changedFiles?: string[];
  changedSymbols?: string[];
  runId?: string;
  receiptId?: string;
  generatedAt?: string;
  observedAt?: string;
  environment?: Partial<EvidenceContract["environment"]>;
  optionalExplanation?: string;
  provenance?: AssuranceProvenance[];
}

function evidenceStateForReport(report: PrProofReport): EvidenceResultState {
  if (report.baseline?.stale) return "STALE";
  if (report.verdict === "PASS") return "PASS";
  if (report.verdict === "FAIL") return "FAIL";
  return "UNKNOWN";
}

function evidenceStateForFinding(finding: Finding, report: PrProofReport): EvidenceResultState {
  if (finding.baselineState === "expired") return "STALE";
  if (finding.resolution === "unknown") return "UNKNOWN";
  if (finding.resolution === "not_applicable") return "NOT_APPLICABLE";
  if (report.verdict === "FAIL" || finding.blocking || finding.severity === "critical" || finding.severity === "high") return "FAIL";
  return report.verdict === "PASS" ? "PASS" : "UNKNOWN";
}

function evidenceContractPayload(contract: EvidenceContract): Record<string, unknown> {
  const { integrity: _integrity, ...payload } = contract;
  return payload;
}

export function evidenceContractDigest(contract: EvidenceContract): string {
  return `sha256:${sha256(deterministicSerialize(evidenceContractPayload(contract)))}`;
}

export function createEvidenceContract(options: EvidenceContractOptions): EvidenceContract {
  const report = options.report;
  const repository = options.repository ?? report.repository;
  const baseSha = options.baseSha ?? report.base;
  const headSha = options.headSha ?? report.head;
  const generatedAt = isoNow(options.generatedAt);
  const observedAt = isoNow(options.observedAt ?? generatedAt);
  const affectedFiles = [...new Set((options.changedFiles ?? report.impact?.changedSymbols.map((item) => item.file) ?? []).map(normalizePath))].sort();
  const affectedSymbols = [...new Set((options.changedSymbols ?? report.impact?.changedSymbols.map((item) => `${normalizePath(item.file)}#${item.name}`) ?? []))].sort();
  const baselineRefs = [...new Set((report.findings ?? []).filter((finding) => finding.baselineState).map((finding) => finding.fingerprint ?? finding.id))].sort();
  const waiverRefs = [...new Set((report.findings ?? []).filter((finding) => finding.baselineState === "waived").map((finding) => finding.fingerprint ?? finding.id))].sort();
  const findings: EvidenceContractFinding[] = [...(report.findings ?? [])].map((finding) => ({
    id: finding.id,
    fingerprint: finding.fingerprint ?? `sha256:${sha256(deterministicSerialize(finding))}`,
    ruleId: finding.ruleId,
    severity: finding.severity,
    state: evidenceStateForFinding(finding, report),
    file: finding.file ? normalizePath(finding.file) : undefined,
    startLine: finding.startLine ?? finding.line,
    endLine: finding.endLine ?? finding.startLine ?? finding.line,
    module: finding.module,
    evidenceRefs: [...new Set(finding.evidenceRefs ?? [])].sort(),
    baselineRef: finding.baselineState ? finding.fingerprint ?? finding.id : undefined,
    waiverRef: finding.baselineState === "waived" ? finding.fingerprint ?? finding.id : undefined,
  })).sort((a, b) => `${a.file ?? ""}:${a.startLine ?? 0}:${a.ruleId}:${a.id}`.localeCompare(`${b.file ?? ""}:${b.startLine ?? 0}:${b.ruleId}:${b.id}`));
  const unknownStates = [...new Set([...(report.limitations ?? []), ...(report.impact?.unknowns ?? []), ...(report.testIntegrity?.unknowns ?? []), ...(report.contracts?.unknowns ?? []), ...(report.fixtures?.unknowns ?? [])])].sort();
  const staleStates = [...new Set([...(report.baseline?.stale ? ["Baseline revision is stale."] : []), ...findings.filter((finding) => finding.state === "STALE").map((finding) => `${finding.id} is stale.`)])].sort();
  const policyResult: EvidenceResultState = report.policy?.unknownHandling === "fail" && unknownStates.length ? "FAIL" : unknownStates.length ? "UNKNOWN" : evidenceStateForReport(report);
  const identity = { repository, baseSha, headSha, treeSha: options.treeSha ?? headSha, changeId: options.changeId, pullRequestNumber: options.pullRequestNumber, affectedFiles, affectedSymbols, policyVersion: options.policyVersion ?? report.policy?.pack };
  const runId = options.runId ?? stableId("run", identity);
  const receiptId = options.receiptId ?? stableId("receipt", { ...identity, runId });
  const environment = {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: process.env.GITHUB_ACTIONS === "true",
    runner: process.env.RUNNER_OS && /^[A-Za-z0-9_.-]{1,40}$/.test(process.env.RUNNER_OS) ? process.env.RUNNER_OS : undefined,
    ...options.environment,
    // Evidence contracts are source-minimized and self-contained. An adapter may
    // describe its environment, but it cannot weaken this privacy guarantee.
    networkRequired: false as const,
    secretsRequired: false as const,
  };
  const contract: EvidenceContract = {
    schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION,
    schemaId: EVIDENCE_CONTRACT_SCHEMA_ID,
    repositoryIdentity: { name: repository, identityHash: `sha256:${sha256(deterministicSerialize({ repository }))}` },
    commitIdentity: { baseSha, headSha, treeSha: options.treeSha ?? headSha },
    changeIdentity: { changeId: options.changeId, pullRequestNumber: options.pullRequestNumber, branch: options.branch },
    runId,
    receiptId,
    tool: { name: "tinkerbot", version: report.toolVersion },
    policy: { version: options.policyVersion ?? report.policy?.pack ?? "default", result: policyResult },
    configurationHash: options.configurationHash ?? `sha256:${sha256(deterministicSerialize(options.configuration ?? {}))}`,
    environment,
    verdict: staleStates.length ? "STALE" : evidenceStateForReport(report),
    findings,
    unknownStates,
    staleStates,
    provenance: options.provenance ?? [{ source: "tinkerbot", authority: "deterministic", capturedAt: observedAt }],
    evidenceHashes: [...new Set([...findings.map((finding) => finding.fingerprint), ...findings.flatMap((finding) => finding.evidenceRefs), ...affectedFiles.map((file) => `sha256:${sha256(file)}`)])].sort(),
    affectedFiles,
    affectedSymbols,
    baselineRefs,
    waiverRefs,
    generatedAt,
    observedAt,
    sourceUpload: "not_uploaded",
    diffUpload: "not_uploaded",
    optionalExplanation: options.optionalExplanation ? { text: redactSecrets(options.optionalExplanation).slice(0, 8_192), authority: "advisory" } : undefined,
    integrity: { algorithm: "sha256", digest: "" },
  };
  contract.integrity.digest = evidenceContractDigest(contract);
  return contract;
}

export function validateEvidenceContract(contract: EvidenceContract): void {
  if (!contract || typeof contract !== "object") throw new Error("Evidence contract must be an object");
  if (contract.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION || contract.schemaId !== EVIDENCE_CONTRACT_SCHEMA_ID) throw new Error("Unsupported evidence contract schema");
  for (const field of ["repositoryIdentity", "commitIdentity", "changeIdentity", "runId", "receiptId", "tool", "policy", "configurationHash", "environment", "verdict", "findings", "unknownStates", "staleStates", "provenance", "evidenceHashes", "affectedFiles", "affectedSymbols", "baselineRefs", "waiverRefs", "generatedAt", "observedAt", "integrity"]) if (!(field in contract)) throw new Error(`Evidence contract is missing ${field}`);
  if (contract.sourceUpload !== "not_uploaded" || contract.diffUpload !== "not_uploaded") throw new Error("Evidence contract cannot claim a source or diff upload");
  if (contract.integrity.algorithm !== "sha256" || contract.integrity.digest !== evidenceContractDigest(contract)) throw new Error("Evidence contract integrity digest does not match");
  if (contract.optionalExplanation && contract.optionalExplanation.authority !== "advisory") throw new Error("Optional explanations must be advisory");
}

export function serializeEvidenceContract(contract: EvidenceContract): string {
  validateEvidenceContract(contract);
  return `${deterministicSerialize(contract)}\n`;
}

export type ReceiptCheckStatus = "pass" | "fail" | "unknown";

export interface ReceiptVerificationCheck {
  name: string;
  status: ReceiptCheckStatus;
  detail: string;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  integrityValid: boolean;
  applicable: boolean;
  status: "valid" | "partial" | "invalid" | "expired" | "stale" | "unsupported";
  verdict: VerificationReceipt["verdict"];
  checks: ReceiptVerificationCheck[];
  failures: string[];
  unknowns: string[];
}

export interface ReceiptVerificationOptions {
  root?: string;
  repository?: string;
  baseSha?: string;
  headSha?: string;
  expectedToolVersion?: string;
  expectedConfigurationFingerprint?: string;
  now?: string;
}

function addCheck(checks: ReceiptVerificationCheck[], name: string, status: ReceiptCheckStatus, detail: string): void {
  checks.push({ name, status, detail });
}

export function verifyVerificationReceipt(receipt: VerificationReceipt, options: ReceiptVerificationOptions = {}): ReceiptVerificationResult {
  const checks: ReceiptVerificationCheck[] = [];
  const failures: string[] = [];
  const unknowns: string[] = [];
  if (!receipt || typeof receipt !== "object") {
    return { valid: false, integrityValid: false, applicable: false, status: "invalid", verdict: "UNKNOWN", checks: [{ name: "shape", status: "fail", detail: "Receipt is not an object." }], failures: ["Receipt is not an object."], unknowns: [] };
  }
  if (receipt.schemaVersion !== ASSURANCE_SCHEMA_VERSION || receipt.schemaId !== ASSURANCE_SCHEMA_ID) {
    addCheck(checks, "schema", "fail", `Unsupported assurance schema ${String(receipt.schemaVersion)}.`);
    failures.push("Unsupported assurance schema version.");
  } else addCheck(checks, "schema", "pass", "Assurance schema is supported.");
  const digestOk = receipt.integrity?.algorithm === "sha256" && receipt.integrity.digest === receiptDigest(receipt);
  addCheck(checks, "integrity", digestOk ? "pass" : "fail", digestOk ? "Receipt digest matches." : "Receipt digest does not match the receipt payload.");
  if (!digestOk) failures.push("Receipt integrity digest mismatch.");
  if (receipt.integrity?.signature?.status === "invalid") {
    addCheck(checks, "signature", "fail", "The optional signature is invalid.");
    failures.push("Optional signature is invalid.");
  } else if (receipt.integrity?.signature?.status === "unavailable") {
    addCheck(checks, "signature", "unknown", "No signature was available; hash integrity remains the checked property.");
    unknowns.push("Signature unavailable.");
  } else if (receipt.integrity?.signature?.status === "available") addCheck(checks, "signature", "pass", "Optional signature is present; provider-neutral key validation is not performed here.");
  const expectedPairs: Array<[string, string | undefined, string]> = [["repository", options.repository, receipt.repository], ["base", options.baseSha, receipt.baseSha], ["head", options.headSha, receipt.headSha]];
  let applicable = true;
  for (const [name, expected, actual] of expectedPairs) {
    if (expected === undefined) { addCheck(checks, name, "unknown", `No expected ${name} was provided.`); unknowns.push(`Applicability for ${name} was not checked.`); continue; }
    if (expected !== actual) { addCheck(checks, name, "fail", `Expected ${expected}; receipt states ${actual}.`); failures.push(`Receipt ${name} does not apply.`); applicable = false; }
    else addCheck(checks, name, "pass", `${name} matches the receipt.`);
  }
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (receipt.expiresAt && Number.isFinite(Date.parse(receipt.expiresAt)) && Date.parse(receipt.expiresAt) <= now) {
    addCheck(checks, "expiry", "fail", `Receipt expired at ${receipt.expiresAt}.`);
    failures.push("Receipt expired.");
  } else addCheck(checks, "expiry", "pass", "Receipt is not expired.");
  if (options.expectedToolVersion && options.expectedToolVersion !== receipt.tool.version) {
    addCheck(checks, "tool-version", "fail", `Expected tool ${options.expectedToolVersion}; receipt used ${receipt.tool.version}.`);
    failures.push("Receipt tool version is stale.");
  }
  if (options.expectedConfigurationFingerprint && options.expectedConfigurationFingerprint !== receipt.configurationFingerprint) {
    addCheck(checks, "configuration", "fail", "Receipt configuration fingerprint differs from the expected configuration.");
    failures.push("Receipt configuration is stale.");
  }
  if (options.root) {
    for (const artifact of [...receipt.inputArtifacts, ...receipt.outputArtifacts]) {
      if (!artifact.requiredForReplay && artifact.status === "missing") continue;
      try {
        const file = resolveRepositoryPath(options.root, artifact.source);
        const bytes = fs.readFileSync(file);
        const actual = sha256(bytes);
        if (artifact.sha256 && actual !== artifact.sha256) { addCheck(checks, `artifact:${artifact.id}`, "fail", `${artifact.source} hash mismatch.`); failures.push(`Artifact ${artifact.source} hash mismatch.`); }
        else addCheck(checks, `artifact:${artifact.id}`, "pass", `${artifact.source} is present and matches.`);
      } catch {
        const status: ReceiptCheckStatus = artifact.requiredForReplay ? "fail" : "unknown";
        addCheck(checks, `artifact:${artifact.id}`, status, `${artifact.source} is unavailable.`);
        (status === "fail" ? failures : unknowns).push(`Artifact ${artifact.source} is unavailable.`);
      }
    }
  } else if (receipt.inputArtifacts.some((artifact) => artifact.requiredForReplay)) {
    addCheck(checks, "artifacts", "unknown", "No repository root was provided for artifact verification.");
    unknowns.push("Required artifact hashes were not checked offline without a repository root.");
  }
  if (receipt.states.partial) unknowns.push(...receipt.states.unknown, ...receipt.states.missing.map((item) => `Missing artifact: ${item}`));
  const expired = failures.some((item) => /expired/i.test(item));
  const stale = failures.some((item) => /stale/i.test(item));
  const status = failures.some((item) => /schema/i.test(item)) ? "unsupported" : expired ? "expired" : stale ? "stale" : failures.length ? "invalid" : receipt.states.partial || unknowns.length ? "partial" : "valid";
  return { valid: failures.length === 0, integrityValid: digestOk, applicable: applicable && !failures.some((item) => /does not apply/i.test(item)), status, verdict: receipt.verdict, checks, failures: [...new Set(failures)], unknowns: [...new Set(unknowns)] };
}

export interface ReplayOptions {
  availableDependencies?: string[];
  availableToolVersions?: Record<string, string>;
  availableConfigurationFingerprint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ReplayResult {
  status: "ready" | "blocked" | "timeout" | "cancelled" | "unknown";
  requirements: ReplayMetadata;
  missingDependencies: string[];
  staleTools: string[];
  unknowns: string[];
}

export function replayVerificationReceipt(receipt: VerificationReceipt, options: ReplayOptions = {}): ReplayResult {
  const requirements = receipt.replay;
  if (options.signal?.aborted) return { status: "cancelled", requirements, missingDependencies: [], staleTools: [], unknowns: ["Replay was cancelled before it started."] };
  if (options.timeoutMs !== undefined && receipt.runtime.timeoutMs !== undefined && options.timeoutMs < receipt.runtime.timeoutMs) return { status: "timeout", requirements, missingDependencies: [], staleTools: [], unknowns: [`Replay budget ${options.timeoutMs}ms is below the receipt timeout ${receipt.runtime.timeoutMs}ms.`] };
  const available = new Set(options.availableDependencies ?? []);
  const missingDependencies = requirements.dependencies.filter((dependency) => !available.has(dependency));
  const staleTools = Object.entries(requirements.toolVersions).filter(([name, version]) => options.availableToolVersions && options.availableToolVersions[name] !== version).map(([name, version]) => `${name}@${version}`);
  const unknowns: string[] = [];
  if (requirements.networkRequired) unknowns.push("Replay requires network access.");
  if (requirements.secretsRequired) unknowns.push("Replay requires secrets that are not included in the receipt.");
  if (requirements.sourceRequired) unknowns.push("Replay requires source that is not included in the receipt.");
  if (options.availableConfigurationFingerprint && requirements.configurationFingerprint && options.availableConfigurationFingerprint !== requirements.configurationFingerprint) unknowns.push("Replay configuration fingerprint differs.");
  if (missingDependencies.length || staleTools.length) return { status: "blocked", requirements, missingDependencies, staleTools, unknowns };
  if (unknowns.length) return { status: "unknown", requirements, missingDependencies, staleTools, unknowns };
  return { status: "ready", requirements, missingDependencies, staleTools, unknowns: [] };
}

export interface VerificationGraphOptions {
  repository: string;
  revision: string;
  baseRevision?: string;
  report?: PrProofReport;
  impact?: ImpactReport;
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  owners?: Record<string, string[]>;
  now?: string;
}

function graphNode(type: GraphNodeType, label: string, state: AssuranceState, metadataValue?: Record<string, string | number | boolean | null>): VerificationGraphNode {
  const normalized = normalizePath(label);
  return { id: stableId("graph-node", { type, label: normalized }), type, label: normalized, fingerprint: `sha256:${sha256(deterministicSerialize({ type, label: normalized, metadata: metadataValue }))}`, state, metadata: metadataValue };
}

function graphEdge(from: string, to: string, type: GraphEdgeType, state: AssuranceState, evidenceRefs: string[] = [], uncertain = false): VerificationGraphEdge {
  return { id: stableId("graph-edge", { from, to, type }), from, to, type, state, evidenceRefs: [...new Set(evidenceRefs)].sort(), uncertain: uncertain || undefined };
}

function assuranceStateFromImpact(value: ImpactReport["paths"][number]["verificationState"]): AssuranceState {
  return value === "verified" ? "present" : value === "not_applicable" ? "not_applicable" : value === "unknown" ? "unknown" : "partial";
}

/**
 * Converts existing parser/impact evidence into a bounded graph snapshot. It
 * intentionally does not infer relationships that are absent from the impact
 * report; those are represented by partial/unknown state.
 */
export function buildVerificationGraph(options: VerificationGraphOptions): VerificationGraphSnapshot {
  const impact = options.impact ?? options.report?.impact;
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 3, 100));
  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 1000, 10_000));
  const maxEdges = Math.max(1, Math.min(options.maxEdges ?? maxNodes * 3, 30_000));
  const nodes = new Map<string, VerificationGraphNode>();
  const edges = new Map<string, VerificationGraphEdge>();
  const unknowns = [...(options.report?.limitations ?? []), ...(impact?.unknowns ?? [])];
  let truncated = false;
  const addNode = (node: VerificationGraphNode): VerificationGraphNode | undefined => {
    const existing = nodes.get(node.id);
    if (existing) {
      if (existing.state === "unknown" && node.state !== "unknown") nodes.set(node.id, { ...existing, state: node.state });
      return nodes.get(node.id);
    }
    if (nodes.size >= maxNodes) { truncated = true; return undefined; }
    nodes.set(node.id, node);
    return node;
  };
  const addEdge = (edge: VerificationGraphEdge): void => {
    if (edges.has(edge.id)) return;
    if (edges.size >= maxEdges) { truncated = true; return; }
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) { unknowns.push(`Graph edge ${edge.type} references a missing node.`); return; }
    edges.set(edge.id, edge);
  };
  const repositoryNode = addNode(graphNode("repository", options.repository, "present"));
  if (!repositoryNode) return graphSnapshot(options, nodes, edges, unknowns, true, maxDepth, maxNodes, maxEdges);
  const pullRequestNode = options.report ? addNode(graphNode("pull_request", `${options.repository}@${options.revision}`, "present", { head: options.revision, base: options.baseRevision ?? null })) : undefined;
  if (pullRequestNode) addEdge(graphEdge(pullRequestNode.id, repositoryNode.id, "contains", "present"));
  const fileNodes = new Map<string, VerificationGraphNode>();
  const symbolNodes = new Map<string, VerificationGraphNode>();
  const getFileNode = (file: string, state: AssuranceState): VerificationGraphNode | undefined => {
    const key = normalizePath(file);
    const existing = fileNodes.get(key);
    if (existing) return existing;
    const node = addNode(graphNode("file", key, state));
    if (node) {
      fileNodes.set(key, node);
      addEdge(graphEdge(repositoryNode.id, node.id, "contains", "present"));
    }
    return node;
  };
  const getSymbolNode = (file: string, symbol: string, state: AssuranceState): VerificationGraphNode | undefined => {
    const key = `${normalizePath(file)}#${symbol}`;
    const existing = symbolNodes.get(key);
    if (existing) return existing;
    const node = addNode(graphNode("symbol", key, state));
    const fileNode = getFileNode(file, state);
    if (node) {
      symbolNodes.set(key, node);
      if (fileNode) addEdge(graphEdge(fileNode.id, node.id, "contains", "present"));
    }
    return node;
  };
  for (const changed of impact?.changedSymbols ?? []) {
    const node = getSymbolNode(changed.file, changed.name, "present");
    if (node && pullRequestNode) addEdge(graphEdge(pullRequestNode.id, node.id, "impacts", "present"));
  }
  for (const pathEvidence of impact?.paths ?? []) {
    const pathState = assuranceStateFromImpact(pathEvidence.verificationState);
    const source = getSymbolNode(pathEvidence.sourceFile, pathEvidence.sourceSymbol ?? pathEvidence.sourceFile, pathState);
    const target = pathEvidence.symbol ? getSymbolNode(pathEvidence.file, pathEvidence.symbol, pathState) : getFileNode(pathEvidence.file, pathState);
    if (!source || !target) continue;
    const state = pathState;
    const edgeType: GraphEdgeType = pathEvidence.classification === "test_only" ? "tests" : "impacts";
    addEdge(graphEdge(source.id, target.id, edgeType, state, [], state === "unknown"));
    for (const test of pathEvidence.testFiles) {
      const testNode = addNode(graphNode("test", test, pathEvidence.verificationState === "verified" ? "present" : "unknown"));
      if (!testNode) continue;
      const testFile = getFileNode(test, testNode.state);
      if (testFile) addEdge(graphEdge(target.id, testFile.id, "tests", testNode.state, [], testNode.state === "unknown"));
    }
    if (pathEvidence.verificationState === "verified" || pathEvidence.verificationState === "unknown") {
      const evidence = addNode(graphNode("evidence", `impact:${pathEvidence.id}`, pathEvidence.verificationState === "verified" ? "present" : "unknown"));
      if (evidence) addEdge(graphEdge(target.id, evidence.id, "verified_by", state, [], state === "unknown"));
    }
  }
  for (const finding of options.report?.findings ?? []) {
    const findingNode = addNode(graphNode("finding", finding.fingerprint ?? finding.id, finding.resolution === "unknown" ? "unknown" : "present", { ruleId: finding.ruleId, severity: finding.severity }));
    if (!findingNode) continue;
    if (finding.file && finding.file !== "repository") {
      const fileNode = getFileNode(finding.file, finding.resolution === "unknown" ? "unknown" : "present");
      if (fileNode) addEdge(graphEdge(findingNode.id, fileNode.id, "impacts", finding.resolution === "unknown" ? "unknown" : "present", finding.evidenceRefs ?? [], finding.resolution === "unknown"));
    }
  }
  for (const contractChange of options.report?.contracts?.changes ?? []) {
    const apiNode = addNode(graphNode("api", contractChange.location, contractChange.kind === "unknown" ? "unknown" : "present"));
    if (apiNode && pullRequestNode) addEdge(graphEdge(pullRequestNode.id, apiNode.id, "impacts", contractChange.kind === "unknown" ? "unknown" : "present", [], contractChange.kind === "unknown"));
  }
  for (const [file, owners] of Object.entries(options.owners ?? {})) {
    const fileNode = getFileNode(file, owners.length ? "present" : "unknown");
    for (const owner of owners) {
      const ownerNode = addNode(graphNode("owner", owner, "present"));
      if (ownerNode && fileNode) addEdge(graphEdge(ownerNode.id, fileNode.id, "owns", "present"));
    }
  }
  if (!impact?.paths?.length) unknowns.push("No impact paths were available; graph completeness is limited.");
  if (truncated) unknowns.push(`Graph output was bounded at ${maxNodes} nodes and ${maxEdges} edges.`);
  return graphSnapshot(options, nodes, edges, unknowns, truncated, maxDepth, maxNodes, maxEdges);
}

function graphSnapshot(options: VerificationGraphOptions, nodes: Map<string, VerificationGraphNode>, edges: Map<string, VerificationGraphEdge>, unknowns: string[], truncated: boolean, maxDepth: number, maxNodes: number, maxEdges: number): VerificationGraphSnapshot {
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const identity = { repository: options.repository, revision: options.revision, baseRevision: options.baseRevision, nodes: sortedNodes.map((node) => node.id), edges: sortedEdges.map((edge) => edge.id) };
  return {
    ...metadata("verification-graph", identity, options.now),
    kind: "verification-graph",
    repository: options.repository,
    revision: options.revision,
    baseRevision: options.baseRevision,
    completeness: truncated || unknowns.length ? "partial" : "complete",
    nodes: sortedNodes,
    edges: sortedEdges,
    limits: { maxDepth, maxNodes, maxEdges },
    unknowns: [...new Set(unknowns)].sort(),
  };
}

export interface GraphTraversalOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface GraphTraversalResult {
  nodes: VerificationGraphNode[];
  edges: VerificationGraphEdge[];
  truncated: boolean;
  unknowns: string[];
}

export function traverseVerificationGraph(snapshot: VerificationGraphSnapshot, startIds: string[], options: GraphTraversalOptions = {}): GraphTraversalResult {
  const maxDepth = Math.max(0, options.maxDepth ?? snapshot.limits.maxDepth);
  const maxNodes = Math.max(1, options.maxNodes ?? snapshot.limits.maxNodes);
  const maxEdges = Math.max(1, options.maxEdges ?? snapshot.limits.maxEdges);
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edgeMap = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  const adjacency = new Map<string, VerificationGraphEdge[]>();
  for (const edge of snapshot.edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  const resultNodes = new Map<string, VerificationGraphNode>();
  const resultEdges = new Map<string, VerificationGraphEdge>();
  const queue = startIds.map((id) => ({ id, depth: 0 }));
  const unknowns: string[] = [];
  let truncated = false;
  while (queue.length) {
    const item = queue.shift()!;
    if (resultNodes.has(item.id)) continue;
    const node = nodeMap.get(item.id);
    if (!node) { unknowns.push(`Graph traversal start or edge references missing node ${item.id}.`); continue; }
    if (resultNodes.size >= maxNodes) { truncated = true; break; }
    resultNodes.set(item.id, node);
    if (item.depth >= maxDepth) continue;
    for (const edge of adjacency.get(item.id) ?? []) {
      if (!edgeMap.has(edge.id)) continue;
      if (resultEdges.size >= maxEdges) { truncated = true; break; }
      resultEdges.set(edge.id, edge);
      if (!resultNodes.has(edge.to)) queue.push({ id: edge.to, depth: item.depth + 1 });
    }
  }
  if (truncated) unknowns.push(`Graph traversal was bounded at depth ${maxDepth}, ${maxNodes} nodes, and ${maxEdges} edges.`);
  return { nodes: [...resultNodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...resultEdges.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated, unknowns: [...new Set([...snapshot.unknowns, ...unknowns])].sort() };
}

export interface VerificationCoverageOptions {
  repository: string;
  headRevision: string;
  baseRevision?: string;
  report?: PrProofReport;
  impact?: ImpactReport;
  owners?: Record<string, string[]>;
  evidenceStates?: Partial<Record<CoverageDimension, AssuranceState>>;
  now?: string;
}

function coverageResult(state: AssuranceState, detail?: string, evidenceRefs: string[] = []): CoverageDimensionResult {
  return { state, evidenceRefs: [...new Set(evidenceRefs)].sort(), detail };
}

function coverageForPath(pathEvidence: ImpactReport["paths"][number], options: VerificationCoverageOptions): VerificationCoverageSurface {
  const report = options.report;
  const hasTest = pathEvidence.testFiles.length > 0;
  const testState: AssuranceState = hasTest ? "present" : pathEvidence.verificationState === "unknown" ? "unknown" : "missing";
  const executionState: AssuranceState = pathEvidence.verificationState === "verified" ? "present" : pathEvidence.verificationState === "not_applicable" ? "not_applicable" : pathEvidence.verificationState === "unknown" ? "unknown" : hasTest ? "partial" : "missing";
  const branchState: AssuranceState = report?.artifacts?.some((artifact) => Boolean(artifact.metrics.branches) || /branch/i.test(artifact.type)) ? "present" : "unknown";
  const mutationState: AssuranceState = report?.testIntegrity?.mutation?.attempted ? report.testIntegrity.mutation.results.some((item) => item.status === "unknown" || item.status === "timeout") ? "partial" : "present" : "unknown";
  const contractState: AssuranceState = report?.contracts ? "present" : pathEvidence.classification === "public_api" ? "unknown" : "not_applicable";
  const fixtureState: AssuranceState = report?.fixtures ? (report.fixtures.unknowns.length ? "partial" : "present") : "unknown";
  const ownerState: AssuranceState = options.owners?.[pathEvidence.file]?.length ? "present" : "unknown";
  const policyState: AssuranceState = report?.policy ? "present" : "unknown";
  const dimensions: Record<CoverageDimension, CoverageDimensionResult> = {
    test_evidence: coverageResult(testState, hasTest ? `Tests related to ${pathEvidence.file} were found.` : "No deterministic test relationship was found.", hasTest ? [stableId("test-evidence", pathEvidence.testFiles)] : []),
    test_execution: coverageResult(executionState, pathEvidence.reason),
    branch_evidence: coverageResult(branchState, "Branch evidence is present only when an artifact explicitly declares it."),
    mutation_evidence: coverageResult(mutationState, report?.testIntegrity?.mutation ? "Mutation adapter evidence was supplied." : "Mutation evidence was not supplied."),
    contract_evidence: coverageResult(contractState, report?.contracts ? "Contract analyzer output is available." : "No contract analyzer output is available for this surface."),
    fixture_evidence: coverageResult(fixtureState, report?.fixtures ? "Fixture analyzer output is available." : "Fixture evidence was not supplied."),
    ownership_evidence: coverageResult(ownerState, ownerState === "present" ? "Owner metadata was supplied." : "Owner metadata was not supplied."),
    policy_evidence: coverageResult(policyState, report?.policy ? `Policy ${report.policy.pack} was applied.` : "Policy evidence was not supplied."),
    rollback_evidence: coverageResult(options.evidenceStates?.rollback_evidence ?? "unknown", "Rollback evidence is an explicit input; it is never inferred from repository history."),
    runtime_evidence: coverageResult(options.evidenceStates?.runtime_evidence ?? "unknown", "Runtime evidence is an adapter input and is not owned by local verification."),
  };
  return { id: stableId("coverage-surface", { file: pathEvidence.file, symbol: pathEvidence.symbol ?? "", source: pathEvidence.sourceFile, sourceSymbol: pathEvidence.sourceSymbol ?? "" }), label: pathEvidence.symbol ? `${pathEvidence.file}#${pathEvidence.symbol}` : pathEvidence.file, file: pathEvidence.file, symbol: pathEvidence.symbol, dimensions };
}

export function buildVerificationCoverage(options: VerificationCoverageOptions): VerificationCoverage {
  const impact = options.impact ?? options.report?.impact;
  const surfaces = (impact?.paths ?? []).map((item) => coverageForPath(item, options)).sort((a, b) => a.id.localeCompare(b.id));
  const unknowns = [...new Set([...(options.report?.limitations ?? []), ...(impact?.unknowns ?? []), ...(surfaces.length ? [] : ["No impacted behavior surfaces were available for behavioral coverage."])])].sort();
  const identity = { repository: options.repository, baseRevision: options.baseRevision, headRevision: options.headRevision, surfaces: surfaces.map((surface) => surface.id) };
  return { ...metadata("verification-coverage", identity, options.now), kind: "verification-coverage", repository: options.repository, baseRevision: options.baseRevision, headRevision: options.headRevision, surfaces, unknowns };
}

const COVERAGE_STATE_SCORE: Record<AssuranceState, number> = { present: 5, not_applicable: 4, partial: 3, stale: 2, unknown: 1, missing: 0 };

export function compareVerificationCoverage(base: VerificationCoverage, head: VerificationCoverage): VerificationCoverage["comparison"] {
  const baseMap = new Map(base.surfaces.map((surface) => [surface.id, surface]));
  const changed: string[] = [];
  const unchanged: string[] = [];
  const regressed: string[] = [];
  const improved: string[] = [];
  for (const surface of head.surfaces) {
    const before = baseMap.get(surface.id);
    if (!before) { changed.push(surface.id); continue; }
    let delta = 0;
    for (const dimension of ALL_COVERAGE_DIMENSIONS) delta += COVERAGE_STATE_SCORE[surface.dimensions[dimension].state] - COVERAGE_STATE_SCORE[before.dimensions[dimension].state];
    if (delta < 0) regressed.push(surface.id);
    else if (delta > 0) improved.push(surface.id);
    else unchanged.push(surface.id);
  }
  return { changed: changed.sort(), unchanged: unchanged.sort(), regressed: regressed.sort(), improved: improved.sort() };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(normalizePath) : [];
}

function field(document: Record<string, unknown>, camel: string, snake: string): unknown {
  return document[camel] ?? document[snake];
}

function globMatch(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedValue = normalizePath(value);
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === "*" && normalizedPattern[index + 1] === "*") { expression += ".*"; index += 1; }
    else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(normalizedValue);
}

function anyMatch(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, value));
}

function makeContractMetadata(document: Record<string, unknown>, sourcePath?: string, now?: string): ChangeContract {
  const intent = String(field(document, "declaredIntent", "declared_intent") ?? "");
  const contractIdentity = { sourcePath, declaredIntent: intent, document };
  return {
    ...metadata("change-contract", contractIdentity, now, [{ source: sourcePath ?? "inline", authority: "human_confirmed", capturedAt: isoNow(now) }]),
    kind: "change-contract",
    declaredIntent: intent,
    expectedComponents: stringArray(field(document, "expectedComponents", "expected_components")),
    expectedSurfaces: stringArray(field(document, "expectedSurfaces", "expected_surfaces")),
    allowedPaths: stringArray(field(document, "allowedPaths", "allowed_paths")),
    forbiddenPaths: stringArray(field(document, "forbiddenPaths", "forbidden_paths")),
    requiredEvidenceTypes: stringArray(field(document, "requiredEvidenceTypes", "required_evidence_types")),
    requiredTests: stringArray(field(document, "requiredTests", "required_tests")),
    requiredReviewers: stringArray(field(document, "requiredReviewers", "required_reviewers")),
    requiredDocumentation: stringArray(field(document, "requiredDocumentation", "required_documentation")),
    requiredRollbackEvidence: stringArray(field(document, "requiredRollbackEvidence", "required_rollback_evidence")),
    riskSensitiveAreas: stringArray(field(document, "riskSensitiveAreas", "risk_sensitive_areas")),
    releaseDependencies: stringArray(field(document, "releaseDependencies", "release_dependencies")),
    waiverRequirements: stringArray(field(document, "waiverRequirements", "waiver_requirements")),
    sourcePath,
  };
}

export interface ChangeContractLoadResult {
  contract?: ChangeContract;
  sourcePath: string;
  missing: boolean;
  errors: string[];
}

export function loadChangeContract(root: string, sourcePath = CONTRACT_FILE, now?: string): ChangeContractLoadResult {
  const safePath = resolveRepositoryPath(root, sourcePath);
  if (!fs.existsSync(safePath)) return { sourcePath: normalizePath(sourcePath), missing: true, errors: [] };
  let document: unknown;
  try { document = parseYaml(fs.readFileSync(safePath, "utf8")); }
  catch (error) { return { sourcePath: normalizePath(sourcePath), missing: false, errors: [`Change contract could not be parsed: ${error instanceof Error ? error.message : String(error)}`] }; }
  if (!document || typeof document !== "object" || Array.isArray(document)) return { sourcePath: normalizePath(sourcePath), missing: false, errors: ["Change contract must be a YAML object."] };
  return { contract: makeContractMetadata(document as Record<string, unknown>, normalizePath(sourcePath), now), sourcePath: normalizePath(sourcePath), missing: false, errors: [] };
}

export function parseChangeContract(raw: string, sourcePath = "inline-change-contract.yml", now?: string): ChangeContract {
  const document = parseYaml(raw);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Change contract must be a YAML object.");
  return makeContractMetadata(document as Record<string, unknown>, sourcePath, now);
}

export interface ChangeContractEvaluationOptions {
  root?: string;
  diffs: FileDiff[];
  report?: PrProofReport;
  contract?: ChangeContract;
  providedReviewers?: string[];
  evidenceStates?: Partial<Record<string, AssuranceState>>;
  releaseDependencies?: string[];
  now?: string;
}

function contractFinding(violation: ContractViolation, now?: string): Finding {
  return {
    id: violation.id,
    ruleId: `scope.${violation.rule}`,
    category: "scope",
    severity: violation.blocking ? "high" : "warning",
    file: violation.paths[0] ?? "repository",
    line: 1,
    message: violation.detail,
    explanation: violation.detail,
    evidence: { detail: violation.paths.join(", ") },
    suggestedAction: "Update the change contract, add the required evidence, or record an explicit waiver before relying on this result.",
    confidence: "high",
    resolution: "open",
    blocking: violation.blocking,
    module: "assurance-contract",
    toolVersion: "assurance-v1",
    baseSha: "unknown",
    headSha: "unknown",
    fingerprint: `sha256:${sha256(deterministicSerialize(violation))}`,
    title: violation.detail,
    classification: "deterministic_scope_drift",
    ...(now ? { evidenceRefs: [stableId("contract-assessment", { violation, now })] } : {}),
  };
}

function evidenceStateFor(type: string, options: ChangeContractEvaluationOptions): AssuranceState {
  const explicit = options.evidenceStates?.[type];
  if (explicit) return explicit;
  const report = options.report;
  const normalized = type.toLowerCase().replace(/[-_]/g, "");
  if (["test", "testevidence", "tests"].includes(normalized)) return report?.testIntegrity ? "present" : "missing";
  if (normalized === "coverage") return report?.testIntegrity?.coverage.available ? "present" : "missing";
  if (normalized === "mutation") return report?.testIntegrity?.mutation?.attempted ? "present" : "missing";
  if (normalized === "contract" || normalized === "apievidence" || normalized === "schema") return report?.contracts ? "present" : "missing";
  if (normalized === "fixture" || normalized === "snapshot") return report?.fixtures ? "present" : "missing";
  if (normalized === "receipt") return report?.assurance?.receipts?.length ? "present" : "missing";
  return "unknown";
}

export function evaluateChangeContract(options: ChangeContractEvaluationOptions): ChangeContractAssessment {
  if (!options.contract) return { status: "missing_configuration", violations: [], observations: [], missingConfiguration: ["No .tinkerbot/change-contract.yml contract is configured for this change."], unknowns: [], blockingFindings: [] };
  const contract = options.contract;
  const violations: ContractViolation[] = [];
  const observations: string[] = [];
  const unknowns: string[] = [];
  const diffPaths = options.diffs.map((diff) => normalizePath(diff.path));
  const changedSymbols = options.report?.impact?.changedSymbols ?? [];
  const addViolation = (rule: string, detail: string, paths: string[], blocking = true) => violations.push({ id: stableId("contract-violation", { rule, detail, paths }), rule, detail, paths: [...new Set(paths)].sort(), blocking });
  for (const diffPath of diffPaths) {
    if (contract.allowedPaths.length && !anyMatch(contract.allowedPaths, diffPath)) addViolation("file-outside-allowed", `Changed file ${diffPath} is outside the declared allowed paths.`, [diffPath]);
    if (anyMatch(contract.forbiddenPaths, diffPath)) addViolation("forbidden-path", `Changed file ${diffPath} matches a forbidden path.`, [diffPath]);
    if (contract.expectedComponents.length && !anyMatch(contract.expectedComponents, diffPath)) addViolation("component-outside-contract", `Changed file ${diffPath} is outside the declared component scope.`, [diffPath]);
    if (contract.expectedSurfaces.length && !anyMatch(contract.expectedSurfaces, diffPath)) addViolation("surface-outside-contract", `Changed file ${diffPath} is outside the declared surface scope.`, [diffPath]);
  }
  for (const symbol of changedSymbols) {
    const key = `${normalizePath(symbol.file)}#${symbol.name}`;
    if (contract.expectedSurfaces.length && !anyMatch(contract.expectedSurfaces, key) && !anyMatch(contract.expectedSurfaces, symbol.file)) addViolation("symbol-outside-contract", `Changed symbol ${key} is outside the declared surface scope.`, [symbol.file]);
  }
  const impactedTests = new Set(options.report?.impact?.paths.flatMap((item) => item.testFiles) ?? []);
  for (const requiredTest of contract.requiredTests) {
    const found = diffPaths.some((file) => anyMatch([requiredTest], file)) || [...impactedTests].some((file) => anyMatch([requiredTest], file));
    if (!found) addViolation("required-test-missing", `Required test evidence ${requiredTest} was not found in the changed or impacted test paths.`, [requiredTest]);
  }
  for (const evidenceType of contract.requiredEvidenceTypes) {
    const state = evidenceStateFor(evidenceType, options);
    if (state === "missing") addViolation("required-evidence-missing", `Required evidence type ${evidenceType} is missing.`, [evidenceType]);
    else if (state === "unknown" || state === "stale") unknowns.push(`Required evidence type ${evidenceType} is ${state}.`);
  }
  for (const documentation of contract.requiredDocumentation) {
    if (!diffPaths.some((file) => anyMatch([documentation], file))) addViolation("required-documentation-missing", `Required documentation ${documentation} is not represented in the change.`, [documentation]);
  }
  for (const rollback of contract.requiredRollbackEvidence) {
    const state = options.evidenceStates?.[rollback] ?? "unknown";
    if (state === "missing") addViolation("rollback-evidence-missing", `Required rollback or compensation evidence ${rollback} is missing.`, [rollback]);
    else if (state === "unknown") unknowns.push(`Rollback or compensation evidence ${rollback} could not be evaluated.`);
  }
  if (contract.requiredReviewers.length) {
    if (!options.providedReviewers) unknowns.push(`Required reviewers ${contract.requiredReviewers.join(", ")} need review metadata to be evaluated.`);
    else {
      const missingReviewers = contract.requiredReviewers.filter((reviewer) => !options.providedReviewers!.includes(reviewer));
      if (missingReviewers.length) addViolation("required-reviewer-missing", `Required reviewers are missing: ${missingReviewers.join(", ")}.`, missingReviewers);
    }
  }
  if (contract.releaseDependencies.length) {
    if (!options.releaseDependencies) unknowns.push(`Release dependencies are declared but no release context was supplied: ${contract.releaseDependencies.join(", ")}.`);
    else {
      const missing = contract.releaseDependencies.filter((dependency) => !options.releaseDependencies!.includes(dependency));
      if (missing.length) addViolation("release-dependency-missing", `Release dependencies are not represented: ${missing.join(", ")}.`, missing);
    }
  }
  if (contract.declaredIntent) observations.push(`Declared intent: ${contract.declaredIntent}`);
  const blockingFindings = violations.filter((violation) => violation.blocking).map((violation) => contractFinding(violation, options.now));
  const status: ChangeContractAssessment["status"] = violations.length ? "violations" : unknowns.length ? "unknown" : "compliant";
  return { status, contract, violations: violations.sort((a, b) => a.id.localeCompare(b.id)), observations, missingConfiguration: [], unknowns: [...new Set(unknowns)].sort(), blockingFindings };
}

export function assessChangeContractFromRepository(options: Omit<ChangeContractEvaluationOptions, "contract"> & { root: string; sourcePath?: string }): ChangeContractAssessment {
  const loaded = loadChangeContract(options.root, options.sourcePath ?? CONTRACT_FILE, options.now);
  if (loaded.errors.length) return { status: "unknown", violations: [], observations: [], missingConfiguration: loaded.errors, unknowns: loaded.errors, blockingFindings: [] };
  return evaluateChangeContract({ ...options, contract: loaded.contract });
}

export interface LifecycleEventOptions {
  recordId: string;
  findingFingerprint: string;
  from?: FindingLifecycleState;
  to: FindingLifecycleState;
  reason: string;
  runId?: string;
  occurredAt?: string;
  sequence?: number;
  now?: string;
}

export function createFindingLifecycleEvent(options: LifecycleEventOptions): FindingLifecycleEvent {
  const occurredAt = isoNow(options.occurredAt ?? options.now);
  const identity = { recordId: options.recordId, findingFingerprint: options.findingFingerprint, from: options.from, to: options.to, reason: options.reason, runId: options.runId, occurredAt, sequence: options.sequence };
  return { ...metadata("finding-lifecycle-event", identity, options.now), kind: "finding-lifecycle-event", recordId: options.recordId, findingFingerprint: options.findingFingerprint, from: options.from, to: options.to, reason: options.reason, runId: options.runId, occurredAt, sequence: options.sequence };
}

export function assessEvidenceFreshness(previous: FreshnessContext | undefined, current: FreshnessContext, now = current.now ?? new Date().toISOString()): EvidenceFreshness {
  const reasons: string[] = [];
  if (!previous) reasons.push("No prior freshness context was supplied.");
  else {
    const comparisons: Array<[keyof FreshnessContext, string, EvidenceFreshnessState]> = [
      ["headSha", "PR head changed", "invalidated"],
      ["baseSha", "base revision changed", "invalidated"],
      ["mergeGroupSha", "merge group changed", "invalidated"],
      ["sourceFingerprint", "relevant source changed", "invalidated"],
      ["fixtureFingerprint", "fixture or snapshot changed", "invalidated"],
      ["testCommand", "test command changed", "invalidated"],
      ["policyVersion", "policy changed", "invalidated"],
      ["baselineVersion", "baseline changed", "stale"],
      ["toolVersion", "tool or parser version changed", "invalidated"],
      ["artifactHashes", "evidence artifact changed", "stale"],
    ];
    for (const [key, reason, state] of comparisons) {
      const before = previous[key];
      const after = current[key];
      if (before !== undefined && after !== undefined && deterministicSerialize(before) !== deterministicSerialize(after)) reasons.push(reason);
    }
  }
  if (current.waiverExpiresAt && Number.isFinite(Date.parse(current.waiverExpiresAt)) && Date.parse(current.waiverExpiresAt) <= Date.parse(now)) reasons.push("waiver expired");
  const state: EvidenceFreshnessState = !previous ? "unknown" : reasons.some((reason) => /changed|version|command|waiver expired/.test(reason) && !/artifact|baseline|waiver expired/.test(reason)) ? "invalidated" : reasons.length ? "stale" : "fresh";
  return { state, reasons: [...new Set(reasons)], fingerprint: stableId("freshness", { context: objectWithoutUndefined(current as unknown as Record<string, unknown>) }) };
}

export interface FindingLifecycleOptions {
  recordId: string;
  findingFingerprint: string;
  currentPresent: boolean;
  previousPresent?: boolean;
  previousState?: FindingLifecycleState;
  previousFreshness?: FreshnessContext;
  currentFreshness: FreshnessContext;
  waiverActive?: boolean;
  runId?: string;
  now?: string;
}

export function evaluateFindingLifecycle(options: FindingLifecycleOptions): FindingLifecycleResult {
  const freshness = assessEvidenceFreshness(options.previousFreshness, options.currentFreshness, options.now);
  let state: FindingLifecycleState;
  let reason: string;
  if (options.waiverActive) { state = "waived"; reason = "An active explicit waiver covers this finding."; }
  else if (options.currentFreshness.waiverExpiresAt && Date.parse(options.currentFreshness.waiverExpiresAt) <= Date.parse(options.now ?? new Date().toISOString())) { state = "stale"; reason = "The finding waiver expired."; }
  else if (!options.currentPresent && options.previousPresent) { state = "resolved"; reason = "The previous finding fingerprint is absent from the current deterministic run."; }
  else if (options.currentPresent && options.previousState === "resolved") { state = "regressed"; reason = "A previously resolved finding fingerprint is present again."; }
  else if (options.currentPresent && freshness.state === "invalidated") { state = "invalidated"; reason = freshness.reasons.join("; "); }
  else if (options.currentPresent && freshness.state === "stale") { state = "stale"; reason = freshness.reasons.join("; "); }
  else if (options.currentPresent && options.previousPresent) { state = "unchanged"; reason = "The finding fingerprint remains present with fresh comparable evidence."; }
  else if (options.currentPresent) { state = "new"; reason = "The finding fingerprint is new to the lifecycle."; }
  else { state = "unknown"; reason = "Neither current nor prior deterministic presence was supplied."; }
  const event = createFindingLifecycleEvent({ recordId: options.recordId, findingFingerprint: options.findingFingerprint, from: options.previousState, to: state, reason, runId: options.runId, now: options.now });
  return { state, event, freshness };
}

function readJsonLines<T>(root: string, relativePath: string): T[] {
  try {
    const file = resolveRepositoryPath(root, relativePath);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
  } catch { return []; }
}

function appendJsonLine<T extends { id?: string }>(root: string, relativePath: string, value: T): void {
  const file = resolveRepositoryPath(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = readJsonLines<T>(root, relativePath);
  if (value.id && existing.some((item) => item.id === value.id)) return;
  fs.appendFileSync(file, `${deterministicSerialize(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function appendFindingLifecycleEvent(root: string, event: FindingLifecycleEvent): void {
  appendJsonLine(root, LIFECYCLE_FILE, event);
}

export function readFindingLifecycleEvents(root: string): FindingLifecycleEvent[] {
  return readJsonLines<FindingLifecycleEvent>(root, LIFECYCLE_FILE).filter((event) => event?.kind === "finding-lifecycle-event").sort((a, b) => `${a.occurredAt}:${a.sequence ?? 0}:${a.id}`.localeCompare(`${b.occurredAt}:${b.sequence ?? 0}:${b.id}`));
}

export function reduceFindingLifecycle(events: FindingLifecycleEvent[]): Map<string, FindingLifecycleEvent> {
  const current = new Map<string, FindingLifecycleEvent>();
  for (const event of [...events].sort((a, b) => `${a.occurredAt}:${a.sequence ?? 0}:${a.id}`.localeCompare(`${b.occurredAt}:${b.sequence ?? 0}:${b.id}`))) {
    const previous = current.get(event.findingFingerprint);
    if (!previous || `${event.occurredAt}:${event.sequence ?? 0}:${event.id}` >= `${previous.occurredAt}:${previous.sequence ?? 0}:${previous.id}`) current.set(event.findingFingerprint, event);
  }
  return current;
}

export interface AgentExecutionReceiptOptions {
  repository: string;
  baseSha: string;
  headSha: string;
  humanInitiator?: string;
  agentIdentity?: string;
  workflowId?: string;
  branch?: string;
  declaredTask?: string;
  changeContractId?: string;
  permissions?: Partial<AgentExecutionReceipt["permissions"]>;
  commands?: InvocationMetadata[];
  filesChanged?: string[];
  symbolsChanged?: string[];
  testsExecuted?: string[];
  evidenceReceiptIds?: string[];
  policyResult?: string;
  rollbackEvidence?: AssuranceState;
  releaseAssessmentState?: AssuranceState;
  humanApprovals?: AgentExecutionReceipt["humanApprovals"];
  sourceUpload?: AgentExecutionReceipt["sourceUpload"];
  now?: string;
}

export function createAgentExecutionReceipt(options: AgentExecutionReceiptOptions): AgentExecutionReceipt {
  const filesChanged = [...new Set((options.filesChanged ?? []).map(normalizePath))].sort();
  const symbolsChanged = [...new Set(options.symbolsChanged ?? [])].sort();
  const identity = { repository: options.repository, baseSha: options.baseSha, headSha: options.headSha, workflowId: options.workflowId, agentIdentity: options.agentIdentity, filesChanged, symbolsChanged };
  return {
    ...metadata("agent-execution-receipt", identity, options.now, [{ source: "agent-execution", authority: "imported", actorId: options.agentIdentity, capturedAt: isoNow(options.now) }]),
    kind: "agent-execution-receipt",
    repository: options.repository,
    humanInitiator: options.humanInitiator,
    agentIdentity: options.agentIdentity,
    workflowId: options.workflowId,
    branch: options.branch,
    baseSha: options.baseSha,
    headSha: options.headSha,
    declaredTask: options.declaredTask,
    changeContractId: options.changeContractId,
    permissions: { network: options.permissions?.network ?? "unknown", secrets: options.permissions?.secrets ?? "unknown", scopes: [...new Set(options.permissions?.scopes ?? [])].sort() },
    commands: (options.commands ?? []).map(redactedInvocation),
    filesChanged,
    symbolsChanged,
    testsExecuted: [...new Set(options.testsExecuted ?? [])].sort(),
    evidenceReceiptIds: [...new Set(options.evidenceReceiptIds ?? [])].sort(),
    policyResult: options.policyResult,
    rollbackEvidence: options.rollbackEvidence,
    releaseAssessmentState: options.releaseAssessmentState,
    humanApprovals: [...(options.humanApprovals ?? [])].sort((a, b) => `${a.actorId}:${a.approvedAt}`.localeCompare(`${b.actorId}:${b.approvedAt}`)),
    sourceUpload: options.sourceUpload ?? "not_uploaded",
  };
}

function agentFinding(rule: string, detail: string, severity: Severity = "high"): Finding {
  return { id: stableId("agent-policy-finding", { rule, detail }), ruleId: `agent.${rule}`, category: "system", severity, file: "repository", line: 1, message: detail, explanation: detail, evidence: { detail }, suggestedAction: "Resolve the explicit admission requirement or record an authorized policy decision.", confidence: "high", resolution: "open", blocking: true, module: "agent-admission", fingerprint: `sha256:${sha256(deterministicSerialize({ rule, detail }))}`, title: detail };
}

export function evaluateAgentAdmission(receipt: AgentExecutionReceipt | undefined, policy: AgentPolicy = DEFAULT_AGENT_POLICY, unresolvedFindings: Finding[] = []): AgentAdmissionResult {
  if (!receipt) return { state: "agent_provenance_missing", states: ["agent_provenance_missing", "agent_policy_unknown"], findings: [], unknowns: ["No explicit agent execution receipt was supplied. Tinkerbot does not infer agent use from code or commit style."], policy };
  const findings: Finding[] = [];
  const unknowns: string[] = [];
  const provenancePresent = Boolean(receipt.agentIdentity && receipt.humanInitiator && receipt.workflowId && receipt.repository && receipt.baseSha && receipt.headSha);
  const states: AgentPolicyState[] = [provenancePresent ? "agent_provenance_present" : "agent_provenance_missing"];
  if (!provenancePresent) unknowns.push("Agent identity, human initiator, workflow ID, repository, base SHA, and head SHA are all required for complete provenance.");
  const authChange = receipt.filesChanged.some((file) => /(^|\/)(auth|authentication|authorization|permissions?|security)(\/|\.|$)/i.test(file));
  if (authChange && policy.authRequiresSecurityReview && !receipt.humanApprovals.some((approval) => /security/i.test(approval.role))) findings.push(agentFinding("security-review-required", "Authentication or authorization paths require an explicit security reviewer approval."));
  const migrationChange = receipt.filesChanged.some((file) => /(^|\/)(migrations?|schema)(\/|\.|$)/i.test(file));
  if (migrationChange && policy.migrationsRequireRollbackEvidence) {
    if (receipt.rollbackEvidence === "missing") findings.push(agentFinding("rollback-evidence-missing", "Database migration changes are missing required rollback or compensation evidence."));
    else if (receipt.rollbackEvidence !== "present") unknowns.push("Migration rollback evidence is unknown.");
  }
  const deploymentChange = receipt.filesChanged.some((file) => /(^|\/)(deploy|deployment|infra|terraform|helm|k8s|kubernetes)(\/|\.|$)/i.test(file));
  if (deploymentChange && policy.deploymentsRequireReleaseAssessment) {
    if (receipt.releaseAssessmentState === "missing") findings.push(agentFinding("release-assessment-required", "Deployment changes require an explicit release safety assessment."));
    else if (receipt.releaseAssessmentState !== "present") unknowns.push("Release assessment state is unknown for deployment changes.");
  }
  if (receipt.filesChanged.length > policy.maxChangedFiles) findings.push(agentFinding("file-budget-exceeded", `Agent change includes ${receipt.filesChanged.length} files, above the policy budget of ${policy.maxChangedFiles}.`));
  if (receipt.symbolsChanged.length > policy.maxChangedSymbols) findings.push(agentFinding("symbol-budget-exceeded", `Agent change includes ${receipt.symbolsChanged.length} symbols, above the policy budget of ${policy.maxChangedSymbols}.`));
  if (policy.unresolvedHighSeverityBlocks && unresolvedFindings.some((finding) => ["high", "critical"].includes(finding.severity) && finding.resolution !== "informational" && finding.resolution !== "not_applicable")) findings.push(agentFinding("unresolved-high-severity", "Unresolved high-severity deterministic findings block agent admission."));
  if (policy.agentCannotApproveOwnChange && receipt.agentIdentity && receipt.humanApprovals.some((approval) => approval.actorId === receipt.agentIdentity)) findings.push(agentFinding("self-approval", "An agent cannot approve its own change."));
  if (!policy.sourceUploadAllowed && receipt.sourceUpload === "uploaded") findings.push(agentFinding("source-upload-disallowed", "The agent policy does not allow source upload by default."));
  if (receipt.permissions.secrets === "unknown" || receipt.permissions.network === "unknown") unknowns.push("Network or secret-access status is unknown.");
  if (findings.length) states.push("agent_policy_blocked");
  else if (unknowns.length) states.push("agent_policy_unknown");
  else states.push("agent_policy_satisfied");
  const state: AgentAdmissionResult["state"] = findings.length ? "agent_policy_blocked" : unknowns.length ? "agent_policy_unknown" : "agent_policy_satisfied";
  return { state, states: [...new Set(states)], findings, unknowns: [...new Set(unknowns)].sort(), policy };
}

export interface ChangeSetOptions {
  name: string;
  repositories: ChangeSet["repositories"];
  sharedApiReferences?: string[];
  dependencyRelationships?: ChangeSet["dependencyRelationships"];
  expectedMergeOrder?: string[];
  releaseGroup?: string;
  now?: string;
}

export function createChangeSet(options: ChangeSetOptions): ChangeSet {
  const repositories = options.repositories.map((repository) => ({ ...repository, repository: repository.repository, pullRequests: [...new Set(repository.pullRequests)].sort(), commits: [...new Set(repository.commits)].sort(), owners: [...new Set(repository.owners)].sort(), changedApis: [...new Set(repository.changedApis ?? [])].sort(), changedSchemas: [...new Set(repository.changedSchemas ?? [])].sort(), compatibleWith: [...new Set(repository.compatibleWith ?? [])].sort() })).sort((a, b) => a.repository.localeCompare(b.repository));
  const identity = { name: options.name, repositories, sharedApiReferences: options.sharedApiReferences ?? [], dependencyRelationships: options.dependencyRelationships ?? [], expectedMergeOrder: options.expectedMergeOrder ?? [] };
  return { ...metadata("change-set", identity, options.now), kind: "change-set", name: options.name, repositories, sharedApiReferences: [...new Set(options.sharedApiReferences ?? [])].sort(), dependencyRelationships: [...(options.dependencyRelationships ?? [])].sort((a, b) => `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`)), expectedMergeOrder: [...new Set(options.expectedMergeOrder ?? [])], releaseGroup: options.releaseGroup };
}

function changeSetFinding(rule: string, detail: string, file = "change-set"): Finding {
  return { id: stableId("change-set-finding", { rule, detail }), ruleId: `change-set.${rule}`, category: "dependency", severity: "high", file, line: 1, message: detail, explanation: detail, evidence: { detail }, suggestedAction: "Update the declared change set or supply compatible repository evidence.", confidence: "medium", resolution: "unknown", blocking: false, module: "change-set", fingerprint: `sha256:${sha256(deterministicSerialize({ rule, detail }))}`, title: detail };
}

export function assessChangeSet(changeSet: ChangeSet): ChangeSetAssessment {
  const findings: Finding[] = [];
  const unknowns: string[] = [];
  const missingRepositories: string[] = [];
  const unresolvedDependencies: string[] = [];
  const repositoryNames = new Set(changeSet.repositories.map((repository) => repository.repository));
  for (const relationship of changeSet.dependencyRelationships) {
    if (!repositoryNames.has(relationship.from) || !repositoryNames.has(relationship.to)) { missingRepositories.push(...[relationship.from, relationship.to].filter((repository) => !repositoryNames.has(repository))); continue; }
    if (relationship.state === "unknown" || relationship.state === "missing" || relationship.state === "stale") { unresolvedDependencies.push(`${relationship.from} -> ${relationship.to}`); findings.push(changeSetFinding("dependency-unknown", `Cross-repository dependency ${relationship.from} -> ${relationship.to} is ${relationship.state}.`)); }
  }
  for (const repository of changeSet.repositories) {
    if (repository.evidenceState === "missing" || repository.evidenceState === "stale" || repository.evidenceState === "unknown") unknowns.push(`Evidence for ${repository.repository} is ${repository.evidenceState}.`);
    if (repository.changedApis?.length && repository.compatibleWith?.length === 0) { unknowns.push(`No compatible consumer relationship is declared for changed APIs in ${repository.repository}.`); findings.push(changeSetFinding("provider-consumer-unknown", `Provider or API changes in ${repository.repository} have no compatible consumer evidence.`, repository.repository)); }
    if (repository.changedSchemas?.length && repository.migrationEvidence !== "present") { findings.push(changeSetFinding("migration-incomplete", `Schema changes in ${repository.repository} do not have complete migration evidence.`, repository.repository)); if (repository.migrationEvidence === "unknown") unknowns.push(`Migration evidence for ${repository.repository} is unknown.`); }
    if (repository.generatedClientEvidence !== "present" && repository.changedApis?.length) { findings.push(changeSetFinding("generated-client-evidence-missing", `Changed APIs in ${repository.repository} have no generated-client evidence.`, repository.repository)); }
  }
  if (missingRepositories.length) unknowns.push(`Missing repositories: ${[...new Set(missingRepositories)].sort().join(", ")}.`);
  if (changeSet.expectedMergeOrder.some((repository) => !repositoryNames.has(repository))) unknowns.push("Expected merge order references a repository outside the declared change set.");
  const status: ChangeSetAssessment["status"] = findings.length ? "violations" : unknowns.length ? "unknown" : "ready";
  return { status, findings, unknowns: [...new Set(unknowns)].sort(), missingRepositories: [...new Set(missingRepositories)].sort(), unresolvedDependencies: [...new Set(unresolvedDependencies)].sort() };
}

export interface ReleaseManifestOptions {
  releaseId: string;
  includedRepositories: ReleaseManifest["includedRepositories"];
  requiredReceiptIds?: string[];
  policyStatus?: AssuranceState;
  migrationSequence?: string[];
  featureFlags?: ReleaseManifest["featureFlags"];
  deploymentDependencies?: string[];
  rollbackReferences?: string[];
  requiredRunbooks?: string[];
  requiredApprovals?: string[];
  externalEvidenceRefs?: string[];
  now?: string;
}

export function createReleaseManifest(options: ReleaseManifestOptions): ReleaseManifest {
  const includedRepositories = options.includedRepositories.map((item) => ({ ...item, repository: item.repository, receiptIds: [...new Set(item.receiptIds)].sort() })).sort((a, b) => a.repository.localeCompare(b.repository));
  const identity = { releaseId: options.releaseId, includedRepositories, requiredReceiptIds: options.requiredReceiptIds ?? [], migrationSequence: options.migrationSequence ?? [] };
  return { ...metadata("release-manifest", identity, options.now), kind: "release-manifest", releaseId: options.releaseId, includedRepositories, requiredReceiptIds: [...new Set(options.requiredReceiptIds ?? [])].sort(), policyStatus: options.policyStatus ?? "unknown", migrationSequence: [...new Set(options.migrationSequence ?? [])], featureFlags: [...(options.featureFlags ?? [])].sort((a, b) => a.reference.localeCompare(b.reference)), deploymentDependencies: [...new Set(options.deploymentDependencies ?? [])].sort(), rollbackReferences: [...new Set(options.rollbackReferences ?? [])].sort(), requiredRunbooks: [...new Set(options.requiredRunbooks ?? [])].sort(), requiredApprovals: [...new Set(options.requiredApprovals ?? [])].sort(), externalEvidenceRefs: [...new Set(options.externalEvidenceRefs ?? [])].sort() };
}

function releaseFinding(rule: string, detail: string, severity: Severity = "high"): Finding {
  return { id: stableId("release-finding", { rule, detail }), ruleId: `release.${rule}`, category: "release", severity, file: "release-manifest", line: 1, message: detail, explanation: detail, evidence: { detail }, suggestedAction: "Supply the required release evidence or keep the release assessment explicitly unknown.", confidence: "medium", resolution: "unknown", blocking: false, module: "release-safety", fingerprint: `sha256:${sha256(deterministicSerialize({ rule, detail }))}`, title: detail };
}

export interface ReleaseSafetyOptions {
  manifest: ReleaseManifest;
  receipts?: VerificationReceipt[];
  contractAssessments?: ChangeContractAssessment[];
  changeSetAssessments?: ChangeSetAssessment[];
  now?: string;
}

export function assessReleaseSafety(options: ReleaseSafetyOptions): ReleaseSafetyAssessment {
  const manifest = options.manifest;
  const receipts = new Map((options.receipts ?? []).map((receipt) => [receipt.id, receipt]));
  const blocking: string[] = [];
  const advisory: string[] = [];
  const unknowns: string[] = [];
  const findings: Finding[] = [];
  for (const required of manifest.requiredReceiptIds) {
    const receipt = receipts.get(required);
    if (!receipt) { blocking.push(`Missing required receipt ${required}.`); findings.push(releaseFinding("receipt-missing", `Required verification receipt ${required} is missing.`)); continue; }
    const verification = verifyVerificationReceipt(receipt, { now: options.now });
    if (["expired", "stale", "invalid", "unsupported"].includes(verification.status)) { blocking.push(`Receipt ${required} is ${verification.status}.`); findings.push(releaseFinding("receipt-stale", `Required verification receipt ${required} is ${verification.status}.`)); }
    else if (verification.status === "partial") unknowns.push(`Receipt ${required} is partial.`);
  }
  if (manifest.policyStatus === "missing" || manifest.policyStatus === "stale") { blocking.push(`Policy status is ${manifest.policyStatus}.`); findings.push(releaseFinding("policy-incomplete", `Release policy status is ${manifest.policyStatus}.`)); }
  else if (manifest.policyStatus === "unknown") unknowns.push("Release policy status is unknown.");
  if (manifest.migrationSequence.length && !manifest.rollbackReferences.length) { blocking.push("Migration sequence has no rollback or compensation reference."); findings.push(releaseFinding("rollback-missing", "Migration sequence has no rollback or compensation reference.")); }
  for (const flag of manifest.featureFlags) {
    if (!flag.owner || !flag.cleanupAt) { advisory.push(`Feature flag ${flag.reference} lacks owner or cleanup metadata.`); findings.push(releaseFinding("feature-flag-metadata-missing", `Feature flag ${flag.reference} lacks owner or cleanup metadata.`, "warning")); }
    if (flag.state === "unknown" || flag.state === "stale") unknowns.push(`Feature flag ${flag.reference} is ${flag.state}.`);
  }
  if (manifest.requiredApprovals.length) unknowns.push("Required approvals are declared but approval records were not supplied.");
  if (!manifest.externalEvidenceRefs.length) unknowns.push("External deployment and runtime evidence references were not supplied.");
  for (const assessment of options.contractAssessments ?? []) {
    if (assessment.status === "violations") { blocking.push("A change contract has deterministic violations."); findings.push(...assessment.blockingFindings); }
    else if (assessment.status === "unknown" || assessment.status === "missing_configuration") unknowns.push("A change contract assessment is incomplete.");
  }
  for (const assessment of options.changeSetAssessments ?? []) {
    if (assessment.status === "violations") { blocking.push("A cross-repository change set has unresolved violations."); findings.push(...assessment.findings); }
    else if (assessment.status === "unknown" || assessment.status === "partial") unknowns.push("A cross-repository change set assessment is incomplete.");
  }
  const status: ReleaseSafetyAssessment["status"] = blocking.length ? "blocked" : unknowns.length ? "unknown" : advisory.length ? "partial" : "ready";
  return { status, blocking: [...new Set(blocking)], advisory: [...new Set(advisory)], unknowns: [...new Set(unknowns)].sort(), findings };
}

export interface RuntimeOutcomeOptions {
  outcomeType: RuntimeOutcome["outcomeType"];
  observedAt: string;
  repository?: string;
  changeRecordRefs?: string[];
  externalSignal?: RuntimeOutcome["externalSignal"];
  association?: RuntimeOutcome["association"];
  facts?: RuntimeOutcome["facts"];
  retention?: RuntimeOutcome["retention"];
  provenance?: AssuranceProvenance[];
  now?: string;
}

export function createRuntimeOutcome(options: RuntimeOutcomeOptions): RuntimeOutcome {
  const association = options.association ?? { type: "unknown" as const, confidence: "low" as const, rationale: "No causal association was supplied." };
  const identity = { outcomeType: options.outcomeType, observedAt: options.observedAt, repository: options.repository, externalSignal: options.externalSignal, facts: options.facts ?? {} };
  return { ...metadata("runtime-outcome", identity, options.now, options.provenance ?? [{ source: "outcome-record", authority: association.type === "human_confirmed" ? "human_confirmed" : association.type === "imported" ? "imported" : association.type === "inferred" ? "inferred" : "deterministic", capturedAt: isoNow(options.now) }]), kind: "runtime-outcome", outcomeType: options.outcomeType, observedAt: isoNow(options.observedAt), repository: options.repository, changeRecordRefs: [...new Set(options.changeRecordRefs ?? [])].sort(), externalSignal: options.externalSignal ? { ...options.externalSignal, payloadHash: options.externalSignal.payloadHash ?? (options.externalSignal.signalId ? `sha256:${sha256(options.externalSignal.signalId)}` : undefined) } : undefined, association, facts: { ...(options.facts ?? {}) }, retention: options.retention };
}

export function appendRuntimeOutcome(root: string, outcome: RuntimeOutcome): void {
  appendJsonLine(root, OUTCOME_FILE, outcome);
}

export function readRuntimeOutcomes(root: string): RuntimeOutcome[] {
  return readJsonLines<RuntimeOutcome>(root, OUTCOME_FILE).filter((outcome) => outcome?.kind === "runtime-outcome").sort((a, b) => `${a.observedAt}:${a.id}`.localeCompare(`${b.observedAt}:${b.id}`));
}

export function exportRuntimeOutcomes(root: string, options: { includeDeleted?: boolean; now?: string } = {}): RuntimeOutcome[] {
  const now = Date.parse(options.now ?? new Date().toISOString());
  return readRuntimeOutcomes(root).filter((outcome) => {
    if (options.includeDeleted) return true;
    if (outcome.deletedAt) return false;
    return !outcome.retention?.expiresAt || Date.parse(outcome.retention.expiresAt) > now;
  });
}

export function createDecisionRecord(options: { decision: string; subjectId: string; reason: string; actorId?: string; authority?: AuthorityTier; now?: string }): DecisionRecord {
  const identity = { decision: options.decision, subjectId: options.subjectId, reason: options.reason, actorId: options.actorId };
  return { ...metadata("decision-record", identity, options.now, [{ source: "decision", authority: options.authority ?? "human_confirmed", actorId: options.actorId, capturedAt: isoNow(options.now) }]), kind: "decision-record", decision: options.decision, subjectId: options.subjectId, actorId: options.actorId, reason: options.reason, authority: options.authority ?? "human_confirmed" };
}

export function createArchitectureBinding(options: { source: string; target: string; relationship: string; state?: AssuranceState; evidenceRefs?: string[]; now?: string }): ArchitectureBinding {
  const identity = { source: options.source, target: options.target, relationship: options.relationship };
  return { ...metadata("architecture-binding", identity, options.now), kind: "architecture-binding", source: options.source, target: options.target, relationship: options.relationship, state: options.state ?? "unknown", evidenceRefs: [...new Set(options.evidenceRefs ?? [])].sort() };
}

export function createReviewCalibrationEvent(options: { reviewer: string; provider?: string; findingRef?: string; label: ReviewCalibrationEvent["label"]; evidenceRefs?: string[]; uncertainMapping?: boolean; now?: string }): ReviewCalibrationEvent {
  const identity = { reviewer: options.reviewer, provider: options.provider, findingRef: options.findingRef, label: options.label };
  return { ...metadata("review-calibration-event", identity, options.now, [{ source: options.provider ?? "reviewer", authority: "human_confirmed", actorId: options.reviewer, capturedAt: isoNow(options.now) }]), kind: "review-calibration-event", reviewer: options.reviewer, provider: options.provider, findingRef: options.findingRef, label: options.label, evidenceRefs: [...new Set(options.evidenceRefs ?? [])].sort(), uncertainMapping: options.uncertainMapping ?? false };
}

export interface ReviewerCalibrationMetrics {
  total: number;
  accepted: number;
  rejected: number;
  duplicate: number;
  outdated: number;
  fixed: number;
  escalated: number;
  notReviewed: number;
  falsePositive: number;
  acceptanceRate: number | null;
  unsupportedFindingRate: number | null;
  duplicateFindingRate: number | null;
  limitations: string[];
}

export function calculateReviewerCalibration(events: ReviewCalibrationEvent[]): ReviewerCalibrationMetrics {
  const count = (label: ReviewCalibrationEvent["label"]) => events.filter((event) => event.label === label).length;
  const total = events.length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  return { total, accepted, rejected, duplicate: count("duplicate"), outdated: count("outdated"), fixed: count("fixed"), escalated: count("escalated"), notReviewed: count("not_reviewed"), falsePositive: count("false_positive"), acceptanceRate: total ? accepted / total : null, unsupportedFindingRate: total ? events.filter((event) => event.uncertainMapping || !event.evidenceRefs.length).length / total : null, duplicateFindingRate: total ? count("duplicate") / total : null, limitations: total ? ["Calibration is opt-in and only reflects recorded events; it is not a benchmark of a provider or model."] : ["No calibration events were supplied."] };
}

export interface ExternalEvidenceAdapter<TInput = unknown, TOutput = EvidenceReference> {
  readonly name: string;
  readonly version: string;
  import(input: TInput): TOutput[];
}

export type AdvisoryEvidenceType = "feature_flag" | "deployment" | "rollback" | "canary" | "metric" | "trace" | "incident" | "external_scanner";

export interface AdvisoryEvidence {
  type: AdvisoryEvidenceType;
  state: AssuranceState;
  provider?: string;
  reference?: string;
  authority: "imported" | "human_confirmed" | "advisory" | "unknown";
  detail?: string;
}

export function advisoryEvidence(input: Omit<AdvisoryEvidence, "authority"> & { authority?: AdvisoryEvidence["authority"] }): AdvisoryEvidence {
  return { ...input, authority: input.authority ?? "imported" };
}

export function createChangeAssuranceRecord(options: AssuranceReportInput & { receiptRefs?: string[]; impactedSurfaceRefs?: string[]; findingRefs?: string[]; lifecycleEventRefs?: string[]; policyRefs?: string[]; baselineRefs?: string[]; waiverRefs?: string[]; requiredReviewers?: string[]; approvalRefs?: string[]; releaseRefs?: string[]; deploymentRefs?: string[]; runtimeOutcomeRefs?: string[]; freshness?: EvidenceFreshness; unknowns?: string[]; now?: string }): ChangeAssuranceRecord {
  const report = options.report;
  const impact = options.impact ?? report?.impact;
  const changedFiles = options.changedFiles ?? [];
  const changedSymbols = (impact?.changedSymbols ?? []).map((symbol) => changedSymbolFingerprint({ file: symbol.file, name: symbol.name, change: symbol.change }));
  const findingRefs = options.findingRefs ?? (report?.findings ?? []).map((finding) => finding.fingerprint ?? finding.id);
  const identity = { repositoryRef: options.repository, baseSha: options.base, headSha: options.head, pullRequestRefs: [], declaredIntent: options.declaredIntent, changedFiles, changedSymbols };
  const freshness = options.freshness ?? assessEvidenceFreshness(undefined, { baseSha: options.base, headSha: options.head, now: options.now }, options.now);
  return { ...metadata("change-assurance-record", identity, options.now), kind: "change-assurance-record", repositoryRef: options.repository, issueRefs: [], pullRequestRefs: [], commitRefs: [options.base, options.head].filter(Boolean), baseSha: options.base, headSha: options.head, declaredIntent: options.declaredIntent, changedFiles, changedSymbols, impactedSurfaceRefs: options.impactedSurfaceRefs ?? (impact?.paths ?? []).map((item) => item.id), requiredEvidence: ["verification-receipt", "verification-graph", "verification-coverage"], verificationReceiptRefs: options.receiptRefs ?? [], findingRefs, lifecycleEventRefs: options.lifecycleEventRefs ?? [], policyRefs: options.policyRefs ?? (report?.policy ? [report.policy.pack] : []), baselineRefs: options.baselineRefs ?? [], waiverRefs: options.waiverRefs ?? [], requiredReviewers: options.requiredReviewers ?? [], approvalRefs: options.approvalRefs ?? [], releaseRefs: options.releaseRefs ?? [], deploymentRefs: options.deploymentRefs ?? [], runtimeOutcomeRefs: options.runtimeOutcomeRefs ?? [], freshness, unknowns: [...new Set([...(report?.limitations ?? []), ...(impact?.unknowns ?? []), ...(options.unknowns ?? [])])].sort() };
}

export interface AssuranceBundleOptions extends AssuranceReportInput {
  root?: string;
  diffs?: FileDiff[];
  declaredIntent?: string;
  contract?: ChangeContract;
  contractAssessment?: ChangeContractAssessment;
  agentReceipts?: AgentExecutionReceipt[];
  changeSets?: ChangeSet[];
  releaseManifests?: ReleaseManifest[];
  releaseAssessments?: ReleaseSafetyAssessment[];
  outcomes?: RuntimeOutcome[];
  now?: string;
}

export function createAssuranceBundle(options: AssuranceBundleOptions): AssuranceBundle {
  const report = options.report;
  const receipt = createVerificationReceipt({ repository: options.repository, baseSha: options.base, headSha: options.head, report, impact: options.impact, diffs: options.diffs, root: options.root, now: options.now });
  const graph = buildVerificationGraph({ repository: options.repository, revision: options.head, baseRevision: options.base, report, impact: options.impact, now: options.now });
  const coverage = buildVerificationCoverage({ repository: options.repository, headRevision: options.head, baseRevision: options.base, report, impact: options.impact, now: options.now });
  const record = createChangeAssuranceRecord({ ...options, receiptRefs: [receipt.id], impactedSurfaceRefs: graph.nodes.filter((node) => ["file", "symbol", "api"].includes(node.type)).map((node) => node.id), findingRefs: (report?.findings ?? []).map((finding) => finding.fingerprint ?? finding.id), unknowns: [...graph.unknowns, ...coverage.unknowns], now: options.now });
  return { schemaVersion: ASSURANCE_SCHEMA_VERSION, schemaId: ASSURANCE_SCHEMA_ID, record, receipts: [receipt], graphs: [graph], coverage, contract: options.contract, contractAssessment: options.contractAssessment, lifecycleEvents: [], agentReceipts: options.agentReceipts ?? [], changeSets: options.changeSets ?? [], releaseManifests: options.releaseManifests ?? [], releaseAssessments: options.releaseAssessments ?? [], outcomes: options.outcomes ?? [], decisions: [], bindings: [], calibrationEvents: [], unknowns: [...new Set([...record.unknowns, ...graph.unknowns, ...coverage.unknowns])].sort() };
}

export function validateAssuranceBundle(value: unknown): asserts value is AssuranceBundle {
  if (!value || typeof value !== "object") throw new Error("Assurance bundle must be an object.");
  const bundle = value as Partial<AssuranceBundle>;
  if (bundle.schemaVersion !== ASSURANCE_SCHEMA_VERSION || bundle.schemaId !== ASSURANCE_SCHEMA_ID) throw new Error(`Unsupported assurance schema version: ${String(bundle.schemaVersion)}`);
  for (const key of ["receipts", "graphs", "lifecycleEvents", "agentReceipts", "changeSets", "releaseManifests", "releaseAssessments", "outcomes", "decisions", "bindings", "calibrationEvents", "unknowns"] as const) if (!Array.isArray(bundle[key])) throw new Error(`Assurance bundle field ${key} must be an array.`);
  for (const receipt of bundle.receipts ?? []) {
    if (receipt.schemaVersion !== ASSURANCE_SCHEMA_VERSION || receipt.kind !== "verification-receipt" || !receipt.integrity?.digest) throw new Error(`Invalid verification receipt ${receipt.id ?? "unknown"}.`);
  }
}

export function serializeAssuranceBundle(bundle: AssuranceBundle): string {
  validateAssuranceBundle(bundle);
  return `${deterministicSerialize(bundle)}\n`;
}

export function parseAssuranceBundle(raw: string): AssuranceBundle {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { throw new Error(`Invalid assurance JSON: ${error instanceof Error ? error.message : String(error)}`); }
  validateAssuranceBundle(value);
  return value;
}

export function serializeReceipt(receipt: VerificationReceipt): string {
  if (receipt.integrity.digest !== receiptDigest(receipt)) throw new Error("Cannot serialize a receipt with invalid integrity.");
  return `${deterministicSerialize(receipt)}\n`;
}

export function parseReceipt(raw: string): VerificationReceipt {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { throw new Error(`Invalid receipt JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object") throw new Error("Receipt must be an object.");
  const receipt = value as VerificationReceipt;
  if (receipt.schemaVersion !== ASSURANCE_SCHEMA_VERSION || receipt.schemaId !== ASSURANCE_SCHEMA_ID) throw new Error(`Unsupported receipt schema version: ${String(receipt.schemaVersion)}`);
  return receipt;
}
