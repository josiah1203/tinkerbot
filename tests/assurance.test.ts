import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASSURANCE_SCHEMA_ID,
  ASSURANCE_SCHEMA_VERSION,
  ASSURANCE_BENCHMARK_CASES,
  DEFAULT_AGENT_POLICY,
  assessChangeSet,
  assessEvidenceFreshness,
  assessReleaseSafety,
  buildVerificationCoverage,
  buildVerificationGraph,
  calculateReviewerCalibration,
  compareVerificationCoverage,
  createArchitectureBinding,
  createAgentExecutionReceipt,
  createAssuranceBundle,
  createDecisionRecord,
  createEvidenceContract,
  createReviewCalibrationEvent,
  createChangeSet,
  createChangeAssuranceRecord,
  createReleaseManifest,
  createRuntimeOutcome,
  createVerificationReceipt,
  advisoryEvidence,
  evaluateAgentAdmission,
  evaluateChangeContract,
  evaluateFindingLifecycle,
  evidenceContractDigest,
  loadChangeContract,
  parseAssuranceBundle,
  parseChangeContract,
  parseReceipt,
  receiptDigest,
  readFindingLifecycleEvents,
  appendFindingLifecycleEvent,
  appendRuntimeOutcome,
  exportRuntimeOutcomes,
  reduceFindingLifecycle,
  replayVerificationReceipt,
  serializeAssuranceBundle,
  serializeEvidenceContract,
  serializeReceipt,
  sha256,
  stableId,
  traverseVerificationGraph,
  validateAssuranceBundle,
  validateEvidenceContract,
  verifyVerificationReceipt,
  type ChangeSet,
  type FindingLifecycleEvent,
  type VerificationGraphSnapshot,
} from "../packages/assurance/src";
import type { FileDiff, Finding, ImpactReport, PrProofReport } from "../packages/core/src";
import { renderReport } from "../packages/reporters/src";

function diff(file: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return { path: file, status: "modified", additions: 1, deletions: 0, changedLines: [1], deletedLines: [], hunks: [], patch: "", ...overrides };
}

function impact(overrides: Partial<ImpactReport> = {}): ImpactReport {
  return {
    filesAnalyzed: 2,
    symbolsAnalyzed: 2,
    changedSymbols: [{ name: "handle", file: "src/auth.ts", line: 1, kind: "function", change: "modified", exported: true }],
    paths: [{ id: "path-1", sourceFile: "src/auth.ts", sourceSymbol: "handle", file: "src/auth.ts", symbol: "handle", classification: "public_api", reason: "changed exported symbol", testFiles: ["tests/auth.test.ts"], verified: true, modifiedByPr: true, verificationState: "verified", coverageLines: [1] }],
    downstreamConsumers: 0,
    impactedTests: 1,
    impactedPathsExecuted: 1,
    unverifiedPaths: [],
    findings: [],
    unknowns: [],
    ...overrides,
  };
}

function report(overrides: Partial<PrProofReport> = {}): PrProofReport {
  return {
    schemaVersion: 1,
    schemaId: "https://pr-proof.dev/schemas/report/v1",
    toolVersion: "0.1.0",
    repository: "acme/example",
    base: "base-sha",
    head: "head-sha",
    verdict: "PASS",
    summary: { assertionsWeakened: 0, newTests: 1, testsPassingOnBase: 1, changedLinesCoveredPercentage: 100, mutantsKilled: 0, mutantsTotal: 0, changedSymbols: 1, downstreamConsumers: 0, impactedTests: 1, impactedPathsExecuted: 1, impactedPathsTotal: 1, unverifiedPaths: 0 },
    findings: [],
    impact: impact(),
    testIntegrity: { findings: [], newTests: 1, modifiedTests: 0, deletedTests: 0, testsPassingOnBase: 1, nonVacuity: [], coverage: { available: true, changedExecutableLines: 1, changedLinesCovered: 1, changedLinesCoveredByModifiedTests: 1, changedLinesNotCovered: 0, percentage: 100, coverageDelta: 0, highRiskUncovered: [], uncoveredLines: [] }, unknowns: [] },
    limitations: [],
    ...overrides,
  };
}

test("canonical serialization and stable IDs do not depend on object key order", () => {
  expect(stableId("case", { b: 2, a: 1 })).toBe(stableId("case", { a: 1, b: 2 }));
  expect(sha256("tinkerbot")).toHaveLength(64);
  const first = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], now: "2026-01-01T00:00:00.000Z" });
  const second = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], now: "2026-01-01T00:00:00.000Z" });
  expect(first.id).toBe(second.id);
  expect(first.integrity.digest).toBe(second.integrity.digest);
});

