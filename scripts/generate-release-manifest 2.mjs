import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const directory = "dist/release";
if (!existsSync(directory)) throw new Error("No release directory found. Run pnpm release:clients first.");

const artifacts = readdirSync(directory)
  .filter((name) => name.startsWith(`tinkerbot-${version}-`) && name.endsWith(".tar.gz"))
  .sort()
  .map((name) => {
    const target = name.slice(`tinkerbot-${version}-`.length, -".tar.gz".length);
    const file = join(directory, name);
    return {
      target,
      file: name,
      bytes: statSync(file).size,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    };
  });

if (artifacts.length === 0) throw new Error("No release archives found. Run pnpm release:clients first.");
const generatedAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();
const manifest = {
  schemaVersion: 1,
  name: "tinkerbot",
  version,
  generatedAt,
  integrity: { algorithm: "sha256", signed: false },
  artifacts,
};
writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${directory}/manifest.json for ${artifacts.length} artifact(s).`);
