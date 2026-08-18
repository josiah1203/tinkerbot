import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BaselineComparison, BaselineDocument, BaselineEntry, BaselineFindingState, Finding, PrProofConfig, Waiver } from "../../core/src/types";
import { findingFingerprint } from "../../core/src/report-schema";
import { resolveRepositoryPath } from "../../core/src/safety";

export const BASELINE_SCHEMA_VERSION = 1;

function normalizeRule(rule: string): string {
  return rule.toLowerCase().replace(/^test_/, "").replace(/_/g, ".");
}

function globMatches(pattern: string, value: string): boolean {
  const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`;
  return new RegExp(expression).test(value);
}

function entryMatches(entry: BaselineEntry, finding: Finding): boolean {
  const fingerprint = finding.fingerprint ?? findingFingerprint(finding);
  if (entry.fingerprint === fingerprint) return true;
  if (entry.ruleId !== finding.ruleId || entry.message !== finding.message) return false;
  const file = finding.file ?? "repository";
  // A changed fingerprint is only allowed to follow an explicit rename alias.
  // Matching any same-file message would hide rule/configuration changes.
  return Boolean(entry.file && entry.aliases?.includes(file));
}

function waiverMatches(waiver: Waiver, finding: Finding): boolean {
  const fingerprint = finding.fingerprint ?? findingFingerprint(finding);
  if (waiver.ruleId !== finding.ruleId && normalizeRule(waiver.ruleId) !== normalizeRule(finding.ruleId)) return false;
  if (waiver.fingerprint && waiver.fingerprint !== fingerprint) return false;
  if (waiver.path && (!finding.file || !globMatches(waiver.path, finding.file))) return false;
  return true;
}

function isExpired(waiver: Waiver, now: Date): boolean {
  return Boolean(waiver.expiresAt && Number.isFinite(Date.parse(waiver.expiresAt)) && Date.parse(waiver.expiresAt) < now.getTime());
}

function baselineIsStale(root: string, baseline: BaselineDocument, currentRevision: string, repository: string): { stale: boolean; unknowns: string[] } {
  const unknowns: string[] = [];
  if (baseline.repository !== repository && repository !== "local") unknowns.push(`Baseline repository ${baseline.repository} does not match current repository ${repository}.`);
  try {
    const baselineRevision = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", baseline.revision], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const resolvedCurrent = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", currentRevision], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try { execFileSync("git", ["merge-base", "--is-ancestor", baselineRevision, resolvedCurrent], { cwd: root, stdio: ["ignore", "ignore", "ignore"] }); }
    catch { unknowns.push(`Baseline revision ${baseline.revision} is not an ancestor of ${currentRevision}; refresh it explicitly.`); }
  } catch { unknowns.push(`Baseline revision ${baseline.revision} or current revision ${currentRevision} could not be resolved.`); }
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) unknowns.push(`Unsupported baseline schema version: ${String(baseline.schemaVersion)}.`);
  return { stale: unknowns.length > 0, unknowns };
}

export function readBaseline(root: string, config: PrProofConfig): BaselineDocument | undefined {
  const file = resolveRepositoryPath(root, config.baseline.path);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Invalid baseline file: ${path.relative(root, file)} (${error instanceof Error ? error.message : String(error)})`); }
  validateBaselineDocument(parsed);
  return parsed;
}

export function writeBaseline(root: string, config: PrProofConfig, document: BaselineDocument): string {
  const file = resolveRepositoryPath(root, config.baseline.path);
  validateBaselineDocument(document);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function validateBaselineDocument(value: unknown): asserts value is BaselineDocument {
  const document = value as Partial<BaselineDocument> | undefined;
  if (!document || typeof document !== "object" || document.schemaVersion !== BASELINE_SCHEMA_VERSION || typeof document.repository !== "string" || typeof document.revision !== "string" || typeof document.toolVersion !== "string" || !Array.isArray(document.entries) || !Array.isArray(document.waivers)) throw new Error("Invalid baseline schema");
  const fingerprints = new Set<string>();
  for (const entry of document.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.fingerprint !== "string" || typeof entry.ruleId !== "string" || typeof entry.message !== "string" || !["info", "warning", "high", "critical"].includes(entry.severity)) throw new Error("Invalid baseline entry");
    if (fingerprints.has(entry.fingerprint)) throw new Error("Baseline entries cannot contain duplicate fingerprints");
    fingerprints.add(entry.fingerprint);
    if (entry.file && (path.isAbsolute(entry.file) || entry.file.split(/[\\/]+/).includes(".."))) throw new Error("Baseline entry paths must be repository-relative");
  }
  const waiverKeys = new Set<string>();
  for (const waiver of document.waivers) {
    if (!waiver || typeof waiver !== "object" || typeof waiver.ruleId !== "string" || !waiver.ruleId || typeof waiver.reason !== "string" || !waiver.reason || typeof waiver.owner !== "string" || !waiver.owner || typeof waiver.createdAt !== "string" || !Number.isFinite(Date.parse(waiver.createdAt)) || waiver.ruleId === "*") throw new Error("Invalid baseline waiver");
    if (waiver.path && (path.isAbsolute(waiver.path) || waiver.path.split(/[\\/]+/).includes(".."))) throw new Error("Baseline waiver paths must be repository-relative");
    if (waiver.expiresAt && (!Number.isFinite(Date.parse(waiver.expiresAt)) || Date.parse(waiver.expiresAt) < Date.parse(waiver.createdAt))) throw new Error("Invalid baseline waiver expiry");
    const key = JSON.stringify(waiver);
    if (waiverKeys.has(key)) throw new Error("Baseline waivers cannot contain duplicate entries");
    waiverKeys.add(key);
  }
}