test("receipt verification detects tampering, applicability, stale configuration, expiry, and partial state", () => {
  const receipt = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], now: "2026-01-01T00:00:00.000Z" });
  expect(verifyVerificationReceipt(receipt, { repository: "acme/example", baseSha: "base", headSha: "head", now: "2026-01-02T00:00:00.000Z" }).status).toBe("valid");
  const tampered = { ...receipt, verdict: "FAIL" as const };
  expect(verifyVerificationReceipt(tampered).valid).toBe(false);
  expect(verifyVerificationReceipt(receipt, { repository: "other/repo" }).applicable).toBe(false);
  expect(verifyVerificationReceipt(receipt, { expectedToolVersion: "9.0.0" }).status).toBe("stale");
  const expired = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], expiresAt: "2025-01-01T00:00:00.000Z", now: "2024-01-01T00:00:00.000Z" });
  expect(verifyVerificationReceipt(expired, { now: "2026-01-01T00:00:00.000Z" }).status).toBe("expired");
  const partial = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", report: report({ limitations: ["coverage unavailable"] }), diffs: [diff("src/a.ts")] });
  expect(verifyVerificationReceipt(partial).status).toBe("partial");
  expect(partial.verdict).toBe("PASS");
});

test("receipt artifact hashes detect missing and corrupt artifacts without uploading source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-receipt-"));
  fs.writeFileSync(path.join(root, "artifact.json"), "good");
  const receipt = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], root, inputArtifacts: [{ id: "artifact", type: "generic", source: "artifact.json", sha256: sha256("good"), status: "present", requiredForReplay: true, uploaded: false }] });
  expect(verifyVerificationReceipt(receipt, { root }).valid).toBe(true);
  fs.writeFileSync(path.join(root, "artifact.json"), "corrupt");
  expect(verifyVerificationReceipt(receipt, { root }).valid).toBe(false);
  expect(receipt.sourceUpload).toBe("not_uploaded");
  expect(receipt.diffUpload).toBe("not_uploaded");
});

test("replay preflight exposes dependencies, tool drift, timeout, cancellation, and network uncertainty", () => {
  const receipt = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], replay: { dependencies: ["node@20"], networkRequired: true }, runtime: { timeoutMs: 10 } });
  expect(replayVerificationReceipt(receipt, { availableDependencies: [] }).status).toBe("blocked");
  expect(replayVerificationReceipt(receipt, { availableDependencies: ["node@20"], availableToolVersions: { tinkerbot: "other" } }).status).toBe("blocked");
  expect(replayVerificationReceipt(receipt, { availableDependencies: ["node@20"], availableToolVersions: { tinkerbot: receipt.tool.version } }).status).toBe("unknown");
  expect(replayVerificationReceipt(receipt, { timeoutMs: 1 }).status).toBe("timeout");
  const offline = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")], replay: { dependencies: ["node@20"] } });
  expect(replayVerificationReceipt(offline, { availableDependencies: ["node@20"], availableToolVersions: { tinkerbot: offline.tool.version } }).status).toBe("ready");
  const controller = new AbortController(); controller.abort();
  expect(replayVerificationReceipt(receipt, { signal: controller.signal }).status).toBe("cancelled");
});

test("graph snapshots are stable, bounded, and traversal terminates on cycles", () => {
  const graph = buildVerificationGraph({ repository: "acme/example", revision: "head", baseRevision: "base", report: report(), impact: impact() });
  expect(graph.nodes.some((node) => node.type === "test")).toBe(true);
  expect(graph.edges.some((edge) => edge.type === "tests")).toBe(true);
  expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
  const bounded = buildVerificationGraph({ repository: "acme/example", revision: "head", report: report(), impact: impact(), maxNodes: 1, maxEdges: 1 });
  expect(bounded.completeness).toBe("partial");
  const cycle: VerificationGraphSnapshot = {
    schemaVersion: ASSURANCE_SCHEMA_VERSION, schemaId: ASSURANCE_SCHEMA_ID, id: "graph", kind: "verification-graph", createdAt: "2026-01-01T00:00:00.000Z", repository: "acme/example", revision: "head", completeness: "complete", provenance: [], privacy: "metadata", nodes: [{ id: "a", type: "file", label: "a", fingerprint: "a", state: "present" }, { id: "b", type: "file", label: "b", fingerprint: "b", state: "present" }], edges: [{ id: "ab", from: "a", to: "b", type: "imports", state: "present", evidenceRefs: [] }, { id: "ba", from: "b", to: "a", type: "imports", state: "present", evidenceRefs: [] }], limits: { maxDepth: 20, maxNodes: 20, maxEdges: 20 }, unknowns: [],
  };
  const traversal = traverseVerificationGraph(cycle, ["a"]);
  expect(traversal.nodes).toHaveLength(2);
  expect(traversal.edges).toHaveLength(2);
});

