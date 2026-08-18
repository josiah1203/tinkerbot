#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const entry = path.join(__dirname, "..", "dist", "action", "index.js");
if (!fs.existsSync(entry)) {
  console.error("Tinkerbot Verify Action: compiled release artifact is missing. Build the release with pnpm build before using this Action.");
  process.exitCode = 4;
} else {
  require(entry);
}
