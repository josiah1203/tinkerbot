import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(target);
      continue;
    }
    if (entry.name.endsWith(".map") || /(?:^|\.)test\.(?:js|d\.ts)$/.test(entry.name) || / \d+\./.test(entry.name)) {
      fs.unlinkSync(target);
    }
  }
}

if (fs.existsSync(dist)) visit(dist);
