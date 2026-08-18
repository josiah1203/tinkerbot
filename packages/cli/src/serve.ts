import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveRepositoryPath } from "../../core/src/safety";

export interface ServeOptions {
  port?: number;
  host?: string;
  directory?: string;
}

function controlPlaneCandidates(): string[] {
  const moduleDirectory = __dirname;
  return [
    path.resolve(process.cwd(), "apps/control-plane"),
    path.resolve(moduleDirectory, "../../../apps/control-plane"),
    path.resolve(moduleDirectory, "../../../../apps/control-plane"),
  ];
}

export function resolveControlPlaneDirectory(directory?: string): string {
  const candidates = directory ? [path.resolve(directory)] : controlPlaneCandidates();
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")) && fs.existsSync(path.join(candidate, "app.js")));
  if (!found) throw new Error("Could not locate the pr-proof control-plane files. Run this command from the pr-proof repository or provide --directory.");
  return found;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function safeControlPlaneFilePath(root: string, requestPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/"); }
  catch { return null; }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  try { return resolveRepositoryPath(root, relative); } catch { return null; }
}

export function createControlPlaneServer(options: ServeOptions = {}): http.Server {
  const root = resolveControlPlaneDirectory(options.directory);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Control-plane port must be an integer between 0 and 65535.");
  return http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }
    const requestPath = request.url ?? "/";
    const target = safeControlPlaneFilePath(root, requestPath);
    if (!target) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Bad request\n");
      return;
    }

    let file = target;
    try {
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // The control plane is an intentionally small SPA; unknown document routes
      // resolve to index.html while assets remain strict file lookups.
      if (path.extname(file)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      file = path.join(root, "index.html");
      }
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "content-type": contentType(file),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    if (request.method === "HEAD") { response.end(); return; }
    fs.createReadStream(file).on("error", () => response.destroy()).pipe(response);
  });
}

export function runControlPlaneServer(options: ServeOptions = {}): number {
  const server = createControlPlaneServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  server.listen(port, host, () => {
    process.stdout.write(`PR Proof local control plane: http://${host}:${port}/\n`);
    process.stdout.write("Local report viewing does not require hosted authentication.\n");
  });
  return 0;
}
