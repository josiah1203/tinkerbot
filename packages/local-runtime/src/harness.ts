import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FactoryHarnessDefinition } from "../../factory/src";
import { resolveCredentialRef } from "./credentials";

export interface ExternalHarnessResult {
  harnessId: string;
  status: "ok" | "failed";
  exitCode: number;
  summary: string;
  stdout: string;
  stderr: string;
  requestDigest: string;
}

export interface ExternalHarnessInput {
  harness: FactoryHarnessDefinition;
  worktree: string;
  /** Path visible to the harness. Docker cells use `/work`; local processes use the host path. */
  executionWorktree?: string;
  repository: string;
  workOrderId: string;
  prompt: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Whether the selected sandbox can actually enforce network=none. Host-process runners cannot. */
  networkIsolation?: boolean;
  exec: (argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number; stdin?: string; network?: "none" | "egress" }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const SECRET_PATTERNS = [
  /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|(?:xai|pplx)-[A-Za-z0-9_-]{8,})/gi,
  /((?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|signing[_-]?secret|webhook[_-]?secret)\s*[:=]\s*)\S+/gi,
];

function redact(value: string, secrets: string[] = [], limit = 8_000): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, (match, prefix?: string) => prefix ? `${prefix}[redacted]` : "[redacted]");
  for (const secret of secrets.filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), "[redacted]");
  }
  return result.slice(0, limit);
}

function interpolate(value: string, replacements: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key: string) => Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key]! : match);
}

function requestPayload(input: ExternalHarnessInput): Record<string, unknown> {
  const executionWorktree = input.executionWorktree ?? input.worktree;
  const model = input.model ? redact(input.model, [], 256) : undefined;
  return {
    protocolVersion: 1,
    harness: input.harness.id,
    repository: input.repository,
    workOrderId: input.workOrderId,
    worktree: executionWorktree,
    model,
    prompt: redact(input.prompt, [], 16_000),
    authority: { mayMerge: false, mayRelease: false, mayWriteVerificationVerdict: false },
  };
}

export async function runExternalHarness(input: ExternalHarnessInput): Promise<ExternalHarnessResult> {
  if (input.networkIsolation === false && (input.harness.network ?? "none") === "none") {
    throw new Error("The process runner cannot enforce network=none; use Docker or explicitly set harness network: egress.");
  }
  const payload = requestPayload(input);
  const safeModel = typeof payload.model === "string" ? payload.model : "";
  const serialized = JSON.stringify(payload);
  const requestDigest = `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
  const requestFile = path.join(input.worktree, `.tinkerbot-harness-request-${crypto.randomUUID()}.json`);
  const executionWorktree = input.executionWorktree ?? input.worktree;
  const requestFileForExecution = executionWorktree === input.worktree
    ? requestFile
    : `${executionWorktree.replace(/\/$/, "")}/${path.basename(requestFile)}`;
  fs.writeFileSync(requestFile, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    const replacements = {
      requestFile: requestFileForExecution,
      worktree: executionWorktree,
      repository: input.repository,
      workOrderId: input.workOrderId,
      model: safeModel,
    };
    const argv = [input.harness.command, ...input.harness.args.map((arg) => interpolate(arg, replacements))];
    const env: Record<string, string> = {};
    for (const [name, ref] of Object.entries(input.harness.env)) {
      const value = resolveCredentialRef(ref, input.env ?? process.env);
      if (!value) throw new Error(`Harness credential '${name}' did not resolve.`);
      env[name] = value;
    }
    // Both protocol modes receive the same redacted prompt; text-mode must not
    // bypass the JSON envelope's credential scrubber.
    const stdin = input.harness.protocol === "text" ? String(payload.prompt ?? "") : serialized;
    const requestedTimeout = input.timeoutMs ?? input.harness.timeoutSeconds * 1_000;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1) throw new Error("External harness timeout must be positive.");
    const result = await input.exec(argv, { env, stdin, network: input.harness.network ?? "none", timeoutMs: Math.min(requestedTimeout, input.harness.timeoutSeconds * 1_000) });
    const resolvedSecrets = Object.values(env);
    const stdout = redact(result.stdout, resolvedSecrets);
    const stderr = redact(result.stderr, resolvedSecrets);
    const summary = stdout.trim() || stderr.trim() || (result.exitCode === 0 ? "External harness completed without output." : "External harness failed without output.");
    return { harnessId: input.harness.id, status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode, summary, stdout, stderr, requestDigest };
  } finally {
    try { fs.rmSync(requestFile, { force: true }); } catch { /* cleanup is best effort */ }
  }
}
