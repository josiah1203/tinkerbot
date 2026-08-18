import type { Finding, ImpactReport, PrProofReport } from "./types";

export const ASSURANCE_SCHEMA_VERSION = 1 as const;
export const ASSURANCE_SCHEMA_ID = "https://tinkerbot.dev/schemas/assurance/v1" as const;

export type AssuranceState = "present" | "partial" | "missing" | "not_applicable" | "unknown" | "stale";
export type AuthorityTier = "deterministic" | "human_confirmed" | "imported" | "advisory" | "inferred";
export type PrivacyClassification = "public" | "metadata" | "sensitive" | "secret";
export type EvidenceFreshnessState = "fresh" | "stale" | "invalidated" | "unknown";

export interface AssuranceProvenance {
  source: string;
  authority: AuthorityTier;
  provider?: string;
  providerVersion?: string;
  actorId?: string;
  capturedAt?: string;
  sourceArtifact?: string;
  externalReference?: string;
}

export interface EvidenceReference {
  id: string;
  type: string;
  status: AssuranceState;
  sha256?: string;
  source?: string;
  authority: AuthorityTier;
  privacy: PrivacyClassification;
  freshness?: EvidenceFreshnessState;
  detail?: string;
}

export const EVIDENCE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_CONTRACT_SCHEMA_ID = "https://tinkerbot.dev/schemas/evidence/v1" as const;
export type EvidenceResultState = "PASS" | "FAIL" | "UNKNOWN" | "STALE" | "SKIPPED" | "NOT_APPLICABLE";

export interface EvidenceContractFinding {
  id: string;
  fingerprint: string;
  ruleId: string;
  severity: string;
  state: EvidenceResultState;
  file?: string;
  startLine?: number;
  endLine?: number;
  module?: string;
  evidenceRefs: string[];
  baselineRef?: string;
  waiverRef?: string;
}

export interface EvidenceContract {
  schemaVersion: typeof EVIDENCE_CONTRACT_SCHEMA_VERSION;
  schemaId: typeof EVIDENCE_CONTRACT_SCHEMA_ID;
  repositoryIdentity: { name: string; identityHash: string };
  commitIdentity: { baseSha: string; headSha: string; treeSha: string };
  changeIdentity: { changeId?: string; pullRequestNumber?: number; branch?: string };
  runId: string;
  receiptId: string;
  tool: { name: string; version: string };
  policy: { version: string; result: EvidenceResultState };
  configurationHash: string;
  environment: { runtime: string; platform: string; arch: string; ci: boolean; runner?: string; networkRequired: false; secretsRequired: false };
  verdict: EvidenceResultState;
  findings: EvidenceContractFinding[];
  unknownStates: string[];
  staleStates: string[];
  provenance: AssuranceProvenance[];
  evidenceHashes: string[];
  affectedFiles: string[];
  affectedSymbols: string[];
  baselineRefs: string[];
  waiverRefs: string[];
  generatedAt: string;
  observedAt: string;
  sourceUpload: "not_uploaded";
  diffUpload: "not_uploaded";
  optionalExplanation?: { text: string; authority: "advisory" };
  integrity: { algorithm: "sha256"; digest: string };
}

export interface AssuranceObjectMetadata {
  schemaVersion: number;
  schemaId: string;
  id: string;
  createdAt: string;
  updatedAt?: string;
  provenance: AssuranceProvenance[];
  privacy: PrivacyClassification;
  retentionUntil?: string;
  deletedAt?: string;
  exportable?: boolean;
}

export interface ChangedFileFingerprint {
  path: string;
  status: string;
  fingerprint: string;
  additions?: number;
  deletions?: number;
}

export interface ChangedSymbolFingerprint {
  file: string;
  symbol: string;
  fingerprint: string;
  change?: string;
}

export interface InvocationMetadata {
  command: string;
  arguments?: string[];
  environment?: Record<string, string>;
  exitCode?: number | null;
  durationMs?: number | null;
  timeoutMs?: number | null;
  redacted: boolean;
}

export interface ArtifactReference {
  id: string;
  type: string;
  source: string;
  sha256?: string;
  sizeBytes?: number;
  status: "present" | "missing" | "corrupt" | "unsupported" | "unknown";
  requiredForReplay: boolean;
  uploaded: boolean;
}

