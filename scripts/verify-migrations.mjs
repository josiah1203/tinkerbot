import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const directory = path.join(root, "apps/control-plane-worker/migrations");
const filePattern = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

if (!fs.existsSync(directory)) {
  throw new Error(`migration directory missing: ${path.relative(root, directory)}`);
}

const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
const versions = new Map();
const invalid = [];

for (const file of files) {
  const match = file.match(filePattern);
  if (!match) {
    invalid.push(file);
    continue;
  }
  const version = Number(match[1]);
  const prior = versions.get(version);
  if (prior) throw new Error(`duplicate migration version ${match[1]}: ${prior} and ${file}`);
  versions.set(version, file);
}

if (invalid.length) {
  throw new Error(`non-canonical migration filename(s):\n${invalid.join("\n")}`);
}

console.log(JSON.stringify({
  directory: path.relative(root, directory),
  files: files.length,
  first: files[0] ?? null,
  last: files.at(-1) ?? null,
  versions: [...versions.keys()].sort((left, right) => left - right),
}));
