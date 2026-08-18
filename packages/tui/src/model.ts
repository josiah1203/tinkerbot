export type TuiVerdict = "PASS" | "NEEDS_REVIEW" | "UNKNOWN" | "FAIL";
export type TuiState = "loading" | "ready" | "empty" | "stale" | "unknown" | "permission-denied" | "error";
export type WorkGroup = "NEEDS ATTENTION" | "IN PROGRESS" | "RECENTLY VERIFIED";
export type WorkStatus = "fail" | "warning" | "unknown" | "stale" | "running" | "pass" | "info";

export interface TuiFinding {
  id: string;
  fingerprint?: string;
  title?: string;
  message: string;
  severity: string;
  file?: string;
  line?: number;
  module?: string;
  resolution?: string;
  baselineState?: string;
  explanation?: string;
  evidenceRefs?: string[];
  evidence?: { before?: string; after?: string; detail?: string };
}

export interface TuiReport {
  schemaVersion?: number;
  schemaId?: string;
  toolVersion?: string;
  repository?: string;
  base?: string;
  head?: string;
  changeIdentity?: { changeId?: string; pullRequestNumber?: number; branch?: string };
  generatedAt?: string;
  observedAt?: string;
  verdict: TuiVerdict;
  summary: Record<string, number | string | null>;
  findings: TuiFinding[];
  limitations: string[];
  testIntegrity?: {
    findings?: TuiFinding[];
    unknowns?: string[];
    coverage?: Record<string, number | string | null | boolean>;
    mutation?: Record<string, number | string | null | boolean>;
  };
  impact?: {
    changedSymbols?: Array<{ name: string; file: string; line: number; kind?: string; change?: string }>;
    paths?: Array<{ id: string; file: string; symbol?: string; sourceFile?: string; sourceSymbol?: string; verificationState?: string; reason?: string; testFiles?: string[] }>;
    unknowns?: string[];
  };
  baseline?: { stale?: boolean; unknowns?: string[]; newCount?: number; existingCount?: number; resolvedCount?: number; waivedCount?: number; expiredWaiverCount?: number };
  policy?: { pack?: string; rationale?: string; unknownHandling?: string };
  contracts?: { changes?: unknown[]; findings?: TuiFinding[]; unknowns?: string[] };
  fixtures?: { findings?: TuiFinding[]; unknowns?: string[] };
  selection?: { status?: string; confidence?: string; selected?: string[]; unknown?: string[]; requiresFullSuite?: boolean; fallback?: string };
  assurance?: {
    receipts?: Array<{ id: string; verdict?: TuiVerdict; integrity?: { digest?: string }; states?: { partial?: boolean; unknown?: string[] }; evidenceRefs?: Array<{ id: string; type: string; status: string; sha256?: string; detail?: string }> }>;
    unknowns?: string[];
  };
  evidence?: {
    schemaVersion?: number;
    schemaId?: string;
    runId?: string;
    receiptId?: string;
    verdict?: string;
    policy?: { version?: string; result?: string };
    generatedAt?: string;
    observedAt?: string;
    unknownStates?: string[];
    staleStates?: string[];
    evidenceHashes?: string[];
    affectedFiles?: string[];
    affectedSymbols?: string[];
    sourceUpload?: string;
    diffUpload?: string;
    integrity?: { algorithm?: string; digest?: string };
    changeIdentity?: { changeId?: string; pullRequestNumber?: number; branch?: string };
  };
}

export interface WorkItem {
  id: string;
  group: WorkGroup;
  status: WorkStatus;
  glyph: string;
  severity: string;
  repository: string;
  change: string;
  timestamp: string;
  title: string;
  detail?: string;
  file?: string;
  line?: number;
  finding?: TuiFinding;
}

export interface RepositoryContext {
  root: string;
  name: string;
  branch: string;
  commit: string;
  dirty: boolean;
  remote?: string;
  githubUrl?: string;
  local: true;
  base?: string;
  head?: string;
}

export interface RepositoryOption {
  path: string;
  name: string;
  branch?: string;
  githubUrl?: string;
  current: boolean;
  source: "worktree" | "configured";
}

export interface TuiSnapshot {
  state: TuiState;
  repository?: RepositoryContext;
  repositories?: RepositoryOption[];
  worktrees?: string[];
  report?: TuiReport;
  history: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  diff: string;
  changedFiles: string[];
  workItems: WorkItem[];
  warnings: string[];
  loadedAt: string;
}

export interface TuiCommandResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  value?: unknown;
}