export interface ReplayMetadata {
  required: boolean;
  dependencies: string[];
  commands: string[];
  toolVersions: Record<string, string>;
  configurationFingerprint?: string;
  artifacts: string[];
  networkRequired: boolean;
  secretsRequired: boolean;
  sourceRequired: boolean;
  limitations: string[];
}

export interface ReceiptIntegrity {
  algorithm: "sha256";
  digest: string;
  signature?: {
    format: "provider-neutral";
    keyId?: string;
    value: string;
    status: "available" | "unavailable" | "invalid";
  };
}

export interface VerificationReceipt extends AssuranceObjectMetadata {
  kind: "verification-receipt";
  repository: string;
  baseSha: string;
  headSha: string;
  mergeGroupSha?: string;
  changedFiles: ChangedFileFingerprint[];
  changedSymbols: ChangedSymbolFingerprint[];
  tool: { name: string; version: string; adapters: Record<string, string> };
  commands: InvocationMetadata[];
  inputArtifacts: ArtifactReference[];
  outputArtifacts: ArtifactReference[];
  evidenceRefs: EvidenceReference[];
  policyVersion?: string;
  configurationFingerprint?: string;
  runtime: { durationMs?: number; memoryBytes?: number; timeoutMs?: number; limits?: Record<string, number> };
  states: { partial: boolean; missing: string[]; unsupported: string[]; unknown: string[] };
  sourceUpload: "not_uploaded" | "uploaded" | "unknown";
  diffUpload: "not_uploaded" | "uploaded" | "unknown";
  verdict: PrProofReport["verdict"];
  replay: ReplayMetadata;
  expiresAt?: string;
  integrity: ReceiptIntegrity;
}

export type GraphNodeType = "repository" | "package" | "component" | "file" | "symbol" | "test" | "fixture" | "api" | "database" | "configuration" | "owner" | "policy" | "finding" | "evidence" | "pull_request" | "release" | "runtime_outcome";
export type GraphEdgeType = "contains" | "imports" | "calls" | "exports" | "tests" | "covers" | "impacts" | "owns" | "requires_review" | "verified_by" | "governed_by" | "released_in" | "observed_in";

export interface VerificationGraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  fingerprint: string;
  state: AssuranceState;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface VerificationGraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  state: AssuranceState;
  evidenceRefs: string[];
  uncertain?: boolean;
}

export interface VerificationGraphSnapshot extends AssuranceObjectMetadata {
  kind: "verification-graph";
  repository: string;
  revision: string;
  baseRevision?: string;
  completeness: "complete" | "partial" | "unknown";
  nodes: VerificationGraphNode[];
  edges: VerificationGraphEdge[];
  limits: { maxDepth: number; maxNodes: number; maxEdges: number };
  unknowns: string[];
}

export type CoverageDimension = "test_evidence" | "test_execution" | "branch_evidence" | "mutation_evidence" | "contract_evidence" | "fixture_evidence" | "ownership_evidence" | "policy_evidence" | "rollback_evidence" | "runtime_evidence";

export interface CoverageDimensionResult {
  state: AssuranceState;
  evidenceRefs: string[];
  detail?: string;
}

export interface VerificationCoverageSurface {
  id: string;
  label: string;
  file?: string;
  symbol?: string;
  dimensions: Record<CoverageDimension, CoverageDimensionResult>;
}

export interface VerificationCoverage extends AssuranceObjectMetadata {
  kind: "verification-coverage";
  repository: string;
  baseRevision?: string;
  headRevision: string;
  surfaces: VerificationCoverageSurface[];
  unknowns: string[];
  comparison?: { changed: string[]; unchanged: string[]; regressed: string[]; improved: string[] };
}

export interface ChangeContract extends AssuranceObjectMetadata {
  kind: "change-contract";
  declaredIntent: string;
  expectedComponents: string[];
  expectedSurfaces: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredEvidenceTypes: string[];
  requiredTests: string[];
  requiredReviewers: string[];
  requiredDocumentation: string[];
  requiredRollbackEvidence: string[];
  riskSensitiveAreas: string[];
  releaseDependencies: string[];
  waiverRequirements: string[];
  sourcePath?: string;
}

export interface ContractViolation {
  id: string;
  rule: string;
  detail: string;
  paths: string[];
  blocking: boolean;
}

export interface ChangeContractAssessment {
  status: "compliant" | "violations" | "missing_configuration" | "unknown";
  contract?: ChangeContract;
  violations: ContractViolation[];
  observations: string[];
  missingConfiguration: string[];
  unknowns: string[];
  blockingFindings: Finding[];
}

