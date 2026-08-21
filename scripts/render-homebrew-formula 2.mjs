import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const baseUrl = process.env.TINKERBOT_RELEASE_BASE_URL?.replace(/\/$/, "");
if (!baseUrl?.startsWith("https://")) throw new Error("Set TINKERBOT_RELEASE_BASE_URL to the approved HTTPS release directory.");
const manifest = JSON.parse(readFileSync("dist/release/manifest.json", "utf8"));
const select = (target) => manifest.artifacts.find((artifact) => artifact.target === target);
const arm = select("darwin-arm64");
const intel = select("darwin-x64");
if (!arm || !intel) throw new Error("Homebrew requires darwin-arm64 and darwin-x64 archives in dist/release/manifest.json.");
const formula = `class Tinkerbot < Formula\n  desc "Hosted Tinkerbot change-assurance terminal client"\n  homepage "${baseUrl}"\n  version "${manifest.version}"\n\n  on_arm do\n    url "${baseUrl}/${arm.file}"\n    sha256 "${arm.sha256}"\n  end\n\n  on_intel do\n    url "${baseUrl}/${intel.file}"\n    sha256 "${intel.sha256}"\n  end\n\n  def install\n    bin.install Hardware::CPU.arm? ? "tb" : "tb"\n  end\n\n  test do\n    assert_match "Tinkerbot", shell_output("#{bin}/tb --help")\n  end\nend\n`;
const output = resolve(process.env.TINKERBOT_HOMEBREW_FORMULA ?? "dist/release/tinkerbot.rb");
writeFileSync(output, formula);
console.log(`Rendered ${output}`);
