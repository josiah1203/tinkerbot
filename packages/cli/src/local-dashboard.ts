import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolveControlPlaneDirectory, safeControlPlaneFilePath } from "./serve";
import { defaultLocalDbPath, localRuntimeView, SqliteFactoryStore } from "../../local-runtime/src";

export interface LocalDashboardOptions {
  root: string;
  port?: number;
  host?: string;
  directory?: string;
  listen?: boolean;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export function localDashboardApi(store: SqliteFactoryStore, url: URL, method: string): { status: number; body: unknown; type?: string } | undefined {
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: "Method not allowed\n", type: "text/plain; charset=utf-8" };
  if (url.pathname === "/auth/session") {
    return {
      status: 200,
      body: { authenticated: true, organizationId: "local", local: true, user: { id: "local-human", email: "local@tinkerbot" } },
    };
  }
  if (url.pathname === "/local/runtime" || url.pathname === "/runtime/local") {
    return { status: 200, body: localRuntimeView(store) };
  }
  if (url.pathname === "/factories") {
    return { status: 200, body: { factories: [{ factoryId: "local-factory", name: "local", status: "active" }] } };
  }
  if (url.pathname === "/work-orders") {
    return { status: 200, body: { workOrders: localRuntimeView(store).workOrders } };
  }
  if (url.pathname === "/exceptions" || url.pathname === "/local/exceptions") {
    const view = localRuntimeView(store);
    return { status: 200, body: { ...view.exceptions, kanban: false, attentionFirst: true } };
  }
  return undefined;
}

export function createLocalDashboardServer(options: LocalDashboardOptions): http.Server {
  const spaRoot = resolveControlPlaneDirectory(options.directory);
  const store = new SqliteFactoryStore(defaultLocalDbPath(options.root));
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4174;
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const api = localDashboardApi(store, url, request.method ?? "GET");
    if (api) {
      const type = api.type ?? "application/json; charset=utf-8";
      response.writeHead(api.status, { "cache-control": "no-store", "content-type": type, "access-control-allow-origin": `http://${host}:${port}` });
      if (request.method === "HEAD") { response.end(); return; }
      response.end(typeof api.body === "string" ? api.body : `${JSON.stringify(api.body)}\n`);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }
    const lookup = url.pathname.startsWith("/app") ? "/index.html" : url.pathname;
    const target = safeControlPlaneFilePath(spaRoot, lookup);
    if (!target) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Bad request\n");
      return;
    }
    let file = target;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(file)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      file = path.join(spaRoot, "index.html");
    }
    let body = fs.readFileSync(file);
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": contentType(file),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    if (file.endsWith("index.html")) {
      body = Buffer.from(body.toString("utf8").replace(
        '<meta name="tinkerbot-api-base" content="" />',
        '<meta name="tinkerbot-api-base" content="" />\n    <meta name="tinkerbot-local-adapter" content="1" />',
      ));
    }
    response.writeHead(200, headers);
    if (request.method === "HEAD") { response.end(); return; }
    response.end(body);
  });
}

export function localDashboardUrl(host = "127.0.0.1", port = 4174): string {
  return `http://${host}:${port}/app/plan`;
}