export type FindingLifecycleState = "new" | "unchanged" | "resolved" | "regressed" | "waived" | "stale" | "invalidated" | "unknown";

export interface FindingLifecycleEvent extends AssuranceObjectMetadata {
  kind: "finding-lifecycle-event";
  recordId: string;
  findingFingerprint: string;
  from?: FindingLifecycleState;
  to: FindingLifecycleState;
  reason: string;
  runId?: string;
  occurredAt: string;
  sequence?: number;
}

export interface FreshnessContext {
  baseSha?: string;
  headSha?: string;
  mergeGroupSha?: string;
  sourceFingerprint?: string;
  fixtureFingerprint?: string;
  testCommand?: string;
  policyVersion?: string;
  baselineVersion?: string;
  toolVersion?: string;
  artifactHashes?: string[];
  waiverExpiresAt?: string;
  now?: string;
}

export interface EvidenceFreshness {
  state: EvidenceFreshnessState;
  reasons: string[];
  fingerprint: string;
}

export interface FindingLifecycleResult {
  state: FindingLifecycleState;
  event: FindingLifecycleEvent;
  freshness: EvidenceFreshness;
}

export interface AgentExecutionReceipt extends AssuranceObjectMetadata {
  kind: "agent-execution-receipt";
  humanInitiator?: string;
  agentIdentity?: string;
  workflowId?: string;
  repository: string;
  branch?: string;
  baseSha: string;
  headSha: string;
  declaredTask?: string;
  changeContractId?: string;
  permissions: { network: "allowed" | "denied" | "unknown"; secrets: "allowed" | "denied" | "unknown"; scopes: string[] };
  commands: InvocationMetadata[];
  filesChanged: string[];
  symbolsChanged: string[];
  testsExecuted: string[];
  evidenceReceiptIds: string[];
  policyResult?: string;
  rollbackEvidence?: AssuranceState;
  releaseAssessmentState?: AssuranceState;
  humanApprovals: Array<{ actorId: string; role: string; approvedAt: string }>;
  sourceUpload: "not_uploaded" | "uploaded" | "unknown";
}

export interface AgentPolicy {
  id: string;
  version: string;
  authRequiresSecurityReview: boolean;
  migrationsRequireRollbackEvidence: boolean;
  deploymentsRequireReleaseAssessment: boolean;
  maxChangedFiles: number;
  maxChangedSymbols: number;
  unresolvedHighSeverityBlocks: boolean;
  agentCannotApproveOwnChange: boolean;
  sourceUploadAllowed: boolean;
}

export type AgentPolicyState = "agent_provenance_present" | "agent_provenance_missing" | "agent_policy_satisfied" | "agent_policy_unknown" | "agent_policy_blocked";

export interface AgentAdmissionResult {
  state: AgentPolicyState;
  states: AgentPolicyState[];
  findings: Finding[];
  unknowns: string[];
  policy: AgentPolicy;
}

export interface ChangeSetRepository {
  repository: string;
  pullRequests: string[];
  commits: string[];
  owners: string[];
  changedApis?: string[];
  changedSchemas?: string[];
  generatedClientEvidence?: AssuranceState;
  migrationEvidence?: AssuranceState;
  evidenceState: AssuranceState;
  compatibleWith?: string[];
}

export interface ChangeSet extends AssuranceObjectMetadata {
  kind: "change-set";
  name: string;
  repositories: ChangeSetRepository[];
  sharedApiReferences: string[];
  dependencyRelationships: Array<{ from: string; to: string; kind: string; state: AssuranceState }>;
  expectedMergeOrder: string[];
  releaseGroup?: string;
}

export interface ChangeSetAssessment {
  status: "ready" | "violations" | "unknown" | "partial";
  findings: Finding[];
  unknowns: string[];
  missingRepositories: string[];
  unresolvedDependencies: string[];
}

export interface ReleaseManifest extends AssuranceObjectMetadata {
  kind: "release-manifest";
  releaseId: string;
  includedRepositories: Array<{ repository: string; commitSha: string; changeSetId?: string; receiptIds: string[] }>;
  requiredReceiptIds: string[];
  policyStatus: AssuranceState;
  migrationSequence: string[];
  featureFlags: Array<{ reference: string; owner?: string; cleanupAt?: string; state: AssuranceState }>;
  deploymentDependencies: string[];
  rollbackReferences: string[];
  requiredRunbooks: string[];
  requiredApprovals: string[];
  externalEvidenceRefs: string[];
}

