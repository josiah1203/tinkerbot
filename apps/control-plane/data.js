export const plans = [
  { id: "free", name: "Free", price: "$0", detail: "Public repositories and local CLI", limit: 0 },
  { id: "developer", name: "Developer", price: "$19", detail: "3 private repositories", limit: 3 },
  { id: "team", name: "Team", price: "$149", detail: "10–15 repositories", limit: 15 },
  { id: "business", name: "Business", price: "$499", detail: "Up to 50 repositories", limit: 50 },
  { id: "enterprise", name: "Enterprise", price: "Custom", detail: "Annual pricing and custom controls", limit: null },
];

export const workspace = {
  name: "Atlas Engineering",
  slug: "atlas-eng",
  plan: "Developer",
  billingStatus: "Active",
  privateRepositoryLimit: 3,
  activePrivateRepositories: 2,
  memberCount: 8,
  preview: true,
};

export const repositories = [
  {
    id: "pr-proof",
    name: "pr-proof",
    visibility: "Private",
    defaultBranch: "main",
    connection: "Connected",
    action: "Action healthy",
    verdict: "Needs review",
    verdictTone: "review",
    lastRun: "12 min ago",
    openFindings: 3,
    unknowns: 1,
    coverage: "84%",
    mutation: "7 / 9 killed",
    policy: "Strict review",
    baseline: "2 new · 1 resolved",
    changedFiles: 8,
    changedLines: 143,
    runs: 14,
  },
  {
    id: "billing-service",
    name: "billing-service",
    visibility: "Private",
    defaultBranch: "main",
    connection: "Connected",
    action: "Action healthy",
    verdict: "Verified",
    verdictTone: "verified",
    lastRun: "Yesterday",
    openFindings: 0,
    unknowns: 0,
    coverage: "92%",
    mutation: "—",
    policy: "Default advisory",
    baseline: "No changes",
    changedFiles: 4,
    changedLines: 48,
    runs: 28,
  },
  {
    id: "edge-runtime",
    name: "edge-runtime",
    visibility: "Public",
    defaultBranch: "trunk",
    connection: "Connected",
    action: "Evidence incomplete",
    verdict: "Unknown",
    verdictTone: "unknown",
    lastRun: "3 days ago",
    openFindings: 1,
    unknowns: 2,
    coverage: "Unavailable",
    mutation: "Not run",
    policy: "Default advisory",
    baseline: "Stale",
    changedFiles: 11,
    changedLines: 301,
    runs: 9,
  },
];

export const runs = [
  { id: "run-2026-08-17", repositoryId: "pr-proof", repository: "pr-proof", verdict: "Needs review", tone: "review", ref: "#184 · feat/report-viewer", commit: "8f31c2a", base: "0d92af1", time: "12 min ago", findings: 3, unknowns: 1, changedFiles: 8, changedLines: 143, coverage: "84%", tool: "0.1.0" },
  { id: "run-2026-08-16", repositoryId: "billing-service", repository: "billing-service", verdict: "Verified", tone: "verified", ref: "#921 · tax-rounding", commit: "50a9f2e", base: "749e21c", time: "Yesterday", findings: 0, unknowns: 0, changedFiles: 4, changedLines: 48, coverage: "92%", tool: "0.1.0" },
  { id: "run-2026-08-14", repositoryId: "edge-runtime", repository: "edge-runtime", verdict: "Unknown", tone: "unknown", ref: "trunk · 1b4e9a6", commit: "1b4e9a6", base: "9c30d12", time: "3 days ago", findings: 1, unknowns: 2, changedFiles: 11, changedLines: 301, coverage: "Unavailable", tool: "0.1.0" },
  { id: "run-2026-08-12", repositoryId: "pr-proof", repository: "pr-proof", verdict: "Verified", tone: "verified", ref: "#181 · baseline-artifacts", commit: "a97c331", base: "128ec90", time: "5 days ago", findings: 0, unknowns: 0, changedFiles: 6, changedLines: 98, coverage: "88%", tool: "0.1.0" },
];

export const findings = [
  { id: "finding-assertion", severity: "High", tone: "high", rule: "assertion.removed", title: "Assertion removed from session expiry test", file: "tests/auth/session.test.ts", line: 118, repository: "pr-proof", status: "New", evidence: "Test integrity", confidence: "High", explanation: "The changed test no longer asserts the expired-session branch. The test still passes, but it no longer protects the behavior named by the test.", before: "expect(result.status).toBe(\"expired\")", after: "// assertion removed", action: "Restore the assertion or explain the intentional contract change.", baseline: "New finding" },
  { id: "finding-coverage", severity: "Warning", tone: "warning", rule: "coverage.changed-line-uncovered", title: "Changed line is not covered by an executed test", file: "packages/core/src/report-schema.ts", line: 74, repository: "pr-proof", status: "New", evidence: "Coverage", confidence: "Medium", explanation: "A changed normalization branch has no changed-line coverage evidence in the synchronized report.", before: "return finding.startLine ?? finding.line", after: "return finding.endLine ?? finding.startLine ?? finding.line", action: "Add a focused test or provide the coverage artifact for this run.", baseline: "New finding" },
  { id: "finding-unknown", severity: "Info", tone: "info", rule: "impact.runtime-unknown", title: "Dynamic import consumer could not be resolved", file: "packages/cli/src/index.ts", line: 522, repository: "pr-proof", status: "Unknown", evidence: "Impact", confidence: "Low", explanation: "Static analysis could not prove whether a runtime-loaded module is affected by the change.", before: "dynamic import unresolved", after: "runtime registration unchanged", action: "Add an explicit contract or runtime evidence if this path is critical.", baseline: "Unknown evidence" },
];

export const setupTasks = [
  { label: "Install the GitHub Action", detail: "Add the workflow to a repository", state: "done" },
  { label: "Choose a default policy", detail: "Default advisory is active", state: "done" },
  { label: "Add a billing provider", detail: "Required before production checkout", state: "blocked" },
];

export function repositoryById(id) { return repositories.find((repository) => repository.id === id); }
export function runById(id) { return runs.find((run) => run.id === id); }
export function findingById(id) { return findings.find((finding) => finding.id === id); }

export const localReport = {
  schemaVersion: 1,
  schemaId: "https://pr-proof.dev/schemas/report/v1",
  toolVersion: "0.1.0",
  repository: "acme/pr-proof",
  base: "0d92af1",
  head: "8f31c2a",
  generatedAt: "2026-08-17T23:31:00.000Z",
  verdict: "NEEDS_REVIEW",
  summary: { assertionsWeakened: 1, newTests: 2, testsPassingOnBase: 1, changedLinesCoveredPercentage: 84, mutantsKilled: 7, mutantsTotal: 9, changedSymbols: 12, downstreamConsumers: 6, impactedTests: 4, impactedPathsExecuted: 5, impactedPathsTotal: 7, unverifiedPaths: 2 },
  findings: [findings[0], findings[1], findings[2]].map(({ id, rule, severity, file, line, title, explanation, action, confidence, before, after, status }) => ({ id, ruleId: rule, category: "test_integrity", severity: severity.toLowerCase(), file, startLine: line, endLine: line, title, message: title, explanation, suggestedAction: action, confidence: confidence.toLowerCase(), evidence: { before, after, detail: explanation }, resolution: status === "Unknown" ? "unknown" : "open", baselineState: status === "New" ? "new" : "unknown", fingerprint: `sha256:${id}`, module: "control-plane-preview", toolVersion: "0.1.0", baseSha: "0d92af1", headSha: "8f31c2a" })),
  limitations: ["A dynamic import consumer could not be resolved statically."],
};