export const STATUS_GLYPHS: Record<WorkStatus, string> = {
  fail: "!",
  warning: "▲",
  unknown: "?",
  stale: "◌",
  running: "◷",
  pass: "✓",
  info: "•",
};

export function statusForVerdict(verdict: TuiVerdict): WorkStatus {
  if (verdict === "FAIL") return "fail";
  if (verdict === "NEEDS_REVIEW") return "warning";
  if (verdict === "UNKNOWN") return "unknown";
  return "pass";
}

export function severityRank(value: string): number {
  return ({ critical: 0, high: 1, warning: 2, medium: 2, info: 3, low: 4 } as Record<string, number>)[value.toLowerCase()] ?? 5;
}

function timestamp(value?: string): string {
  if (!value) return "now";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const age = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function findingItem(finding: TuiFinding, report: TuiReport, repository: string, stale: boolean): WorkItem {
  const status: WorkStatus = stale ? "stale" : finding.resolution === "unknown" ? "unknown" : finding.severity === "critical" || finding.severity === "high" ? "fail" : "warning";
  return {
    id: `finding:${finding.fingerprint ?? finding.id}`,
    group: "NEEDS ATTENTION",
    status,
    glyph: STATUS_GLYPHS[status],
    severity: finding.severity.toUpperCase(),
    repository,
    change: report.head ? `Change ${report.head.slice(0, 8)}` : "Worktree",
    timestamp: timestamp(report.generatedAt ?? report.observedAt),
    title: finding.title ?? finding.message,
    detail: finding.message,
    file: finding.file,
    line: finding.line,
    finding,
  };
}

export function buildWorkItems(report: TuiReport | undefined, repository: RepositoryContext | undefined, changedFiles: string[], stale = false): WorkItem[] {
  const repoName = repository?.name ?? report?.repository ?? "repository";
  if (!report) {
    const items: WorkItem[] = changedFiles.slice(0, 50).map((file) => ({
      id: `file:${file}`,
      group: "IN PROGRESS",
      status: "running",
      glyph: STATUS_GLYPHS.running,
      severity: "—",
      repository: repoName,
      change: "Worktree",
      timestamp: "local",
      title: file,
      file,
      detail: "Changed locally; no deterministic verification report has been recorded.",
    }));
    if (!items.length) items.push({
      id: "empty:verification",
      group: "IN PROGRESS",
      status: "info",
      glyph: STATUS_GLYPHS.info,
      severity: "—",
      repository: repoName,
      change: "Worktree",
      timestamp: "local",
      title: "No local verification yet",
      detail: "Run `r` or enter `:rerun` to create a deterministic report.",
    });
    return items;
  }

  const items: WorkItem[] = (report.findings ?? []).map((finding) => findingItem(finding, report, repoName, stale));
  const unknowns = [...new Set([...(report.limitations ?? []), ...(report.impact?.unknowns ?? []), ...(report.testIntegrity?.unknowns ?? []), ...(report.contracts?.unknowns ?? []), ...(report.fixtures?.unknowns ?? [])])];
  for (const [index, detail] of unknowns.slice(0, 30).entries()) items.push({
    id: `unknown:${index}:${detail}`,
    group: "NEEDS ATTENTION",
    status: stale ? "stale" : "unknown",
    glyph: STATUS_GLYPHS[stale ? "stale" : "unknown"],
    severity: "UNKNOWN",
    repository: repoName,
    change: report.head ? `Change ${report.head.slice(0, 8)}` : "Worktree",
    timestamp: timestamp(report.generatedAt ?? report.observedAt),
    title: stale ? "Evidence is stale" : "Evidence is unknown",
    detail,
  });

  const verifiedFiles = [...new Set([...(report.impact?.changedSymbols ?? []).map((item) => item.file), ...changedFiles])];
  for (const file of verifiedFiles.slice(0, 50)) if (!items.some((item) => item.file === file)) items.push({
    id: `verified:${file}`,
    group: stale ? "IN PROGRESS" : "RECENTLY VERIFIED",
    status: stale ? "stale" : "pass",
    glyph: STATUS_GLYPHS[stale ? "stale" : "pass"],
    severity: "—",
    repository: repoName,
    change: report.head ? `Change ${report.head.slice(0, 8)}` : "Worktree",
    timestamp: timestamp(report.generatedAt ?? report.observedAt),
    title: file,
    file,
    detail: stale ? "The current checkout no longer matches this report." : "Changed file covered by the latest local report.",
  });
  if (!items.length) items.push({
    id: "verified:report",
    group: stale ? "IN PROGRESS" : "RECENTLY VERIFIED",
    status: stale ? "stale" : statusForVerdict(report.verdict),
    glyph: STATUS_GLYPHS[stale ? "stale" : statusForVerdict(report.verdict)],
    severity: report.verdict,
    repository: repoName,
    change: report.head ? `Change ${report.head.slice(0, 8)}` : "Worktree",
    timestamp: timestamp(report.generatedAt ?? report.observedAt),
    title: stale ? "Report needs rerun" : `Verification ${report.verdict.toLowerCase()}`,
    detail: stale ? "Evidence is not current for this checkout." : "Deterministic verification completed.",
  });
  return items.sort((left, right) => `${left.group}:${severityRank(left.severity)}:${left.title}`.localeCompare(`${right.group}:${severityRank(right.severity)}:${right.title}`));
}

export function filterWorkItems(items: WorkItem[], query: string): WorkItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => [item.title, item.detail, item.file, item.repository, item.change, item.severity, item.group].filter(Boolean).join(" ").toLowerCase().includes(normalized));
}

