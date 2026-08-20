import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  LEGACY_CHECK_NAMES,
  TINKERBOT_CHECK_NAME,
  TINKERBOT_COMMENT_MARKER,
  canPublish,
  checkConclusion,
  hasLegacyCommentMarker,
  isForkPullRequest,
  mapCheckAnnotations,
  normalizeAnnotationPath,
  type PullRequestEventShape,
} from "../packages/github/src";

const MARKER = TINKERBOT_COMMENT_MARKER;
// Compatibility: the previous sticky marker <!-- pr-proof:sticky --> remains
// discoverable and is updated in place by hasLegacyCommentMarker.

function input(name: string, fallback = ""): string {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replace(/[^A-Z0-9]/g, "_")}`] || fallback;
}

function redact(value: string): string {
  let output = value;
  for (const secret of [process.env.GITHUB_TOKEN, process.env.GH_TOKEN, process.env.NODE_AUTH_TOKEN, input("token")].filter((item): item is string => Boolean(item && item.length >= 4))) output = output.split(secret).join("[REDACTED]");
  return output;
}

function escapeWorkflowCommand(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function oneLine(value: string): string {
  return redact(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function eventPullRequestValue(key: "head" | "base"): string | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const event = JSON.parse(fs.readFileSync(file, "utf8")) as { pull_request?: { head?: { sha?: string }; base?: { sha?: string } } };
    return key === "head" ? event.pull_request?.head?.sha : event.pull_request?.base?.sha;
  } catch {
    return undefined;
  }
}

function pullRequestEvent(): PullRequestEventShape | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as PullRequestEventShape; }
  catch { return undefined; }
}

function eventPullRequestNumber(): number | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const event = JSON.parse(fs.readFileSync(file, "utf8")) as PullRequestEventShape;
    return Number(event.number) || undefined;
  } catch { return undefined; }
}

async function githubRequest(endpoint: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const token = process.env.GITHUB_TOKEN || input("token");
  if (!token || !process.env.GITHUB_REPOSITORY) return { status: 0, body: undefined };
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(`${api}${endpoint}`, { ...init, signal: controller.signal, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "content-type": "application/json", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}

interface ActionFinding {
  id?: string;
  fingerprint?: string;
  ruleId?: string;
  file?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  severity?: string;
  title?: string;
  message?: string;
}

interface ActionReport {
  verdict: string;
  findings: ActionFinding[];
  summary: Record<string, unknown>;
  head: string;
  policy?: { pack?: string; unknownHandling?: string };
  baseline?: { stale?: boolean; newCount?: number; existingCount?: number; waivedCount?: number };
  testIntegrity?: { newTests?: number; modifiedTests?: number; testsPassingOnBase?: number; coverage?: { percentage?: number | null }; mutation?: { killed?: number; results?: unknown[] }; unknowns?: string[] };
  contracts?: { changes?: unknown[]; unknowns?: string[] };
  evidence?: { verdict?: string; receiptId?: string; runId?: string; staleStates?: string[]; unknownStates?: string[]; integrity?: { digest?: string } };
}

interface ActionRunResult {
  status: number;
  reportFile: string;
  markdownFile: string;
  sarifFile: string;
  receiptFile: string;
  reviewContextFile: string;
  evidenceContractFile: string;
  assuranceBundleFile: string;
  stdout: string;
}

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}

function runCli(): ActionRunResult {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const actionRoot = path.resolve(__dirname, "..");
  const reportDirectory = path.join(workspace, ".pr-proof");
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportFile = path.join(reportDirectory, "report.json");
  const markdownFile = path.join(reportDirectory, "report.md");
  const sarifFile = path.join(reportDirectory, "report.sarif");
  const receiptFile = path.join(reportDirectory, "receipt.json");
  const reviewContextFile = path.join(reportDirectory, "review-context.json");
  const evidenceContractFile = path.join(reportDirectory, "evidence-contract.json");
  const assuranceBundleFile = path.join(reportDirectory, "assurance-bundle.json");
  const cli = process.env.TINKERBOT_ACTION_CLI || path.join(actionRoot, "packages", "cli", "src", "index.js");
  if (!fs.existsSync(cli)) throw new Error("Built CLI artifact is missing at dist/packages/cli/src/index.js; run pnpm build before using the Action.");
  const base = input("base", eventPullRequestValue("base") || "origin/main");
  const head = input("head", eventPullRequestValue("head") || process.env.GITHUB_SHA || "HEAD");
  const config = input("config", "pr-proof.yml");
  const args = [cli, "check", "--base", base, "--head", head, "--format", "json", "--output", reportFile, "--mode", input("mode", "advisory"), "--fail-on", input("fail-on", "critical_unverified_impact"), "--mutation-enabled", input("mutation-enabled", "false"), "--mutation-max", input("mutation-max", "20"), "--policy", input("policy", "default"), "--timeout", input("timeout", "120"), "--max-files", input("max-files", "5000"), "--max-findings", input("max-findings", "200"), "--comment", input("comment", "true"), "--check-run", input("check-run", input("check_run", "true")), "--sarif", input("sarif", "true")];
  if (fs.existsSync(path.resolve(workspace, config))) args.push("--config", config);
  const safeEnvironment = { ...process.env };
  for (const secretName of Object.keys(safeEnvironment)) if (/token|secret|password|credential|private.?key|api.?key/i.test(secretName)) delete safeEnvironment[secretName];
  const timeoutSeconds = Number(input("timeout", "120"));
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: "utf8", env: { ...safeEnvironment, PR_PROOF_ACTION: "1" }, timeout: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 120_000, killSignal: "SIGTERM", maxBuffer: 16 * 1024 * 1024 });
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) as ActionReport : undefined;
  if (report) {
    const receipt = spawnSync(process.execPath, [cli, "proof", "create", "--input", reportFile, "--format", "receipt", "--output", receiptFile], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (receipt.status !== 0 && !fs.existsSync(receiptFile)) process.stdout.write(`::notice::Tinkerbot Verify receipt export was unavailable (status ${String(receipt.status)}); the deterministic report remains available.\n`);
    const evidence = spawnSync(process.execPath, [cli, "evidence", "--input", reportFile, "--format", "json", "--output", path.join(reportDirectory, "evidence-report.json")], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const evidenceReportFile = path.join(reportDirectory, "evidence-report.json");
    if (fs.existsSync(evidenceReportFile)) {
      try {
        const enriched = JSON.parse(fs.readFileSync(evidenceReportFile, "utf8")) as { evidence?: unknown };
        if (enriched.evidence && typeof enriched.evidence === "object") writePrivate(evidenceContractFile, `${JSON.stringify(enriched.evidence, null, 2)}\n`);
      } catch {
        // A malformed optional envelope cannot replace the deterministic report.
      }
    }
    if (!fs.existsSync(evidenceContractFile)) process.stdout.write(`::notice::Tinkerbot Verify evidence contract export was unavailable (status ${String(evidence.status)}); the deterministic report remains available.\n`);
    const reviewContext = spawnSync(process.execPath, [cli, "evidence", "--input", reportFile, "--format", "review-context", "--output", reviewContextFile], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (!fs.existsSync(reviewContextFile)) process.stdout.write(`::notice::Tinkerbot Verify review-context export was unavailable (status ${String(reviewContext.status)}); the deterministic report remains available.\n`);
    const assuranceEnvelopeFile = path.join(reportDirectory, "assurance-envelope.json");
    const assurance = spawnSync(process.execPath, [cli, "evidence", "--input", reportFile, "--format", "change-assurance", "--output", assuranceEnvelopeFile], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (fs.existsSync(assuranceEnvelopeFile)) {
      try {
        const envelope = JSON.parse(fs.readFileSync(assuranceEnvelopeFile, "utf8")) as { assurance?: unknown };
        if (envelope.assurance && typeof envelope.assurance === "object" && !Array.isArray(envelope.assurance)) writePrivate(assuranceBundleFile, `${JSON.stringify(envelope.assurance, null, 2)}\n`);
      } catch { /* The deterministic report remains usable without hosted submission. */ }
    }
    if (!fs.existsSync(assuranceBundleFile)) process.stdout.write(`::notice::Tinkerbot Verify assurance bundle export was unavailable (status ${String(assurance.status)}); hosted submission was skipped.\n`);
    if (input("sarif", "true") === "true") {
      const sarif = spawnSync(process.execPath, [cli, "report", "--input", reportFile, "--format", "sarif"], { cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      writePrivate(sarifFile, sarif.stdout || "{}");
    }
    const contract = fs.existsSync(evidenceContractFile) ? JSON.parse(fs.readFileSync(evidenceContractFile, "utf8")) as ActionReport["evidence"] : undefined;
    fs.writeFileSync(markdownFile, renderActionMarkdown({ ...report, evidence: contract }));
  }
  return { status: result.status ?? 2, reportFile, markdownFile, sarifFile, receiptFile, reviewContextFile, evidenceContractFile, assuranceBundleFile, stdout: redact(result.stdout ?? result.stderr ?? "") };
}

async function exchangeOidcRunToken(base: string): Promise<string | undefined> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken || !process.env.GITHUB_REPOSITORY) return undefined;
  const audience = process.env.TINKERBOT_OIDC_AUDIENCE ?? "tinkerbot";
  const separator = requestUrl.includes("?") ? "&" : "?";
  const tokenResponse = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" } });
  if (!tokenResponse.ok) return undefined;
  const tokenBody = await tokenResponse.json() as { value?: string };
  if (!tokenBody.value) return undefined;
  const exchanged = await fetch(`${base}/actions/oidc/exchange`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ token: tokenBody.value, repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA }) });
  if (!exchanged.ok) return undefined;
  const payload = await exchanged.json() as { runToken?: string };
  return payload.runToken && /^[A-Za-z0-9_-]{20,200}$/.test(payload.runToken) ? payload.runToken : undefined;
}

async function submitHostedEvidence(result: ActionRunResult): Promise<void> {
  const base = input("control-plane-url").replace(/\/$/, "");
  if (!base) return;
  if (!/^https:\/\//.test(base)) {
    process.stdout.write("::notice::Tinkerbot hosted evidence submission was skipped because control-plane-url is invalid.\n");
    return;
  }
  const credential = await exchangeOidcRunToken(base) ?? input("session-token");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(credential)) {
    process.stdout.write("::notice::Tinkerbot hosted evidence submission was skipped because OIDC exchange and session-token were unavailable.\n");
    return;
  }
  if (!fs.existsSync(result.assuranceBundleFile) || !process.env.GITHUB_REPOSITORY) {
    process.stdout.write("::notice::Tinkerbot hosted evidence submission was skipped because the assurance bundle or repository identity is unavailable.\n");
    return;
  }
  const assurance = JSON.parse(fs.readFileSync(result.assuranceBundleFile, "utf8")) as unknown;
  const response = await fetch(`${base}/assurance/ingest`, { method: "POST", headers: { authorization: `Bearer ${credential}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ repository: process.env.GITHUB_REPOSITORY, assurance }) });
  if (!response.ok) process.stdout.write(`::notice::Tinkerbot hosted evidence submission was rejected (HTTP ${response.status}).\n`);
}

