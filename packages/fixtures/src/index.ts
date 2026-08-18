import type { FileDiff, Finding, FixtureConfig, FixtureReport } from "../../core/src/types";

function matchesPath(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(file));
}

function isSnapshot(file: string): boolean {
  return /(^|\/)__snapshots__(\/|$)|\.snap$|\.snapshot\.[jt]sx?$/.test(file);
}

function isFixture(file: string): boolean {
  return /(^|\/)(fixtures?|testdata|golden)(\/|$)/i.test(file) && /\.(json|ya?ml|txt|csv|xml|snap)$/.test(file);
}

function finding(diff: FileDiff, ruleId: string, severity: Finding["severity"], message: string, explanation: string, action: string, before?: string, after?: string): Finding {
  return { id: `${ruleId}:${diff.path}:${diff.changedLines[0] ?? diff.deletedLines[0] ?? 1}`, ruleId, category: "fixture", severity, file: diff.path, line: diff.changedLines[0] ?? diff.deletedLines[0] ?? 1, message, explanation, evidence: { before, after, detail: diff.patch.slice(0, 4000) }, suggestedAction: action, confidence: "medium", module: "fixtures", blocking: severity === "critical" };
}

export function analyzeFixtures(diffs: FileDiff[], config: FixtureConfig): FixtureReport {
  if (!config.enabled) return { filesAnalyzed: 0, snapshotFiles: [], findings: [], unknowns: ["Fixture and snapshot analysis is disabled by configuration."] };
  const snapshotFiles = [...new Set(diffs.filter((diff) => isSnapshot(diff.path) || isSnapshot(diff.oldPath ?? "")).map((diff) => diff.path))].sort();
  const fixtureFiles = diffs.filter((diff) => isFixture(diff.path) || isFixture(diff.oldPath ?? ""));
  const sourceChanges = diffs.filter((diff) => !isSnapshot(diff.path) && !isFixture(diff.path) && !/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(diff.path));
  const findings: Finding[] = [];
  for (const diff of [...new Map([...fixtureFiles, ...diffs.filter((item) => isSnapshot(item.path) || isSnapshot(item.oldPath ?? ""))].map((item) => [item.path, item])).values()]) {
    if (matchesPath(diff.path, config.approved_paths) || matchesPath(diff.path, config.generated_paths)) continue;
    if (isSnapshot(diff.path) && diff.status === "deleted") findings.push(finding(diff, "fixture.snapshot-deleted", "high", "Snapshot file deleted", "A snapshot deletion can remove expected-output coverage and should be reviewed with its owning test.", "Restore it or document the intentional snapshot migration."));
    if (isSnapshot(diff.path) && diff.additions + diff.deletions > config.max_snapshot_lines) findings.push(finding(diff, "fixture.snapshot-churn", "warning", "Large snapshot change", `The snapshot changed by ${diff.additions + diff.deletions} lines, above the configured limit of ${config.max_snapshot_lines}.`, "Split the change, explain the expected-output migration, or explicitly acknowledge the churn."));
    if (isSnapshot(diff.path) && !sourceChanges.length && diff.status !== "added") findings.push(finding(diff, "fixture.snapshot-unexplained", "warning", "Snapshot changed without a source change", "The snapshot changed without a corresponding production behavior change in the compared diff.", "Review the snapshot update and add a focused explanation or revert unrelated churn."));
    if (isSnapshot(diff.path) && config.require_acknowledgement && !diff.patch.includes("pr-proof:acknowledged")) findings.push(finding(diff, "fixture.acknowledgement-missing", "warning", "Snapshot acknowledgement is missing", "Fixture configuration requires an explicit acknowledgement marker for snapshot changes.", "Add pr-proof:acknowledged to the reviewed change or disable require_acknowledgement for this fixture path."));
    if (isFixture(diff.path) && diff.status === "deleted") findings.push(finding(diff, "fixture.record-deleted", "high", "Fixture record deleted", "A fixture record was removed and may reduce edge-case coverage.", "Restore the record or document the covered behavior and replacement test."));
    const removed = diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)));
    const added = diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)));
    const removedErrors = removed.filter((line) => /error|throw|reject|denied|unauthorized|invalid/i.test(line));
    if (removedErrors.length && !added.some((line) => /error|throw|reject|denied|unauthorized|invalid/i.test(line))) findings.push(finding(diff, "fixture.expected-error-removed", "high", "Expected error fixture removed", "The diff removes expected error output without an equivalent replacement.", "Keep an explicit error fixture or add a focused regression explaining the new contract.", removedErrors.join("\n")));
    if (removed.some((line) => /toEqual|toStrictEqual|toMatchObject/.test(line)) && added.some((line) => /toMatchSnapshot|toBeTruthy|toBeDefined/.test(line))) findings.push(finding(diff, "fixture.less-specific", "warning", "Fixture assertion became less specific", "The changed test or expected output accepts a broader set of outcomes than the previous fixture.", "Preserve an explicit assertion for the behavior changed by this pull request.", removed.join("\n"), added.join("\n")));
  }
  const unknowns: string[] = [];
  if (snapshotFiles.length && !sourceChanges.length) unknowns.push("Snapshot changes without source changes require human review; fixture integrity does not infer intent.");
  if (fixtureFiles.some((diff) => diff.status === "renamed")) unknowns.push("Renamed fixture paths are compared conservatively; verify ownership and generated status.");
  return { filesAnalyzed: fixtureFiles.length + snapshotFiles.length, snapshotFiles, findings, unknowns: [...new Set(unknowns)] };
}