test("behavioral coverage keeps dimensions separate from line coverage and compares base/head", () => {
  const base = buildVerificationCoverage({ repository: "acme/example", headRevision: "base", impact: impact({ paths: [{ ...impact().paths[0]!, verificationState: "unknown", verified: false }] }) });
  const head = buildVerificationCoverage({ repository: "acme/example", baseRevision: "base", headRevision: "head", report: report(), impact: impact() });
  expect(head.surfaces[0]?.dimensions.test_evidence.state).toBe("present");
  expect(head.surfaces[0]?.dimensions.runtime_evidence.state).toBe("unknown");
  const comparison = compareVerificationCoverage(base, head);
  expect(comparison?.improved.length).toBeGreaterThan(0);
});

test("change contracts detect deterministic path drift, missing evidence, tests, docs, and reviewer metadata", () => {
  const contract = parseChangeContract(`declared_intent: Update auth\nallowed_paths: ["src/**"]\nforbidden_paths: ["src/secrets.ts"]\nrequired_tests: ["tests/**"]\nrequired_evidence_types: ["coverage"]\nrequired_documentation: ["docs/auth.md"]\nrequired_reviewers: ["security"]\n`);
  const assessment = evaluateChangeContract({ contract, diffs: [diff("src/secrets.ts"), diff("README.md")], report: report({ testIntegrity: undefined, impact: undefined }), providedReviewers: [] });
  expect(assessment.status).toBe("violations");
  expect(assessment.violations.some((item) => item.rule === "forbidden-path")).toBe(true);
  expect(assessment.violations.some((item) => item.rule === "required-test-missing")).toBe(true);
  expect(assessment.blockingFindings.length).toBeGreaterThan(0);
  const unknownReview = evaluateChangeContract({ contract, diffs: [], report: report(), providedReviewers: undefined });
  expect(unknownReview.unknowns.some((item) => /reviewers/i.test(item))).toBe(true);
});

test("freshness and lifecycle preserve new, unchanged, resolved, regressed, waived, stale, and invalidated states", () => {
  const context = { baseSha: "base", headSha: "head", toolVersion: "1", now: "2026-01-01T00:00:00.000Z" };
  const fresh = assessEvidenceFreshness(context, { ...context, now: "2026-01-02T00:00:00.000Z" });
  expect(fresh.state).toBe("fresh");
  expect(assessEvidenceFreshness(context, { ...context, headSha: "new-head" }).state).toBe("invalidated");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, currentFreshness: context }).state).toBe("new");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, previousPresent: true, previousState: "new", previousFreshness: context, currentFreshness: context }).state).toBe("unchanged");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: false, previousPresent: true, previousState: "new", previousFreshness: context, currentFreshness: context }).state).toBe("resolved");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, previousPresent: true, previousState: "resolved", previousFreshness: context, currentFreshness: context }).state).toBe("regressed");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, previousPresent: true, previousState: "new", previousFreshness: context, currentFreshness: context, waiverActive: true }).state).toBe("waived");
  expect(evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, previousPresent: true, previousState: "new", previousFreshness: context, currentFreshness: { ...context, headSha: "new-head" } }).state).toBe("invalidated");
});

test("lifecycle persistence is append-only, duplicate-safe, and order-aware", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-lifecycle-"));
  const first = evaluateFindingLifecycle({ recordId: "record", findingFingerprint: "f", currentPresent: true, currentFreshness: { headSha: "head" }, occurredAt: undefined } as never).event;
  const second: FindingLifecycleEvent = { ...first, id: "later", to: "resolved", from: "new", occurredAt: "9999-02-01T00:00:00.000Z" };
  appendFindingLifecycleEvent(root, first);
  appendFindingLifecycleEvent(root, first);
  appendFindingLifecycleEvent(root, second);
  const events = readFindingLifecycleEvents(root);
  expect(events).toHaveLength(2);
  expect(reduceFindingLifecycle([...events].reverse()).get("f")?.to).toBe("resolved");
});

