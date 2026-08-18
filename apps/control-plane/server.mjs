import { createServer } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function within(candidate) {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value));
}

function fileFor(url) {
  let requestPath;
  try { requestPath = decodeURIComponent((url ?? "/").split("?")[0] ?? "/"); } catch { return null; }
  if (requestPath.includes("\0")) return null;
  const requested = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const lexical = resolve(root, requested);
  if (!within(lexical)) return null;
  let file = lexical;
  try {
    if (existsSync(lexical)) file = realpathSync(lexical);
    if (!within(file) || (existsSync(file) && statSync(file).isDirectory())) return null;
  } catch { return null; }
  if (existsSync(file)) return file;
  return extname(lexical) ? null : join(root, "index.html");
}

createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed\n");
    return;
  }
  const file = fileFor(request.url);
  if (!file) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request\n");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}).listen(port, host, () => {
  console.log(`pr-proof control plane preview: http://${host}:${port}/sign-in`);
});
