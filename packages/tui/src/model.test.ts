import { buildWorkItems, evidenceTrace, filterWorkItems, groupWorkItems, reportStatusLabel, summaryMetrics, type RepositoryContext, type TuiReport } from "./model";

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
