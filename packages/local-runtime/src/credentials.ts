import { spawnSync } from "node:child_process";
import { CREDENTIAL_REF_PATTERN } from "../../factory/src/runtime";

export function resolveCredentialRef(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!ref) return undefined;
  if (!CREDENTIAL_REF_PATTERN.test(ref)) throw new Error("credentialRef must be env:VAR or keychain://…");
  if (ref.startsWith("env:")) {
    const value = env[ref.slice(4)];
    return value && value.length ? value : undefined;
  }
  const rest = ref.slice("keychain://".length);
  const [service, account] = rest.split("/");
  const result = spawnSync("security", ["find-generic-password", "-s", service ?? "tinkerbot", "-a", account ?? "default", "-w"], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function assertNoSecretInPayload(value: unknown): void {
  const text = JSON.stringify(value);
  const tokenOrLabeledSecret = /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|(?:xai|pplx)-[A-Za-z0-9_-]{8,}|(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|signing[_-]?secret|webhook[_-]?secret)["']*\s*[:=]\s*["']*(?!env:|keychain:\/\/|secret:\/\/)[^\s,}\"']+|keychain:\/\/[^\"]+\s+[A-Za-z0-9]{12,})/i;
  if (tokenOrLabeledSecret.test(text)) {
    throw new Error("Secrets must not appear in receipts, plans, or local state payloads.");
  }
}
