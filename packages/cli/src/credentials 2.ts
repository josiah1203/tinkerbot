import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredCredentials {
  controlPlaneUrl: string;
  sessionToken: string;
  organizationId?: string;
}

function credentialFile(): string {
  return process.env.TINKERBOT_CREDENTIAL_FILE || path.join(os.homedir(), ".tinkerbot", "credentials.json");
}

export function loadStoredCredentials(): StoredCredentials | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialFile(), "utf8")) as StoredCredentials;
    if (typeof parsed.controlPlaneUrl === "string" && typeof parsed.sessionToken === "string") return parsed;
  } catch { /* missing credentials remain an explicit unavailable state */ }
  return undefined;
}

export function saveStoredCredentials(credentials: StoredCredentials): void {
  const file = credentialFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

export function clearStoredCredentials(): void {
  try { fs.unlinkSync(credentialFile()); } catch { /* already signed out */ }
}

export function hostedSession(): { url?: string; token?: string } {
  const stored = loadStoredCredentials();
  return {
    url: process.env.TINKERBOT_CONTROL_PLANE_URL || stored?.controlPlaneUrl,
    token: process.env.TINKERBOT_SESSION_TOKEN || stored?.sessionToken,
  };
}