export function groupWorkItems(items: WorkItem[]): Array<{ group: WorkGroup; items: WorkItem[] }> {
  return (["NEEDS ATTENTION", "IN PROGRESS", "RECENTLY VERIFIED"] as WorkGroup[]).map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((section) => section.items.length > 0);
}

export function reportStatusLabel(report: TuiReport | undefined, state: TuiState): string {
  if (state === "loading") return "LOADING";
  if (state === "permission-denied") return "PERMISSION DENIED";
  if (state === "error") return "ERROR";
  if (state === "empty") return "NO REPORT";
  if (state === "stale") return "STALE";
  if (state === "unknown") return "UNKNOWN";
  return report?.verdict ?? "UNKNOWN";
}

export function evidenceTrace(report: TuiReport | undefined, item: WorkItem | undefined): string[] {
  if (!report) return ["Change", "  Worktree", "    No report receipt is available."];
  const file = item?.file ?? report.impact?.changedSymbols?.[0]?.file ?? "repository";
  const symbol = report.impact?.changedSymbols?.find((entry) => entry.file === file);
  const paths = (report.impact?.paths ?? []).filter((entry) => entry.file === file || entry.sourceFile === file).slice(0, 8);
  const lines = ["Change", `  ${report.head ? `Commit ${report.head.slice(0, 12)}` : "Current worktree"}`, `    File ${file}`];
  if (symbol) lines.push(`      Symbol ${symbol.name} (${symbol.change ?? "changed"})`);
  if (paths.length) for (const path of paths) {
    lines.push(`        Impact ${path.symbol ?? path.file} — ${path.verificationState ?? "unknown"}`);
    for (const test of (path.testFiles ?? []).slice(0, 3)) lines.push(`          Test ${test}`);
  }
  const finding = item?.finding ?? report.findings?.find((entry) => entry.file === file);
  if (finding) {
    lines.push(`          Finding ${finding.id}`);
    lines.push(`            Receipt ${finding.evidenceRefs?.[0] ?? report.assurance?.receipts?.[0]?.id ?? "not generated"}`);
  } else lines.push(`      Receipt ${report.assurance?.receipts?.[0]?.id ?? "create with x"}`);
  return lines;
}

export function summaryMetrics(report: TuiReport | undefined): Array<[string, string]> {
  if (!report) return [["Score", "—"], ["Tests", "—"], ["Contracts", "—"], ["Impact", "—"], ["Drift", "—"]];
  const summary = report.summary ?? {};
  const tests = report.testIntegrity;
  const contracts = report.contracts;
  const impact = report.impact;
  const testCount = Number(summary.impactedTests ?? summary.newTests ?? 0);
  const testTotal = Number(summary.impactedPathsTotal ?? 0);
  const contractCount = Array.isArray(contracts?.changes) ? contracts.changes.length : contracts ? 1 : 0;
  const impactCount = Number(summary.changedSymbols ?? impact?.changedSymbols?.length ?? 0);
  const unknownCount = (report.limitations ?? []).length + (impact?.unknowns ?? []).length;
  const score = report.verdict === "PASS" ? "100 / 100" : report.verdict === "FAIL" ? "0 / 100" : report.verdict;
  return [["Score", score], ["Tests", testTotal ? `${testCount}/${testTotal}` : tests ? "available" : "—"], ["Contracts", contractCount ? `${contractCount}` : "—"], ["Impact", `${impactCount} symbols`], ["Drift", unknownCount ? `${unknownCount} unknown` : "NONE"]];
}
