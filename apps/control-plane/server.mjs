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

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const preview = {
  session: { authenticated: true, organizationId: "org_1", user: { id: "user_1", email: "alex@example.com" } },
  workOrders: [
    { workOrderId: "wo-attention", issueOrPullRequest: "Verification failed on auth", repositoryId: "acme/payments", lineId: "security", status: "failed", currentStage: "verification", group: "needs_attention", outputKind: "pr", autonomyMode: "restricted", intent: "Repair the auth finding." },
    { workOrderId: "wo-progress", issueOrPullRequest: "Implement checkout", repositoryId: "acme/payments", lineId: "feature", status: "implementation", currentStage: "implementation", group: "in_progress", outputKind: "pr", autonomyMode: "approval_gated" },
    { workOrderId: "wo-approval", issueOrPullRequest: "Spec for refunds", repositoryId: "acme/payments", lineId: "feature", status: "specification", currentStage: "specification", group: "waiting_for_approval", outputKind: "spec", autonomyMode: "approval_gated" },
    { workOrderId: "wo-blocked", issueOrPullRequest: "Unmapped repository", repositoryId: "acme/unknown", lineId: "feature", status: "blocked", currentStage: "foreman", group: "blocked", outputKind: "pr", autonomyMode: "restricted" },
    { workOrderId: "wo-done", issueOrPullRequest: "Docs typo", repositoryId: "acme/payments", lineId: "bugfix", status: "released", currentStage: "complete", group: "completed", outputKind: "pr", autonomyMode: "policy_autonomous" },
  ],
  factories: [{ factoryId: "fac_1", name: "payments", status: "active" }],
  products: [{ name: "payments", risk_class: "high" }],
  cells: [{ repository: "acme/payments", branch: "tinkerbot/wo", status: "leased", kind: "sandbox" }],
  skills: [{ skill_id: "sk_1", name: "reviewer-checklist", status: "active" }],
  proposals: [{ proposal_id: "prop_1", title: "Add reviewer checklist", status: "draft", evidence_json: "[\"8 similar PRs\"]" }],
  releases: [{ release_id: "rc1", status: "blocked", commit_sha: "abc1234" }],
  outcomes: [{ kind: "successful_release", association: "human" }],
  usage: [{ kind: "workers-ai", tokens: 1200, costCents: 4 }],
  billing: { planId: "developer", subscriptionState: "active", activeBillableSeats: 1, pricePerSeatCents: 2000, paidSeatCap: "none", account: { planId: "developer", status: "active" } },
};

function sendJson(response, body, status = 200) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8", allow: "GET, HEAD, POST" });
  response.end(JSON.stringify(body));
}

function previewApi(request) {
  const pathname = (request.url ?? "/").split("?")[0];
  if (pathname === "/auth/workos/start") return { redirect: "/app" };
  if (pathname === "/auth/session") return { body: preview.session };
  if (pathname === "/auth/signout") return { body: { signedOut: true } };
  if (pathname === "/work-orders") return { body: { workOrders: preview.workOrders } };
  if (pathname.startsWith("/work-orders/")) return { body: { ok: true, specApproved: pathname.endsWith("/approve") } };
  if (pathname === "/factories" || pathname.startsWith("/factories/")) return { body: { factories: preview.factories } };
  if (pathname === "/products") return { body: { products: preview.products } };
  if (pathname === "/cells") return { body: { cells: preview.cells } };
  if (pathname === "/skills") return { body: { skills: preview.skills } };
  if (pathname === "/evolution" || pathname.startsWith("/evolution/")) {
    if (request.method === "POST") return { status: 409, body: { error: "Release Steward cannot approve its own activation.", code: "steward_cannot_self_approve" } };
    return { body: { proposals: preview.proposals } };
  }
  if (pathname === "/releases") return { body: { releases: preview.releases } };
  if (pathname === "/outcomes") return { body: { outcomes: preview.outcomes } };
  if (pathname === "/usage") return { body: { billed: false, fairUse: true, billingUnit: "active_seat", usage: preview.usage } };
  if (pathname === "/billing/summary") return { body: preview.billing };
  if (pathname === "/billing/trial/start") return { body: { pending: false, trial: { state: "trialing" }, grantedFromRedirect: false } };
  if (pathname === "/billing/portal") return { body: { portal: { url: "/app/settings/billing" } } };
  if (pathname === "/tenant/organizations") return { body: { authenticated: true, currentOrganizationId: "org_1", organizations: [{ organizationId: "org_1", role: "owner" }] } };
  if (pathname === "/tenant/organizations/switch") return { body: { organizationId: "org_1" } };
  if (pathname === "/org/seats") return { body: { activeBillableSeats: 1 } };
  if (pathname === "/integrations/github") return { body: { installed: false } };
  return null;
}

createServer((request, response) => {
  const mocked = previewApi(request);
  if (mocked?.redirect) {
    response.writeHead(302, { ...headers, location: mocked.redirect });
    response.end();
    return;
  }
  if (mocked) {
    sendJson(response, mocked.body, mocked.status ?? 200);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD, POST", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed\n");
    return;
  }
  const file = fileFor(request.url);
  if (!file) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request\n");
    return;
  }
  response.writeHead(200, { ...headers, "content-type": types[extname(file)] ?? "application/octet-stream" });
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}).listen(port, host, () => {
  console.log(`Tinkerbot preview: http://${host}:${port}/`);
  console.log(`Dashboard:        http://${host}:${port}/app`);
  console.log(`Pricing:          http://${host}:${port}/pricing`);
});