function renderActionMarkdown(report: ActionReport): string {
  const tests = report.testIntegrity;
  const mutation = tests?.mutation;
  const evidence = report.evidence;
  const lines = [
    MARKER,
    `## Tinkerbot Verify — ${report.verdict}`,
    "",
    `- Score / verdict: **${oneLine(report.verdict)}**`,
    `- Tests: ${String(tests?.newTests ?? 0)} new · ${String(tests?.modifiedTests ?? 0)} modified · ${String(tests?.testsPassingOnBase ?? 0)} passing on base`,
    `- Contracts: ${String(report.contracts?.changes?.length ?? 0)} change(s)`,
    `- Impact: ${String(report.summary.changedSymbols ?? 0)} symbols · ${String(report.summary.impactedPathsExecuted ?? 0)}/${String(report.summary.impactedPathsTotal ?? 0)} paths executed`,
    `- Coverage: ${tests?.coverage?.percentage === null || tests?.coverage?.percentage === undefined ? "UNKNOWN" : `${tests.coverage.percentage}%`}`,
    `- Mutation: ${mutation ? `${String(mutation.killed ?? 0)}/${String(mutation.results?.length ?? 0)} killed` : "NOT_APPLICABLE"}`,
    `- Policy: ${oneLine(report.policy?.pack ?? "default")} · unknowns ${oneLine(report.policy?.unknownHandling ?? "advisory")}`,
    `- Baseline: ${report.baseline?.stale ? "STALE" : `${String(report.baseline?.newCount ?? 0)} new · ${String(report.baseline?.waivedCount ?? 0)} waived`}`,
    `- Evidence: ${oneLine(evidence?.verdict ?? "UNKNOWN")} · receipt ${oneLine(evidence?.receiptId ?? "not generated")} · stale ${String(evidence?.staleStates?.length ?? 0)} · unknown ${String(evidence?.unknownStates?.length ?? 0)}`,
    "",
    "### Findings",
  ];
  if (!report.findings.length) lines.push("No findings.");
  for (const finding of report.findings.slice(0, 20)) lines.push(`- **${oneLine(finding.severity ?? "info")}** ${finding.file ? `\`${oneLine(`${finding.file}:${finding.startLine ?? finding.line ?? 1}`)}\`` : "repository"} — ${oneLine(finding.message ?? "Deterministic finding.")}`);
  lines.push("", "Generated by Tinkerbot Verify on the customer-controlled runner. Source code and full diffs are not uploaded by default.");
  return `${lines.join("\n")}\n`;
}

async function publish(reportFile: string, markdownFile: string, evidenceContractFile: string): Promise<void> {
  if (!fs.existsSync(reportFile)) return;
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as ActionReport;
  if (fs.existsSync(evidenceContractFile)) {
    try { report.evidence = JSON.parse(fs.readFileSync(evidenceContractFile, "utf8")) as ActionReport["evidence"]; } catch { /* keep explicit UNKNOWN fallback */ }
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const eventNumber = eventPullRequestNumber();
  const event = pullRequestEvent();
  const fork = event ? isForkPullRequest(event) : false;
  const summary = `Tinkerbot Verify verdict: ${report.verdict}. Changed symbols: ${String(report.summary.changedSymbols ?? 0)}. Unverified paths: ${String(report.summary.unverifiedPaths ?? 0)}. Receipt: ${report.evidence?.receiptId ?? "not generated"}.`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, fs.readFileSync(markdownFile, "utf8"));
  for (const annotation of mapCheckAnnotations(report.findings, 50)) {
    const pathValue = normalizeAnnotationPath(annotation.path);
    if (!pathValue) continue;
    const command = annotation.annotation_level === "failure" ? "error" : annotation.annotation_level === "warning" ? "warning" : "notice";
    process.stdout.write(`::${command} file=${escapeWorkflowCommand(pathValue)},line=${annotation.start_line},endLine=${annotation.end_line}::${escapeWorkflowCommand(oneLine(annotation.message))}\n`);
  }
  if (!repository) return;
  const token = process.env.GITHUB_TOKEN || input("token");
  if (!token) return;
  if (fork) {
    process.stdout.write("::notice::Tinkerbot Verify is running for a fork pull request; GitHub writes are disabled and local artifacts remain authoritative.\n");
    return;
  }
  if (input("check-run", input("check_run", "true")) === "true" && canPublish("check", { checks: "write" })) {
    const existingResponse = await githubRequest(`/repos/${repository}/commits/${report.head}/check-runs?check_name=${encodeURIComponent(TINKERBOT_CHECK_NAME)}`, { method: "GET" });
    const legacyResponse = existingResponse.status === 200 ? existingResponse : await githubRequest(`/repos/${repository}/commits/${report.head}/check-runs?check_name=${encodeURIComponent(LEGACY_CHECK_NAMES[0])}`, { method: "GET" });
    const existing = ((existingResponse.body as { check_runs?: Array<{ id?: number }> } | undefined)?.check_runs?.[0]) ?? ((legacyResponse.body as { check_runs?: Array<{ id?: number }> } | undefined)?.check_runs?.[0]);
    const checkEndpoint = existing?.id ? `/repos/${repository}/check-runs/${existing.id}` : `/repos/${repository}/check-runs`;
    const check = await githubRequest(checkEndpoint, { method: existing?.id ? "PATCH" : "POST", body: JSON.stringify({ name: TINKERBOT_CHECK_NAME, head_sha: report.head, status: "completed", conclusion: checkConclusion(report.verdict), output: { title: `${TINKERBOT_CHECK_NAME}: ${report.verdict}`, summary, text: fs.readFileSync(markdownFile, "utf8").slice(0, 60_000), annotations: mapCheckAnnotations(report.findings) } }) });
    if (check.status >= 400 || check.status === 0) process.stdout.write(`::notice::Tinkerbot Verify could not create or update its Check Run (HTTP ${check.status || "unavailable"}); local report remains available.\n`);
  }
  if (input("comment", input("sticky_comment", "true")) === "true" && eventNumber && canPublish("comment", { issues: "write" })) {
    const comments = await githubRequest(`/repos/${repository}/issues/${eventNumber}/comments?per_page=100`, { method: "GET" });
    const existing = Array.isArray(comments.body) ? (comments.body as Array<{ id?: number; body?: string }>).find((comment) => hasLegacyCommentMarker(comment.body)) : undefined;
    const body = fs.readFileSync(markdownFile, "utf8").slice(0, 60_000);
    const endpoint = existing?.id ? `/repos/${repository}/issues/comments/${existing.id}` : `/repos/${repository}/issues/${eventNumber}/comments`;
    const result = await githubRequest(endpoint, { method: existing?.id ? "PATCH" : "POST", body: JSON.stringify({ body }) });
    if (result.status >= 400 || result.status === 0) process.stdout.write(`::notice::Tinkerbot Verify could not update its sticky comment (HTTP ${result.status || "unavailable"}); local report remains available.\n`);
  }
}

export async function main(): Promise<void> {
  let result: ReturnType<typeof runCli>;
  try {
    result = runCli();
  } catch (error) {
    process.stdout.write(`::error::Tinkerbot Verify Action could not create a local report: ${escapeWorkflowCommand(oneLine(error instanceof Error ? error.message : String(error)))}\n`);
    process.exitCode = 4;
    return;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "report=.pr-proof/report.json\nsarif=.pr-proof/report.sarif\nusage=.pr-proof/usage.json\nreceipt=.pr-proof/receipt.json\nreview-context=.pr-proof/review-context.json\nevidence-contract=.pr-proof/evidence-contract.json\nassurance-bundle=.pr-proof/assurance-bundle.json\n");
  try { await submitHostedEvidence(result); }
  catch (error) { process.stdout.write(`::notice::Tinkerbot hosted evidence submission was unavailable. ${escapeWorkflowCommand(oneLine(error instanceof Error ? error.message : String(error)))}\n`); }
  try {
    await publish(result.reportFile, result.markdownFile, result.evidenceContractFile);
  } catch (error) {
    process.stdout.write(`::notice::Tinkerbot Verify GitHub integration was unavailable; the local report remains available. ${escapeWorkflowCommand(oneLine(error instanceof Error ? error.message : String(error)))}\n`);
  }
  if (result.status !== 0) process.exitCode = result.status;
}

export function startAction(): void {
  void main().catch((error) => {
    process.stdout.write(`::error::Tinkerbot Verify Action failed before producing a result: ${escapeWorkflowCommand(oneLine(error instanceof Error ? error.message : String(error)))}\n`);
    process.exitCode = 4;
  });
}
