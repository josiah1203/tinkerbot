import type { TestSelectionPlan } from "../../../core/src/types";
import type { StreamFlags, StreamSpec } from "./types";

function testUniverse(selection: TestSelectionPlan): number {
  return selection.selected.length + selection.related.length + selection.unrelated.length + selection.unknown.length;
}

function properSubset(selection: TestSelectionPlan): boolean {
  const total = testUniverse(selection);
  return selection.selected.length > 0 && selection.selected.length < total;
}

export function planVerificationStreams(selection: TestSelectionPlan | undefined, flags: StreamFlags): StreamSpec[] {
  const suiteEnabled = flags.runBaseTests;
  const subsetLocked = !selection || selection.requiresFullSuite || !properSubset(selection);
  const subsetLockReason = !selection
    ? "Impact selection has not run; the configured suite is required."
    : selection.requiresFullSuite
      ? selection.fallback
      : !properSubset(selection)
        ? "Selected tests are not a proper subset of the suite; early run is skipped."
        : undefined;
  const subsetEnabled = flags.watchSubset && !subsetLocked;
  return [
    { id: "coverage", label: "Coverage", role: "analysis", feedsVerdict: true, enabled: flags.coverageConfigured, locked: false },
    { id: "suite", label: `Bash(${flags.testCommand})`, role: "authoritative", feedsVerdict: true, enabled: suiteEnabled, locked: !suiteEnabled, lockReason: suiteEnabled ? undefined : "Base/head execution is disabled; missing suite evidence is UNKNOWN." },
    { id: "integrity", label: "TestIntegrity", role: "analysis", feedsVerdict: true, enabled: true, locked: false },
    { id: "mutation", label: "Mutation", role: "optional", feedsVerdict: true, enabled: flags.runMutation, locked: false },
    { id: "impact", label: "Impact", role: "analysis", feedsVerdict: true, enabled: true, locked: false },
    { id: "select", label: "SelectTests", role: "recommendation", feedsVerdict: false, enabled: true, locked: false },
    { id: "subset", label: "Subset", role: "early_signal", feedsVerdict: false, enabled: subsetEnabled, locked: subsetLocked, lockReason: subsetLockReason },
    { id: "fixtures", label: "Fixtures", role: "analysis", feedsVerdict: true, enabled: flags.fixturesEnabled, locked: false },
    { id: "verdict", label: "Verdict", role: "verdict", feedsVerdict: true, enabled: true, locked: false },
  ];
}

export function subsetPendingMessage(subsetPassed: boolean, suiteDone: boolean, verdict?: string): string | undefined {
  if (subsetPassed && !suiteDone) return "early signal passed · verdict pending";
  if (subsetPassed && suiteDone && verdict) return `early signal is not the gate · verdict ${verdict}`;
  return undefined;
}