export function createBaseline(repository: string, revision: string, toolVersion: string, findings: Finding[], waivers: Waiver[] = [], now = new Date()): BaselineDocument {
  const entries = [...new Map(findings.map((finding) => [finding.fingerprint ?? findingFingerprint(finding), {
    fingerprint: finding.fingerprint ?? findingFingerprint(finding),
    ruleId: finding.ruleId,
    file: finding.file,
    message: finding.message,
    severity: finding.severity,
    createdAt: now.toISOString(),
  } satisfies BaselineEntry])).values()].sort((a, b) => `${a.ruleId}:${a.file ?? ""}:${a.fingerprint}`.localeCompare(`${b.ruleId}:${b.file ?? ""}:${b.fingerprint}`));
  return { schemaVersion: BASELINE_SCHEMA_VERSION, repository, revision, toolVersion, generatedAt: now.toISOString(), entries, waivers: [...waivers] };
}

export function compareBaseline(root: string, baseline: BaselineDocument, findings: Finding[], currentRevision: string, repository: string, configuredWaivers: Waiver[] = [], now = new Date()): BaselineComparison {
  const freshness = baselineIsStale(root, baseline, currentRevision, repository);
  const waivers = [...baseline.waivers, ...configuredWaivers];
  const used = new Set<string>();
  const states: BaselineComparison["findings"] = [];
  let newCount = 0;
  let existingCount = 0;
  let waivedCount = 0;
  let expiredWaiverCount = 0;
  for (const finding of findings) {
    const fingerprint = finding.fingerprint ?? findingFingerprint(finding);
    const matchingWaiver = waivers.find((waiver) => waiverMatches(waiver, finding));
    let state: BaselineFindingState = "new";
    let reason: string | undefined;
    if (freshness.stale) {
      state = "unknown";
      reason = freshness.unknowns.join(" ");
    } else if (matchingWaiver && isExpired(matchingWaiver, now)) {
      state = "expired";
      reason = `Waiver for ${finding.ruleId} expired on ${matchingWaiver.expiresAt}.`;
      expiredWaiverCount += 1;
      newCount += 1;
    } else if (matchingWaiver) {
      state = "waived";
      reason = matchingWaiver.reason;
      waivedCount += 1;
    } else {
      const match = baseline.entries.find((entry) => entryMatches(entry, finding));
      if (match) {
        state = "existing";
        used.add(match.fingerprint);
        existingCount += 1;
      } else newCount += 1;
    }
    states.push({ fingerprint, ruleId: finding.ruleId, file: finding.file, state, reason });
  }
  const resolved = freshness.stale ? [] : baseline.entries.filter((entry) => !used.has(entry.fingerprint));
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineRevision: baseline.revision,
    currentRevision,
    stale: freshness.stale,
    unknowns: freshness.unknowns,
    newCount,
    existingCount,
    resolvedCount: resolved.length,
    waivedCount,
    expiredWaiverCount,
    findings: states,
    resolved,
  };
}

export function applyBaselineStates(findings: Finding[], comparison: BaselineComparison): Finding[] {
  const states = new Map(comparison.findings.map((item) => [item.fingerprint, item]));
  return findings.map((finding) => {
    const fingerprint = finding.fingerprint ?? findingFingerprint(finding);
    const state = states.get(fingerprint);
    if (!state) return finding;
    const isNonBlocking = state.state === "existing" || state.state === "waived";
    return {
      ...finding,
      baselineState: state.state,
      blocking: isNonBlocking ? false : finding.blocking,
      resolution: isNonBlocking ? "informational" : finding.resolution,
    };
  });
}
