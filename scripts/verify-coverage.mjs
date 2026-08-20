import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryFile = path.join(root, "coverage", "coverage-summary.json");
const baselineFile = path.join(root, "fixtures", "coverage-baseline.json");
if (!fs.existsSync(summaryFile)) {
  console.error("Coverage summary is unavailable. Run `pnpm test:coverage` before running this gate.");
  process.exit(2);
}
if (!fs.existsSync(baselineFile)) {
  console.error("Coverage baseline is unavailable. Restore fixtures/coverage-baseline.json before running this gate.");
  process.exit(2);
}

let summary;
try {
  summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
} catch (error) {
  console.error(`Coverage summary is malformed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  if (baseline?.schemaVersion !== 1 || !baseline.packages || typeof baseline.tolerancePercentagePoints !== "number") throw new Error("coverage baseline schema is invalid");
} catch (error) {
  console.error(`Coverage baseline is malformed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const longTermTargets = {
  critical: { statements: 90, branches: 85, functions: 90, lines: 90, packages: ["core", "git", "cli", "reporters"] },
  high: { statements: 85, branches: 80, functions: 85, lines: 85, packages: ["parser", "test-integrity", "coverage", "mutation", "impact-analysis", "factory"] },
  medium: { statements: 85, branches: 80, functions: 85, lines: 85, packages: ["baseline", "policy", "artifacts", "provenance", "selection", "history", "contracts", "fixtures", "control-plane", "assurance", "github", "hosted-integrations", "language-core", "language-validation"] },
};

function metric(entry, name) {
  const value = entry?.[name];
  return value && typeof value.total === "number" && typeof value.covered === "number" ? value : { total: 0, covered: 0, pct: 100 };
}

function aggregate(entries) {
  const result = {};
  for (const name of ["statements", "branches", "functions", "lines"]) {
    const values = entries.map((entry) => metric(entry, name));
    const total = values.reduce((sum, value) => sum + value.total, 0);
    const covered = values.reduce((sum, value) => sum + value.covered, 0);
    result[name] = { total, covered, pct: total ? covered / total * 100 : 100 };
  }
  return result;
}

const fileEntries = Object.entries(summary).filter(([key, value]) => key !== "total" && value && typeof value === "object");
const failures = [];
const longTermWarnings = [];
for (const [tier, target] of Object.entries(longTermTargets)) {
  for (const packageName of target.packages) {
    const entries = fileEntries.filter(([file]) => file.replaceAll("\\", "/").includes(`/packages/${packageName}/src/`));
    if (!entries.length) {
      failures.push(`${packageName}: no coverage records`);
      continue;
    }
    const values = aggregate(entries.map(([, value]) => value));
    const packageBaseline = baseline.packages[packageName];
    if (!packageBaseline) {
      failures.push(`${packageName}: no checked-in coverage baseline`);
      continue;
    }
    const belowBaseline = [];
    const belowLongTerm = [];
    for (const name of ["statements", "branches", "functions", "lines"]) {
      if (typeof packageBaseline[name] !== "number") {
        failures.push(`${packageName}: baseline is missing ${name}`);
        continue;
      }
      if (values[name].pct < packageBaseline[name] - baseline.tolerancePercentagePoints) belowBaseline.push(`${name} ${values[name].pct.toFixed(1)}% < baseline ${packageBaseline[name].toFixed(1)}%`);
      if (values[name].pct < target[name]) belowLongTerm.push(`${name} ${values[name].pct.toFixed(1)}% < ${target[name]}%`);
    }
    if (belowBaseline.length) failures.push(`${packageName} coverage regressed: ${belowBaseline.join(", ")}`);
    if (belowLongTerm.length) longTermWarnings.push(`${packageName} (${tier}): ${belowLongTerm.join(", ")}`);
    console.log(`${packageName}: statements ${values.statements.pct.toFixed(1)}%, branches ${values.branches.pct.toFixed(1)}%, functions ${values.functions.pct.toFixed(1)}%, lines ${values.lines.pct.toFixed(1)}%`);
  }
}

if (failures.length) {
  console.error("Coverage ratchet failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
if (longTermWarnings.length) {
  console.warn("Long-term coverage targets remain open:");
  for (const warning of longTermWarnings) console.warn(`- ${warning}`);
}
console.log(`Coverage ratchet passed against ${baselineFile} (tolerance ${baseline.tolerancePercentagePoints} percentage points).`);
