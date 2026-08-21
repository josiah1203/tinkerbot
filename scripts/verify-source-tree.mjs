import { execFileSync } from "node:child_process";
import fs from "node:fs";

const root = process.cwd();
const ignoredPrefixes = ["docs/repo-hygiene/quarantine/"];
const gitignore = fs.readFileSync(".gitignore", "utf8");
const gitignoreRules = gitignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
const duplicateGitignoreRules = gitignoreRules.filter((rule, index) => gitignoreRules.indexOf(rule) !== index);
if (duplicateGitignoreRules.length) throw new Error(`duplicate .gitignore rules found:\n${[...new Set(duplicateGitignoreRules)].sort().join("\n")}`);
const requiredGitignoreRules = [".tinkerbot/cache/", ".tinkerbot/runs/", ".tinkerbot/receipts/", ".tinkerbot/artifacts/", ".tinkerbot/worktrees/", ".worktrees/"];
const missingGitignoreRules = requiredGitignoreRules.filter((rule) => !gitignoreRules.includes(rule));
if (missingGitignoreRules.length) throw new Error(`managed-worktree/generated-state .gitignore policy is incomplete:\n${missingGitignoreRules.join("\n")}`);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
const untracked = status.split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3));
// The verifier is also used during a local cleanup where tracked duplicate
// paths may already be removed from the working tree but cannot yet be staged
// by a managed checkout. Inspect files that actually exist on disk; CI still
// sees the complete tracked checkout.
const files = [...tracked.filter((file) => fs.existsSync(file)), ...untracked.filter((file) => !tracked.includes(file) && fs.existsSync(file))];
const numericSuffix = / \d+(?=\.[^.]+$|$)/;
const active = (file) => !ignoredPrefixes.some((prefix) => file.startsWith(prefix));
const duplicates = files.filter((file) => active(file) && file.split("/").some((part) => numericSuffix.test(part)));

if (duplicates.length) {
  throw new Error(`duplicate-looking source paths found:\n${duplicates.sort().join("\n")}`);
}

const semantic = new Map();
for (const file of files.filter(active)) {
  const key = file.split("/").map((part) => part.replace(numericSuffix, "")).join("/");
  const prior = semantic.get(key);
  if (prior && prior !== file) throw new Error(`duplicate semantic source path: ${prior} and ${file}`);
  semantic.set(key, file);
}

console.log(JSON.stringify({ tracked: tracked.length, untracked: untracked.length, activeFiles: files.filter(active).length, quarantineIgnored: files.length - files.filter(active).length, gitignoreRules: gitignoreRules.length }));
