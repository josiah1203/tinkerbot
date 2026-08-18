import { STATUS_GLYPHS, buildWorkItems, evidenceTrace, filterWorkItems, groupWorkItems, reportStatusLabel, severityRank, statusForVerdict, summaryMetrics, type RepositoryContext, type TuiReport } from "./model";
import { HostedControlPlaneAdapter, workItemByIndex } from "./adapter";

const repository: RepositoryContext = { root: "/tmp/example", name: "payments-api", branch: "main", commit: "abcdef123456", dirty: false, local: true };
const report: TuiReport = {
  schemaVersion: 1,
  toolVersion: "0.1.0",
  repository: "payments-api",
  base: "base-sha",
  head: "head-sha",
  verdict: "FAIL",
  summary: { changedSymbols: 3, impactedTests: 2, impactedPathsTotal: 3, impactedPathsExecuted: 2 },
  findings: [{ id: "finding-1", fingerprint: "sha256:finding-1", message: "A test was weakened", title: "Assertion weakened", severity: "high", file: "src/auth.ts", line: 42, resolution: "open" }],
  limitations: ["Dynamic import was not resolved."],
  impact: { changedSymbols: [{ name: "authenticate", file: "src/auth.ts", line: 42, change: "modified" }], paths: [{ id: "path-1", file: "src/auth.ts", symbol: "authenticate", verificationState: "unknown", reason: "Runtime consumer was not resolved.", testFiles: ["src/auth.test.ts"] }], unknowns: [] },
  policy: { pack: "default", rationale: "advisory", unknownHandling: "advisory" },
};

test("groups deterministic findings, unknowns, and changed files without color-only meaning", () => {
  const items = buildWorkItems(report, repository, ["src/auth.ts", "src/auth.test.ts"]);
  expect(items[0]?.glyph).toBe("!");
  expect(items.some((item) => item.status === "unknown" && item.glyph === "?")).toBe(true);
  expect(groupWorkItems(items).map((section) => section.group)).toEqual(["NEEDS ATTENTION", "RECENTLY VERIFIED"]);
  expect(filterWorkItems(items, "auth.test").every((item) => item.title.includes("auth.test") || item.file?.includes("auth.test"))).toBe(true);
});

test("stale reports remain visibly stale and never become pass", () => {
  const items = buildWorkItems({ ...report, verdict: "PASS", findings: [], limitations: [] }, repository, ["src/auth.ts"], true);
  expect(items.every((item) => item.status === "stale")).toBe(true);
  expect(reportStatusLabel({ ...report, verdict: "PASS" }, "stale")).toBe("STALE");
});

test("evidence trace preserves change, symbol, path, test, finding, and receipt levels", () => {
  const lines = evidenceTrace(report, buildWorkItems(report, repository, ["src/auth.ts"])[0]);
  expect(lines.join("\n")).toContain("Change");
  expect(lines.join("\n")).toContain("Symbol authenticate");
  expect(lines.join("\n")).toContain("Test src/auth.test.ts");
  expect(lines.join("\n")).toContain("Finding finding-1");
});

test("summary metrics expose explicit unknown and unavailable values", () => {
  expect(summaryMetrics(report)).toEqual(expect.arrayContaining([["Impact", "3 symbols"], ["Drift", "1 unknown"]]));
  expect(summaryMetrics(undefined)).toEqual([["Score", "—"], ["Tests", "—"], ["Contracts", "—"], ["Impact", "—"], ["Drift", "—"]]);
});

test("hosted adapter never falls back to local state when its authenticated connection is absent", async () => {
  const snapshot = await new HostedControlPlaneAdapter({ controlPlaneUrl: "", sessionToken: "", repository: "acme/service" }).loadSnapshot();
  expect(snapshot.state).toBe("permission-denied");
  expect(snapshot.warnings[0]).toContain("TINKERBOT_CONTROL_PLANE_URL");
});

test("model helpers cover every verdict, status, filtering, and empty-report state", () => {
  expect(statusForVerdict("FAIL")).toBe("fail");
  expect(statusForVerdict("NEEDS_REVIEW")).toBe("warning");
  expect(statusForVerdict("UNKNOWN")).toBe("unknown");
  expect(statusForVerdict("PASS")).toBe("pass");
  expect(STATUS_GLYPHS.info).toBe("•");
  expect(severityRank("critical")).toBeLessThan(severityRank("low"));
  expect(severityRank("unclassified")).toBe(5);

  const noReport = buildWorkItems(undefined, repository, ["src/a.ts"]);
  expect(noReport[0]).toMatchObject({ group: "IN PROGRESS", status: "running", title: "src/a.ts" });
  expect(buildWorkItems(undefined, repository, [])).toEqual([expect.objectContaining({ id: "empty:verification", status: "info" })]);
  expect(filterWorkItems(noReport, "  ")).toBe(noReport);
  expect(filterWorkItems(noReport, "payments")).toHaveLength(1);
  expect(workItemByIndex({ state: "empty", history: [], diff: "", changedFiles: [], workItems: noReport, warnings: [], loadedAt: "now" }, 3)).toBeUndefined();
  expect(reportStatusLabel(undefined, "loading")).toBe("LOADING");
  expect(reportStatusLabel(undefined, "permission-denied")).toBe("PERMISSION DENIED");
  expect(reportStatusLabel(undefined, "error")).toBe("ERROR");
  expect(reportStatusLabel(undefined, "empty")).toBe("NO REPORT");
  expect(reportStatusLabel(undefined, "unknown")).toBe("UNKNOWN");
  expect(evidenceTrace(undefined, undefined)).toContain("    No report receipt is available.");
});

test("hosted adapter maps authenticated control-plane responses without using local state", async () => {
  const originalFetch = globalThis.fetch;
  const token = "abcdefghijklmnopqrstuvwxyz123456";
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ organizationId: "org_1", assurance: { ...report, verdict: "PASS", findings: [], limitations: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = new HostedControlPlaneAdapter({ controlPlaneUrl: "https://control.example", sessionToken: token, repository: "acme/service" });
    const loaded = await adapter.loadSnapshot();
    expect(loaded).toMatchObject({ state: "ready", repository: { name: "acme/service", branch: "hosted" }, config: { organizationId: "org_1", source: "control-plane" } });
    expect(adapter.openGitHub()).toBe("https://github.com/acme/service");

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    expect((await adapter.loadSnapshot()).state).toBe("permission-denied");

    globalThis.fetch = async () => { throw new Error("offline"); };
    expect((await adapter.loadSnapshot()).warnings).toEqual(["The Tinkerbot control plane could not be reached."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