test("agent admission requires explicit provenance and enforces security, budgets, rollback, and self-approval", () => {
  const receipt = createAgentExecutionReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", humanInitiator: "human", agentIdentity: "agent-1", workflowId: "workflow", filesChanged: ["src/auth.ts", "db/migrations/001.sql"], symbolsChanged: ["a"], humanApprovals: [{ actorId: "agent-1", role: "security", approvedAt: "2026-01-01T00:00:00.000Z" }], rollbackEvidence: "missing", permissions: { network: "denied", secrets: "denied" } });
  const admission = evaluateAgentAdmission(receipt);
  expect(admission.state).toBe("agent_policy_blocked");
  expect(admission.findings.some((finding) => finding.ruleId === "agent.rollback-evidence-missing")).toBe(true);
  expect(admission.findings.some((finding) => finding.ruleId === "agent.self-approval")).toBe(true);
  expect(evaluateAgentAdmission(undefined).state).toBe("agent_provenance_missing");
});

test("change sets and release manifests preserve missing relationships as unknown or blocking evidence", () => {
  const changeSet = createChangeSet({ name: "release", repositories: [{ repository: "provider", pullRequests: ["1"], commits: ["p"], owners: [], changedApis: ["GET /v1"], evidenceState: "present", compatibleWith: [] }, { repository: "consumer", pullRequests: [], commits: [], owners: [], evidenceState: "missing" }], dependencyRelationships: [{ from: "provider", to: "missing", kind: "api", state: "unknown" }] });
  const setAssessment = assessChangeSet(changeSet);
  expect(setAssessment.status).toBe("violations");
  expect(setAssessment.missingRepositories).toContain("missing");
  const manifest = createReleaseManifest({ releaseId: "rel-1", includedRepositories: [{ repository: "provider", commitSha: "p", receiptIds: ["missing-receipt"] }], requiredReceiptIds: ["missing-receipt"], policyStatus: "present", migrationSequence: ["001"], rollbackReferences: [] });
  const release = assessReleaseSafety({ manifest, receipts: [] });
  expect(release.status).toBe("blocked");
  expect(release.blocking.some((item) => /receipt/i.test(item))).toBe(true);
});

test("outcomes distinguish facts and associations, and retention is applied on export", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-outcomes-"));
  const outcome = createRuntimeOutcome({ outcomeType: "incident_reference", observedAt: "2026-01-01T00:00:00.000Z", repository: "acme/example", facts: { incident: "INC-1" } });
  expect(outcome.association.type).toBe("unknown");
  appendRuntimeOutcome(root, outcome);
  const expired = createRuntimeOutcome({ outcomeType: "successful_release", observedAt: "2026-01-01T00:00:00.000Z", retention: { expiresAt: "2026-01-02T00:00:00.000Z" } });
  appendRuntimeOutcome(root, expired);
  expect(exportRuntimeOutcomes(root, { now: "2026-01-03T00:00:00.000Z" })).toHaveLength(1);
});

test("assurance bundles and schema fixtures round-trip without source content", () => {
  const bundle = createAssuranceBundle({ repository: "acme/example", base: "base", head: "head", report: report(), diffs: [diff("src/auth.ts")] });
  const serialized = serializeAssuranceBundle(bundle);
  expect(serialized).not.toContain("expect(");
  const parsed = parseAssuranceBundle(serialized);
  validateAssuranceBundle(parsed);
  expect(parsed.schemaId).toBe(ASSURANCE_SCHEMA_ID);
  expect(parsed.record?.verificationReceiptRefs).toContain(parsed.receipts[0]?.id);
  expect(ASSURANCE_BENCHMARK_CASES).toHaveLength(8);
});

test("reviewer calibration remains opt-in and reports limitations", () => {
  const metrics = calculateReviewerCalibration([{ id: "1", schemaVersion: 1, schemaId: ASSURANCE_SCHEMA_ID, kind: "review-calibration-event", createdAt: "2026-01-01T00:00:00.000Z", provenance: [], privacy: "metadata", reviewer: "human", label: "accepted", evidenceRefs: ["e"], uncertainMapping: false }]);
  expect(metrics.acceptanceRate).toBe(1);
  expect(metrics.limitations[0]).toMatch(/opt-in/i);
});

test("the checked-in empty assurance conformance fixture is schema-valid", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve("fixtures/assurance/change-assurance-v1.json"), "utf8")) as unknown;
  expect(() => validateAssuranceBundle(fixture)).not.toThrow();
});

