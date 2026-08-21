import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(process.argv[2] ?? process.cwd());
const base = path.join(root, ".tinkerbot");
if (!fs.existsSync(base)) {
  console.error("factory tree missing: .tinkerbot");
  process.exit(1);
}

const files = [];
function walk(directory, relative = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`factory tree symlink: .tinkerbot/${rel}`);
    if (entry.isDirectory()) walk(full, rel);
    else files.push({ path: `.tinkerbot/${rel.replaceAll(path.sep, "/")}`, contents: fs.readFileSync(full, "utf8") });
  }
}
walk(base);

const exact = new Set();
const semantic = new Map();
for (const file of files) {
  if (exact.has(file.path)) throw new Error(`duplicate factory path: ${file.path}`);
  exact.add(file.path);
  const key = file.path.split("/").map((part) => part.replace(/ \d+(?=\.[^.]+$|$)/g, "")).join("/");
  const prior = semantic.get(key);
  if (prior && prior !== file.path) throw new Error(`duplicate semantic factory path: ${prior} and ${file.path}`);
  semantic.set(key, file.path);
}

const tracked = new Set(execFileSync("git", ["ls-files", "--cached", "--", ".tinkerbot"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean));
for (const file of exact) if (!tracked.has(file)) throw new Error(`untracked factory tree file: ${file}`);

const canonical = files.sort((left, right) => left.path.localeCompare(right.path)).map((file) => `${file.path}\n${file.contents}`).join("\n---\n");
const digest = `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
const expected = process.env.FACTORY_TREE_DIGEST;
if (expected && expected !== digest) throw new Error(`factory tree digest drift: expected ${expected}, got ${digest}`);
console.log(JSON.stringify({ root, files: files.length, digest, tracked: true }));
