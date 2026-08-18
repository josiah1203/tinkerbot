import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const binaryDirectory = "dist/tui";
const releaseDirectory = "dist/release";

if (!existsSync(binaryDirectory)) throw new Error("No compiled clients found. Run pnpm tui:compile:release first.");
mkdirSync(releaseDirectory, { recursive: true });

const binaries = readdirSync(binaryDirectory).filter((name) => /^tb-(darwin|linux|windows)-/.test(name));
if (binaries.length === 0) throw new Error("No platform-named Tinkerbot clients found in dist/tui.");

for (const binary of binaries) {
  const target = binary.replace(/^tb-/, "").replace(/\.exe$/, "");
  const staging = join(releaseDirectory, `.stage-${target}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const stagedBinary = target.startsWith("windows-") ? "tb.exe" : "tb";
  const copied = spawnSync("cp", [join(binaryDirectory, binary), join(staging, stagedBinary)], { stdio: "inherit" });
  if (copied.status !== 0) process.exit(copied.status ?? 1);
  const archive = join(releaseDirectory, `tinkerbot-${version}-${target}.tar.gz`);
  const packed = spawnSync("tar", ["-C", staging, "-czf", archive, stagedBinary], { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });
  if (packed.status !== 0) process.exit(packed.status ?? 1);
  console.log(`Packaged ${archive}`);
}

const archives = readdirSync(releaseDirectory)
  .filter((name) => name.startsWith(`tinkerbot-${version}-`) && name.endsWith(".tar.gz"))
  .sort()
  .map((name) => ({ name, bytes: statSync(join(releaseDirectory, name)).size, sha256: createHash("sha256").update(readFileSync(join(releaseDirectory, name))).digest("hex") }));
writeFileSync(join(releaseDirectory, "artifacts.json"), `${JSON.stringify({ version, artifacts: archives }, null, 2)}\n`);