test("the checked-in evidence contract fixture is schema-valid across report output formats", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve("fixtures/assurance/evidence-contract-v1.json"), "utf8")) as Parameters<typeof validateEvidenceContract>[0];
  expect(() => validateEvidenceContract(fixture)).not.toThrow();
  expect(fixture.verdict).toBe("UNKNOWN");
  expect(fixture.sourceUpload).toBe("not_uploaded");
  expect(fixture.diffUpload).toBe("not_uploaded");

  const reportWithEvidence = { ...report(), evidence: fixture };
  for (const format of ["json", "markdown", "sarif", "review-context", "receipt", "change-assurance", "release-manifest", "terminal"] as const) {
    const rendered = renderReport(reportWithEvidence, format);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("secret-token");
  }
  expect(JSON.parse(renderReport(reportWithEvidence, "json")).evidence.receiptId).toBe("tb-rcpt-fixture-7");
  expect(JSON.parse(renderReport(reportWithEvidence, "change-assurance")).evidence.receiptId).toBe("tb-rcpt-fixture-7");
});

test("receipt construction and verification cover artifact, redaction, signature, and schema states", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-receipt-depth-"));
  fs.writeFileSync(path.join(root, "present.json"), "present");
  fs.mkdirSync(path.join(root, "directory.json"));
  const artifact = (source: string, status: "parsed" | "missing" = "parsed") => ({
    type: "generic" as const,
    source,
    status,
    completeness: status === "parsed" ? "complete" as const : "unknown" as const,
    unknowns: [],
    metrics: {},
    records: [],
  });
  const receipt = createVerificationReceipt({
    repository: "acme/example",
    baseSha: "base",
    headSha: "head",
    root,
    report: report({ artifacts: [artifact("present.json"), artifact("directory.json"), artifact("missing.json", "missing"), artifact("../external.json")] }),
    commands: [{ command: "run Bearer secret-token", arguments: ["secret-token"], environment: { TOKEN: "secret-token" }, exitCode: 0, durationMs: 1, timeoutMs: 2, redacted: false }],
    outputArtifacts: [{ id: "output", type: "json", source: ".", status: "present", requiredForReplay: false, uploaded: false }],
    configurationFingerprint: "config-a",
  });
  expect(receipt.commands[0]?.redacted).toBe(true);
  expect(receipt.commands[0]?.command).not.toContain("secret-token");
  expect(receipt.inputArtifacts.map((item) => item.status)).toEqual(expect.arrayContaining(["present", "missing"]));
  expect(receipt.inputArtifacts.some((item) => item.source === "<external-artifact>")).toBe(true);

  expect(verifyVerificationReceipt(null as never).status).toBe("invalid");
  expect(verifyVerificationReceipt(receipt, { expectedConfigurationFingerprint: "config-b" }).status).toBe("stale");
  const unsupported = structuredClone(receipt);
  unsupported.schemaVersion = 99;
  unsupported.integrity.digest = receiptDigest(unsupported);
  expect(verifyVerificationReceipt(unsupported).status).toBe("unsupported");
  for (const status of ["invalid", "unavailable", "available"] as const) {
    const signed = structuredClone(receipt);
    signed.integrity.signature = { format: "provider-neutral", value: "signature", status };
    expect(verifyVerificationReceipt(signed).checks.some((check) => check.name === "signature")).toBe(true);
  }
  const requiredMissing = structuredClone(receipt);
  requiredMissing.inputArtifacts = [{ id: "required", type: "json", source: "missing.json", status: "missing", requiredForReplay: true, uploaded: false }];
  requiredMissing.integrity.digest = receiptDigest(requiredMissing);
  expect(verifyVerificationReceipt(requiredMissing, { root }).failures).toContain("Artifact missing.json is unavailable.");
  expect(verifyVerificationReceipt(requiredMissing).unknowns).toContain("Required artifact hashes were not checked offline without a repository root.");
});

