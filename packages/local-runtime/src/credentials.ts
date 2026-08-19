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
  const result = spawnSync("security", ["find-generic-password", "-s", service ?? "tinkerbot", "-a", account ?? "default", "-w"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function assertNoSecretInPayload(value: unknown): void {
  const text = JSON.stringify(value);
  if (/(sk-[A-Za-z0-9]{8,}|gh[ps]_|sk_live_|sk_test_|whsec_|keychain:\/\/[^\"]+\s+[A-Za-z0-9]{12,})/.test(text)) {
    throw new Error("Secrets must not appear in receipts, plans, or local state payloads.");
  }
}
