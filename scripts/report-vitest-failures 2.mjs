#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const resultFile = process.argv[2] ?? "vitest-results.json";
if (!fs.existsSync(resultFile)) process.exit(0);

function escapeCommand(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function relativeName(name) {
  const relative = path.relative(process.cwd(), name || "vitest");
  return (relative || name || "vitest").split(path.sep).join("/");
}

let report;
try {
  report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
} catch (error) {
  process.stdout.write(`::warning title=Vitest diagnostics::${escapeCommand(`Could not parse ${resultFile}: ${error instanceof Error ? error.message : String(error)}`)}\n`);
  process.exit(0);
}

const failures = [];
for (const suite of report.testResults ?? []) {
  for (const assertion of suite.assertionResults ?? []) {
    if (assertion.status !== "failed") continue;
    const detail = (assertion.failureMessages ?? []).join("\n").slice(0, 4_000) || "Assertion failed.";
    failures.push({ file: relativeName(suite.name), title: assertion.fullName || assertion.title || "Vitest assertion", detail });
  }
  if (suite.status === "failed" && !(suite.assertionResults ?? []).some((assertion) => assertion.status === "failed")) {
    failures.push({ file: relativeName(suite.name), title: "Vitest suite", detail: suite.message || "Test suite failed before reporting an assertion." });
  }
}

for (const failure of failures) {
  process.stdout.write(`::error file=${escapeCommand(failure.file)},title=${escapeCommand(failure.title)}::${escapeCommand(failure.detail)}\n`);
}

if (!failures.length && report.success !== false) {
  try { fs.rmSync(resultFile, { force: true }); } catch { /* diagnostics cleanup is best effort */ }
}