export interface ReleaseSafetyAssessment {
  status: "ready" | "blocked" | "unknown" | "partial";
  blocking: string[];
  advisory: string[];
  unknowns: string[];
  findings: Finding[];
}

export type OutcomeKind = "post_merge_ci_failure" | "revert" | "hotfix" | "rollback" | "deployment_failure" | "incident_reference" | "regression" | "successful_release" | "human_confirmed_false_alarm";
export type OutcomeAssociationType = "observed" | "imported" | "human_confirmed" | "inferred" | "unknown";

export interface RuntimeOutcome extends AssuranceObjectMetadata {
  kind: "runtime-outcome";
  outcomeType: OutcomeKind;
  observedAt: string;
  repository?: string;
  changeRecordRefs: string[];
  externalSignal?: { provider: string; signalId: string; payloadHash?: string };
  association: { type: OutcomeAssociationType; confidence: "low" | "medium" | "high"; rationale: string };
  facts: Record<string, string | number | boolean | null>;
  retention?: { expiresAt?: string; deletionRequestedAt?: string };
}

export interface DecisionRecord extends AssuranceObjectMetadata {
  kind: "decision-record";
  decision: string;
  subjectId: string;
  actorId?: string;
  reason: string;
  authority: AuthorityTier;
}

export interface ArchitectureBinding extends AssuranceObjectMetadata {
  kind: "architecture-binding";
  source: string;
  target: string;
  relationship: string;
  state: AssuranceState;
  evidenceRefs: string[];
}

export interface ReviewCalibrationEvent extends AssuranceObjectMetadata {
  kind: "review-calibration-event";
  reviewer: string;
  provider?: string;
  findingRef?: string;
  label: "accepted" | "rejected" | "duplicate" | "outdated" | "fixed" | "escalated" | "not_reviewed" | "false_positive";
  evidenceRefs: string[];
  uncertainMapping: boolean;
}

export interface AssuranceBenchmarkCase {
  id: string;
  category: "removed_assertion" | "surviving_mutant" | "api_break" | "migration_error" | "cross_package_impact" | "auth_path" | "fixture_drift" | "unknown_runtime";
  expectedStates: string[];
  notes?: string;
}

export interface ChangeAssuranceRecord extends AssuranceObjectMetadata {
  kind: "change-assurance-record";
  organizationRef?: string;
  repositoryRef: string;
  issueRefs: string[];
  pullRequestRefs: string[];
  commitRefs: string[];
  baseSha?: string;
  headSha?: string;
  mergeGroupSha?: string;
  declaredIntent?: string;
  changedFiles: ChangedFileFingerprint[];
  changedSymbols: ChangedSymbolFingerprint[];
  impactedSurfaceRefs: string[];
  requiredEvidence: string[];
  verificationReceiptRefs: string[];
  findingRefs: string[];
  lifecycleEventRefs: string[];
  policyRefs: string[];
  baselineRefs: string[];
  waiverRefs: string[];
  requiredReviewers: string[];
  approvalRefs: string[];
  releaseRefs: string[];
  deploymentRefs: string[];
  runtimeOutcomeRefs: string[];
  freshness: EvidenceFreshness;
  unknowns: string[];
}

export interface AssuranceBundle {
  schemaVersion: typeof ASSURANCE_SCHEMA_VERSION;
  schemaId: typeof ASSURANCE_SCHEMA_ID;
  record?: ChangeAssuranceRecord;
  receipts: VerificationReceipt[];
  graphs: VerificationGraphSnapshot[];
  coverage?: VerificationCoverage;
  contract?: ChangeContract;
  contractAssessment?: ChangeContractAssessment;
  lifecycleEvents: FindingLifecycleEvent[];
  agentReceipts: AgentExecutionReceipt[];
  changeSets: ChangeSet[];
  releaseManifests: ReleaseManifest[];
  releaseAssessments: ReleaseSafetyAssessment[];
  outcomes: RuntimeOutcome[];
  decisions: DecisionRecord[];
  bindings: ArchitectureBinding[];
  calibrationEvents: ReviewCalibrationEvent[];
  unknowns: string[];
}

export interface AssuranceReportInput {
  repository: string;
  base: string;
  head: string;
  report?: PrProofReport;
  impact?: ImpactReport;
  changedFiles?: ChangedFileFingerprint[];
  declaredIntent?: string;
}
