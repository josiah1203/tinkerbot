import fs from "node:fs";
import path from "node:path";
import { buildFactoryStarter } from "./starter";

export function inspectRepository(root: string): {
  languages: string[];
  packageManagers: string[];
  testCommands: string[];
  hasGithubActions: boolean;
  defaultBranchHint: string;
} {
  const languages: string[] = [];
  const packageManagers: string[] = [];
  const testCommands: string[] = [];
  if (fs.existsSync(path.join(root, "package.json"))) {
    languages.push("javascript");
    packageManagers.push("npm");
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) testCommands.push(pkg.scripts.test);
    } catch { /* ignore malformed package.json */ }
  }
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) && !packageManagers.includes("pnpm")) packageManagers.push("pnpm");
  if (fs.existsSync(path.join(root, "tsconfig.json")) && !languages.includes("typescript")) languages.push("typescript");
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt"))) {
    languages.push("python");
    packageManagers.push("pip");
    testCommands.push("pytest");
  }
  if (fs.existsSync(path.join(root, "go.mod"))) {
    languages.push("go");
    testCommands.push("go test ./...");
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) languages.push("rust");
  const hasGithubActions = fs.existsSync(path.join(root, ".github", "workflows"));
  return { languages, packageManagers, testCommands: [...new Set(testCommands)], hasGithubActions, defaultBranchHint: "main" };
}

export function initFactoryTree(root: string, name?: string): { files: Array<{ path: string; contents: string }>; inspect: ReturnType<typeof inspectRepository> } {
  const inspect = inspectRepository(root);
  const repo = path.basename(root);
  const starter = buildFactoryStarter({ name: name?.trim() || repo, owner: "owner", repository: repo, harness: "tinkerbot-sandbox" });
  const extra = [
    { path: ".tinkerbot/autonomy.yaml", contents: "defaultMode: approval_gated\nneverMerge: true\nrules:\n  - match: path\n    pattern: \"(^|/)(auth|billing)(/|\\\\.|$)\"\n    mode: restricted\n" },
    { path: ".tinkerbot/lines/feature.yaml", contents: "id: feature\nstages: [foreman, triage, specification, implementation, review, verification, release]\nautonomy: approval_gated\nrequiredEvidence: [verification-receipt]\n" },
    { path: ".tinkerbot/lines/bugfix.yaml", contents: "id: bugfix\nstages: [foreman, triage, implementation, review, verification, release]\nautonomy: assisted\nrequiredEvidence: [verification-receipt]\n" },
    { path: ".tinkerbot/lines/security.yaml", contents: "id: security\nstages: [foreman, triage, specification, security, implementation, review, verification, release]\nautonomy: restricted\nrequiredEvidence: [verification-receipt, security]\n" },
    { path: ".tinkerbot/lines/release.yaml", contents: "id: release\nstages: [foreman, verification, release]\nautonomy: restricted\nrequiredEvidence: [verification-receipt]\n" },
    { path: ".tinkerbot/lines/maintenance.yaml", contents: "id: maintenance\nstages: [foreman, triage, implementation, verification, release]\nautonomy: assisted\nrequiredEvidence: [verification-receipt]\n" },
  ];
  return { files: [...starter.files, ...extra], inspect };
}