test("assurance edge contracts cover graph ownership, persistence loading, release evidence, and serializers", () => {
  const richerReport = report({
    contracts: { filesAnalyzed: 1, changes: [{ contractType: "openapi", location: "GET /v1", kind: "unknown", affectedConsumers: [], relatedTests: [], confidence: "low" }], findings: [], unknowns: [] },
  });
  const graph = buildVerificationGraph({ repository: "acme/example", revision: "head", report: richerReport, impact: impact(), owners: { "src/auth.ts": ["security"] } });
  expect(graph.nodes.map((node) => node.type)).toEqual(expect.arrayContaining(["api", "owner"]));
  const same = compareVerificationCoverage(
    buildVerificationCoverage({ repository: "acme/example", headRevision: "head", impact: impact() }),
    buildVerificationCoverage({ repository: "acme/example", headRevision: "head", impact: impact() }),
  );
  expect(same?.unchanged).toHaveLength(1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-contract-load-"));
  expect(loadChangeContract(root).missing).toBe(true);
  fs.mkdirSync(path.join(root, ".tinkerbot"));
  fs.writeFileSync(path.join(root, ".tinkerbot/change-contract.yml"), "declared_intent: Test\nallowed_paths: [src/**]\n");
  expect(loadChangeContract(root).contract?.declaredIntent).toBe("Test");
  fs.writeFileSync(path.join(root, ".tinkerbot/change-contract.yml"), "allowed_paths: [\n");
  expect(loadChangeContract(root).errors).not.toHaveLength(0);

  const partialReceipt = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", report: report({ limitations: ["partial"] }), diffs: [diff("src/a.ts")] });
  const manifest = createReleaseManifest({
    releaseId: "rel-edge",
    includedRepositories: [{ repository: "acme/example", commitSha: "head", receiptIds: [partialReceipt.id] }],
    requiredReceiptIds: [partialReceipt.id],
    policyStatus: "unknown",
    featureFlags: [{ reference: "new-ui", state: "stale" }],
    requiredApprovals: ["security"],
  });
  const release = assessReleaseSafety({ manifest, receipts: [partialReceipt], contractAssessments: [{ status: "missing_configuration" }], changeSetAssessments: [{ status: "partial" }] } as never);
  expect(release.status).toBe("unknown");
  expect(release.advisory.some((item) => item.includes("new-ui"))).toBe(true);

  expect(createDecisionRecord({ decision: "approve", subjectId: "change", reason: "verified" }).kind).toBe("decision-record");
  expect(createArchitectureBinding({ source: "a", target: "b", relationship: "imports", evidenceRefs: ["e", "e"] }).evidenceRefs).toEqual(["e"]);
  expect(createReviewCalibrationEvent({ reviewer: "human", label: "fixed" }).kind).toBe("review-calibration-event");
  expect(advisoryEvidence({ type: "metric", state: "present" }).authority).toBe("imported");
  expect(createChangeAssuranceRecord({ repository: "acme/example", base: "base", head: "head" }).kind).toBe("change-assurance-record");

  const receipt = createVerificationReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", diffs: [diff("src/a.ts")] });
  expect(parseReceipt(serializeReceipt(receipt)).id).toBe(receipt.id);
  expect(() => serializeReceipt({ ...receipt, headSha: "tampered" })).toThrow(/invalid integrity/);
  expect(() => parseReceipt("not json")).toThrow(/Invalid receipt JSON/);
  expect(() => parseReceipt("null")).toThrow(/must be an object/);
  expect(() => parseReceipt(JSON.stringify({ schemaVersion: 99, schemaId: "bad" }))).toThrow(/Unsupported receipt schema/);
  expect(() => parseAssuranceBundle("not json")).toThrow(/Invalid assurance JSON/);
  expect(() => validateAssuranceBundle(null)).toThrow(/must be an object/);
  expect(() => validateAssuranceBundle({ schemaVersion: 99, schemaId: "bad" })).toThrow(/Unsupported assurance schema/);
  expect(() => validateAssuranceBundle({ schemaVersion: ASSURANCE_SCHEMA_VERSION, schemaId: ASSURANCE_SCHEMA_ID, receipts: {} })).toThrow(/must be an array/);
});

test("assurance warning closure covers traversal bounds, evidence states, admission budgets, and ready releases", () => {
  const cycle: VerificationGraphSnapshot = {
    schemaVersion: ASSURANCE_SCHEMA_VERSION, schemaId: ASSURANCE_SCHEMA_ID, id: "bounded", kind: "verification-graph", createdAt: "2026-01-01T00:00:00.000Z", repository: "acme/example", revision: "head", completeness: "complete", provenance: [], privacy: "metadata",
    nodes: [{ id: "a", type: "file", label: "a", fingerprint: "a", state: "present" }, { id: "b", type: "file", label: "b", fingerprint: "b", state: "present" }],
    edges: [{ id: "ab", from: "a", to: "b", type: "imports", state: "present", evidenceRefs: [] }], limits: { maxDepth: 2, maxNodes: 2, maxEdges: 2 }, unknowns: ["upstream unknown"],
  };
  expect(traverseVerificationGraph(cycle, ["missing"], { maxDepth: 0 }).unknowns).toContain("Graph traversal start or edge references missing node missing.");
  expect(traverseVerificationGraph(cycle, ["a"], { maxNodes: 1, maxEdges: 1 }).truncated).toBe(true);

  const unknownPath = { ...impact().paths[0]!, testFiles: [], verified: false, verificationState: "unknown" as const, classification: "public_api" as const };
  const missingPath = { ...unknownPath, id: "missing-path", verificationState: "partially_verified" as const, classification: "direct" as const };
  const notApplicablePath = { ...unknownPath, id: "na-path", verificationState: "not_applicable" as const, classification: "generated" as const };
  const richReport = report({
    artifacts: [{ type: "istanbul", source: "coverage.json", status: "parsed", completeness: "complete", metrics: { branches: 4 }, records: [], unknowns: [] }],
    contracts: { filesAnalyzed: 1, changes: [], findings: [], unknowns: [] },
    fixtures: { filesAnalyzed: 1, snapshotFiles: [], findings: [], unknowns: ["partial fixture"] },
    policy: { pack: "default", rationale: "default", unknownHandling: "advisory" },
    testIntegrity: { ...report().testIntegrity!, mutation: { enabled: true, attempted: true, killed: 0, survived: 0, timedOut: 1, noCoverage: 0, notRun: 0, unknown: 0, cacheHit: false, scope: [], results: [{ id: "timeout", status: "timeout" }] } },
  });
  const coverage = buildVerificationCoverage({ repository: "acme/example", headRevision: "head", report: richReport, impact: impact({ paths: [unknownPath, missingPath, notApplicablePath] }), owners: { "src/auth.ts": ["security"] }, evidenceStates: { rollback_evidence: "present", runtime_evidence: "stale" } });
  expect(coverage.surfaces.flatMap((surface) => Object.values(surface.dimensions).map((dimension) => dimension.state))).toEqual(expect.arrayContaining(["present", "partial", "unknown", "missing", "not_applicable", "stale"]));
  const emptyCoverage = buildVerificationCoverage({ repository: "acme/example", headRevision: "head" });
  expect(emptyCoverage.unknowns[0]).toMatch(/No impacted behavior/);

  const safeReceipt = createAgentExecutionReceipt({ repository: "acme/example", baseSha: "base", headSha: "head", humanInitiator: "human", agentIdentity: "agent", workflowId: "workflow", filesChanged: ["src/value.ts"], symbolsChanged: ["value"], permissions: { network: "denied", secrets: "denied" }, sourceUpload: "not_uploaded" });
  expect(evaluateAgentAdmission(safeReceipt).state).toBe("agent_policy_satisfied");
  const riskyReceipt = createAgentExecutionReceipt({ ...safeReceipt, filesChanged: ["deploy/app.ts", "schema/change.sql"], symbolsChanged: ["a", "b"], releaseAssessmentState: "unknown", rollbackEvidence: "unknown", permissions: { network: "unknown", secrets: "unknown" }, sourceUpload: "uploaded" });
  const unresolved = { id: "critical", ruleId: "critical", category: "system", severity: "critical", file: "src/value.ts", line: 1, message: "critical", explanation: "critical", suggestedAction: "fix", confidence: "high", resolution: "open", blocking: true } as const;
  const strictAdmission = evaluateAgentAdmission(riskyReceipt, { ...DEFAULT_AGENT_POLICY, maxChangedFiles: 1, maxChangedSymbols: 1 }, [unresolved]);
  expect(strictAdmission.findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining(["agent.file-budget-exceeded", "agent.symbol-budget-exceeded", "agent.unresolved-high-severity", "agent.source-upload-disallowed"]));

  const completeSet = createChangeSet({ name: "ready", repositories: [{ repository: "provider", pullRequests: [], commits: ["a"], owners: ["team"], changedApis: ["GET /v1"], compatibleWith: ["consumer"], generatedClientEvidence: "present", evidenceState: "present" }, { repository: "consumer", pullRequests: [], commits: ["b"], owners: ["team"], evidenceState: "present" }], dependencyRelationships: [{ from: "provider", to: "consumer", kind: "api", state: "present" }], expectedMergeOrder: ["provider", "consumer"] });
  expect(assessChangeSet(completeSet).status).toBe("ready");
  const readyManifest = createReleaseManifest({ releaseId: "ready", includedRepositories: [], policyStatus: "present", externalEvidenceRefs: ["deployment"] });
  expect(assessReleaseSafety({ manifest: readyManifest }).status).toBe("ready");
  const partialManifest = createReleaseManifest({ releaseId: "partial", includedRepositories: [], policyStatus: "present", externalEvidenceRefs: ["deployment"], featureFlags: [{ reference: "flag", state: "present" }] });
  expect(assessReleaseSafety({ manifest: partialManifest }).status).toBe("partial");

  for (const type of ["human_confirmed", "imported", "inferred"] as const) {
    const outcome = createRuntimeOutcome({ outcomeType: "successful_release", observedAt: "2026-01-01T00:00:00.000Z", association: { type, confidence: "high", rationale: type }, externalSignal: { provider: "monitor", signalId: type } });
    expect(outcome.externalSignal?.payloadHash).toMatch(/^sha256:/);
  }
});

test("evidence contracts preserve deterministic identity, explicit states, privacy, and integrity", () => {
  const baseFinding: Finding = { id: "finding", ruleId: "rule", category: "impact", severity: "warning", file: "src/value.ts", line: 2, message: "finding", explanation: "finding", suggestedAction: "fix", confidence: "high", resolution: "open", blocking: false, evidenceRefs: ["evidence", "evidence"] };
  const findings = [
    { ...baseFinding, id: "expired", baselineState: "expired" as const },
    { ...baseFinding, id: "unknown", resolution: "unknown" as const },
    { ...baseFinding, id: "na", resolution: "not_applicable" as const },
    { ...baseFinding, id: "blocking", severity: "high" as const, blocking: true },
    { ...baseFinding, id: "waived", baselineState: "waived" as const, fingerprint: "sha256:waived" },
  ];
  const rich = report({
    verdict: "FAIL",
    findings,
    limitations: ["coverage unknown"],
    baseline: { schemaVersion: 1, baselineRevision: "base", currentRevision: "head", stale: true, newCount: 0, existingCount: 0, resolvedCount: 0, waivedCount: 1, expiredWaiverCount: 0, unknowns: [], findings: [], resolved: [] },
    contracts: { filesAnalyzed: 0, changes: [], findings: [], unknowns: ["contract unknown"] },
    fixtures: { filesAnalyzed: 0, snapshotFiles: [], findings: [], unknowns: ["fixture unknown"] },
    policy: { pack: "strict", rationale: "strict", unknownHandling: "fail" },
  });
  const previousRunner = process.env.RUNNER_OS;
  process.env.RUNNER_OS = "Linux";
  const contract = createEvidenceContract({ report: rich, treeSha: "tree", changeId: "change", pullRequestNumber: 42, branch: "feature", configuration: { b: 2, a: 1 }, changedFiles: ["./src/value.ts", "src/value.ts"], changedSymbols: ["src/value.ts#run"], environment: { runner: "custom-runner" }, optionalExplanation: "Bearer secret-token", generatedAt: "2026-01-01T00:00:00.000Z" });
  if (previousRunner === undefined) delete process.env.RUNNER_OS; else process.env.RUNNER_OS = previousRunner;
  expect(contract.verdict).toBe("STALE");
  expect(contract.policy.result).toBe("FAIL");
  expect(contract.findings.map((item) => item.state)).toEqual(expect.arrayContaining(["STALE", "UNKNOWN", "NOT_APPLICABLE", "FAIL"]));
  expect(contract.waiverRefs).toEqual(["sha256:waived"]);
  expect(contract.affectedFiles).toEqual(["src/value.ts"]);
  expect(contract.optionalExplanation?.text).not.toContain("secret-token");
  expect(contract.environment.runner).toBe("custom-runner");
  expect(contract.environment.networkRequired).toBe(false);
  expect(contract.environment.secretsRequired).toBe(false);
  expect(contract.integrity.digest).toBe(evidenceContractDigest(contract));
  expect(serializeEvidenceContract(contract)).toContain('"schemaId"');
  expect(() => validateEvidenceContract(contract)).not.toThrow();

  expect(() => validateEvidenceContract(null as never)).toThrow(/must be an object/);
  expect(() => validateEvidenceContract({ ...contract, schemaVersion: 99 } as never)).toThrow(/Unsupported/);
  const missing = structuredClone(contract) as unknown as Record<string, unknown>;
  delete missing.runId;
  expect(() => validateEvidenceContract(missing as never)).toThrow(/missing runId/);
  expect(() => validateEvidenceContract({ ...contract, sourceUpload: "uploaded" } as never)).toThrow(/cannot claim/);
  expect(() => validateEvidenceContract({ ...contract, integrity: { ...contract.integrity, digest: "bad" } })).toThrow(/digest/);
  const nonAdvisory = structuredClone(contract);
  (nonAdvisory as unknown as { optionalExplanation: { text: string; authority: string } }).optionalExplanation = { text: "claim", authority: "deterministic" };
  nonAdvisory.integrity.digest = evidenceContractDigest(nonAdvisory);
  expect(() => validateEvidenceContract(nonAdvisory)).toThrow(/advisory/);

  expect(createEvidenceContract({ report: report({ verdict: "PASS" }) }).verdict).toBe("PASS");
  expect(createEvidenceContract({ report: report({ verdict: "UNKNOWN" }) }).verdict).toBe("UNKNOWN");
});
