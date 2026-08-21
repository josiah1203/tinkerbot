import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const releaseDirectory = "dist/release";
mkdirSync(releaseDirectory, { recursive: true });

const staging = join(releaseDirectory, ".stage-node");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const copied = spawnSync("cp", ["-R", "dist/packages", join(staging, "packages")], { stdio: "inherit" });
if (copied.status !== 0) process.exit(copied.status ?? 1);
writeFileSync(join(staging, "tb.cjs"), "#!/usr/bin/env node\nrequire(\"./packages/cli/src/index.js\");\n");
const archive = join(releaseDirectory, `tinkerbot-${version}-node.tar.gz`);
const packed = spawnSync("tar", ["-C", staging, "-czf", archive, "packages", "tb.cjs"], { stdio: "inherit" });
rmSync(staging, { recursive: true, force: true });
if (packed.status !== 0) process.exit(packed.status ?? 1);

const archives = readdirSync(releaseDirectory)
  .filter((name) => name.startsWith(`tinkerbot-${version}-`) && name.endsWith(".tar.gz"))
  .sort()
  .map((name) => ({ name, bytes: statSync(join(releaseDirectory, name)).size, sha256: createHash("sha256").update(readFileSync(join(releaseDirectory, name))).digest("hex") }));
if (!existsSync(archive)) throw new Error("Node CLI archive was not created.");
writeFileSync(join(releaseDirectory, "artifacts.json"), `${JSON.stringify({ version, artifacts: archives, signed: false }, null, 2)}\n`);
console.log(`Packaged ${archive}`);
