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
  repository: string;
  workOrderId: string;
  prompt: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec: (argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number; stdin?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const SECRET_PATTERNS = [
  /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh[ps]_[A-Za-z0-9_]{8,}|whsec_[A-Za-z0-9_]{8,})/g,
  /((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
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
  return {
    protocolVersion: 1,
    harness: input.harness.id,
    repository: input.repository,
    workOrderId: input.workOrderId,
    worktree: input.worktree,
    model: input.model,
    prompt: redact(input.prompt, [], 16_000),
    authority: { mayMerge: false, mayRelease: false, mayWriteVerificationVerdict: false },
  };
}

export async function runExternalHarness(input: ExternalHarnessInput): Promise<ExternalHarnessResult> {
  const payload = requestPayload(input);
  const serialized = JSON.stringify(payload);
  const requestDigest = `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
  const requestFile = path.join(input.worktree, `.tinkerbot-harness-request-${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestFile, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    const replacements = {
      requestFile,
      worktree: input.worktree,
      repository: input.repository,
      workOrderId: input.workOrderId,
      model: input.model ?? "",
    };
    const argv = [input.harness.command, ...input.harness.args.map((arg) => interpolate(arg, replacements))];
    const env: Record<string, string> = {};
    for (const [name, ref] of Object.entries(input.harness.env)) {
      const value = resolveCredentialRef(ref, input.env ?? process.env);
      if (!value) throw new Error(`Harness credential '${name}' did not resolve.`);
      env[name] = value;
    }
    const stdin = input.harness.protocol === "text" ? input.prompt.slice(0, 16_000) : serialized;
    const result = await input.exec(argv, { env, stdin, timeoutMs: Math.min(input.timeoutMs ?? input.harness.timeoutSeconds * 1_000, input.harness.timeoutSeconds * 1_000) });
    const resolvedSecrets = Object.values(env);
    const stdout = redact(result.stdout, resolvedSecrets);
    const stderr = redact(result.stderr, resolvedSecrets);
    const summary = stdout.trim() || stderr.trim() || (result.exitCode === 0 ? "External harness completed without output." : "External harness failed without output.");
    return { harnessId: input.harness.id, status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode, summary, stdout, stderr, requestDigest };
  } finally {
    try { fs.rmSync(requestFile, { force: true }); } catch { /* cleanup is best effort */ }
  }
}
