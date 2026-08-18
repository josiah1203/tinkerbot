import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { TuiApp } from "./app";
import { buildWorkItems, type TuiSnapshot } from "./model";
import type { TuiAdapter } from "./adapter";

function snapshot(): TuiSnapshot {
  const repository = { root: "/tmp/payments-api", name: "payments-api", branch: "main", commit: "abcdef123456", dirty: true, local: true as const };
  const report = {
    schemaVersion: 1,
    schemaId: "https://pr-proof.dev/schemas/report/v1",
    toolVersion: "0.1.0",
    repository: "payments-api",
    base: "base",
    head: "head",
    verdict: "UNKNOWN" as const,
    summary: { changedSymbols: 2, impactedTests: 1, impactedPathsTotal: 2, impactedPathsExecuted: 1 },
    findings: [{ id: "finding", fingerprint: "sha256:finding", title: "Unknown impact", message: "Dynamic consumer unresolved", severity: "high", file: "src/auth.ts", line: 4, resolution: "unknown" }],
    limitations: ["Dynamic consumer unresolved"],
    impact: { changedSymbols: [{ name: "authenticate", file: "src/auth.ts", line: 4, change: "modified" }], paths: [{ id: "path", file: "src/auth.ts", symbol: "authenticate", verificationState: "unknown", testFiles: ["src/auth.test.ts"] }], unknowns: ["Dynamic consumer unresolved"] },
    policy: { pack: "default", rationale: "advisory", unknownHandling: "advisory" },
    evidence: { schemaVersion: 1, schemaId: "https://tinkerbot.dev/schemas/evidence/v1", runId: "run-1", receiptId: "receipt-1", verdict: "UNKNOWN", sourceUpload: "not_uploaded", diffUpload: "not_uploaded", unknownStates: ["dynamic"], staleStates: [], integrity: { digest: "sha256:fixture" } },
  };
  const workItems = buildWorkItems(report, repository, ["src/auth.ts"]);
  return { state: "unknown", repository, repositories: [], worktrees: [], report, history: [], config: { policy: "default" }, diff: "@@ -1,1 +1,2 @@\n-const old = true\n+const next = true", changedFiles: ["src/auth.ts"], workItems, warnings: [], loadedAt: "2026-01-01T00:00:00.000Z" };
}

function adapter(value: TuiSnapshot): TuiAdapter {
  return {
    loadSnapshot: async () => value,
    startVerification: () => ({ promise: Promise.resolve({ status: 0, cancelled: false, stdout: "", stderr: "", snapshot: value }), cancel: () => undefined }),
    exportReceipt: async () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    exportEvidence: async () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    exportReport: async () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    openGitHub: () => "https://github.com/example/payments-api/pull/1",
  };
}

test("TUI activates named navigation commands, filters through the focused input, and renders evidence states", async () => {
  const setup = await createTestRenderer({ width: 120, height: 40, screenMode: "main-screen" });
  let quit = false;
  try {
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={adapter(snapshot())} onQuit={() => { quit = true; }} /></KeymapProvider>, setup.renderer);
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("NEEDS ATTENTION");

    setup.mockInput.pressKey("d");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("unified local diff");

    setup.mockInput.pressKey("s");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("split local diff");

    setup.mockInput.pressKey("e");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("CANONICAL EVIDENCE CONTRACT");

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("auth");
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Filtering: auth");

    setup.mockInput.pressKey("?");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("TINKERBOT LOCAL WORKSPACE");

    setup.mockInput.pressKey("q");
    expect(quit).toBe(true);
  } finally {
    setup.renderer.destroy();
  }
});

test("TUI streams a run state and forwards cancellation to the local child process", async () => {
  const setup = await createTestRenderer({ width: 120, height: 40, screenMode: "main-screen" });
  let cancelled = false;
  const runAdapter = adapter(snapshot());
  runAdapter.startVerification = () => ({ promise: new Promise(() => undefined), cancel: () => { cancelled = true; } });
  try {
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={runAdapter} onQuit={() => undefined} /></KeymapProvider>, setup.renderer);
    await setup.waitForVisualIdle();
    setup.mockInput.pressKey("r");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Verification run");
    setup.mockInput.pressKey("c");
    expect(cancelled).toBe(true);
  } finally {
    setup.renderer.destroy();
  }
});

