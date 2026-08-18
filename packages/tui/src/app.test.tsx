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