test("TUI renders command-mode exports, secondary views, and explicit adapter failures", async () => {
  const setup = await createTestRenderer({ width: 120, height: 40, screenMode: "main-screen" });
  const calls: string[] = [];
  const commandAdapter = adapter(snapshot());
  commandAdapter.exportReceipt = async () => { calls.push("receipt"); return { ok: false, status: 12, stdout: "", stderr: "hosted record only" }; };
  commandAdapter.exportEvidence = async () => { calls.push("evidence"); return { ok: true, status: 0, stdout: "", stderr: "" }; };
  commandAdapter.exportReport = async (format) => { calls.push(format); return { ok: format !== "sarif", status: format === "sarif" ? 5 : 0, stdout: "", stderr: "write blocked" }; };
  commandAdapter.openGitHub = () => undefined;
  commandAdapter.selectRepository = (root) => calls.push(`repo:${root}`);
  try {
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={commandAdapter} onQuit={() => undefined} /></KeymapProvider>, setup.renderer);
    await setup.waitForVisualIdle();

    setup.mockInput.pressKey("p");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("EFFECTIVE POLICY");

    setup.mockInput.pressKey("x");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Receipt export unavailable: hosted record only");

    setup.mockInput.pressKey("o");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("No GitHub remote is configured");

    setup.mockInput.pressKey("escape");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("NEEDS ATTENTION");
  } finally {
    setup.renderer.destroy();
  }
});

test("TUI renders empty, unavailable, and narrow hosted states without inventing local evidence", async () => {
  const setup = await createTestRenderer({ width: 80, height: 28, screenMode: "main-screen" });
  const unavailable: TuiAdapter = {
    ...adapter(snapshot()),
    loadSnapshot: async () => ({ state: "permission-denied", history: [], diff: "", changedFiles: [], workItems: [], warnings: ["Hosted session expired"], loadedAt: "now" }),
    openGitHub: () => undefined,
  };
  try {
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={unavailable} dimensions={() => ({ width: 80, height: 28 })} onQuit={() => undefined} /></KeymapProvider>, setup.renderer);
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("Hosted");
    expect(setup.captureCharFrame()).toContain("PERMISSION DENIED");
  } finally {
    setup.renderer.destroy();
  }

  const emptySetup = await createTestRenderer({ width: 120, height: 40, screenMode: "main-screen" });
  const empty: TuiAdapter = {
    ...adapter(snapshot()),
    loadSnapshot: async () => ({ state: "empty", repository: snapshot().repository, repositories: [], history: [], diff: "", changedFiles: [], workItems: [], warnings: ["No hosted assurance record is available"], loadedAt: "now" }),
    openGitHub: () => undefined,
  };
  try {
    const keymap = createDefaultOpenTuiKeymap(emptySetup.renderer);
    await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={empty} onQuit={() => undefined} /></KeymapProvider>, emptySetup.renderer);
    await emptySetup.waitForVisualIdle();
    expect(emptySetup.captureCharFrame()).toContain("No report receipt is available.");
    expect(emptySetup.captureCharFrame()).toContain("NO REPORT");
  } finally {
    emptySetup.renderer.destroy();
  }
});

test("TUI renders every supported startup panel with its authoritative state", async () => {
  const value: TuiSnapshot = {
    ...snapshot(),
    repositories: [{ path: "/tmp/payments-api", name: "payments-api", branch: "main", current: true, source: "worktree" }],
    history: [{ recordedAt: "2026-01-01", verdict: "PASS", head: "abcdef" }],
  };
  const panels: Array<[Parameters<typeof TuiApp>[0]["initialView"], string]> = [
    ["overview", "Overview"],
    ["diff", "Diff"],
    ["evidence", "Evidence trace"],
    ["policy", "Policy"],
    ["run", "Verification run"],
    ["help", "Help"],
    ["repositories", "Repositories"],
    ["runs", "Runs"],
    ["releases", "Releases"],
  ];
  for (const [initialView, expected] of panels) {
    const setup = await createTestRenderer({ width: 120, height: 40, screenMode: "main-screen" });
    try {
      const keymap = createDefaultOpenTuiKeymap(setup.renderer);
      await render(() => <KeymapProvider keymap={keymap}><TuiApp adapter={adapter(value)} initialView={initialView} onQuit={() => undefined} /></KeymapProvider>, setup.renderer);
      await setup.waitForVisualIdle();
      expect(setup.captureCharFrame()).toContain(expected);
    } finally {
      setup.renderer.destroy();
    }
  }
});
