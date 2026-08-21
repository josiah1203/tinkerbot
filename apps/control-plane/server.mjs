import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
// The in-memory backend is a local design-preview fixture only. A production
// static server may still serve the dashboard shell, but it must obtain
// lifecycle state from the hosted Worker rather than this hardcoded dataset.
const controlPlaneMode = String(process.env.CONTROL_PLANE_MODE ?? "preview").trim().toLowerCase();
const previewBackendEnabled = controlPlaneMode === "preview";
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };

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
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
};

const preview = {
  session: { authenticated: true, organizationId: "org_1", user: { id: "user_1", email: "alex@example.com" } },
  workOrders: [
    { workOrderId: "wo-attention", factoryId: "fac_1", issueOrPullRequest: "Verification failed on auth", repositoryId: "acme/payments", lineId: "security", status: "failed", currentStage: "verification", group: "blocked", outputKind: "pr", autonomyMode: "restricted", intent: "Repair the auth finding.", actor: { id: "deterministic-verifier", name: "Deterministic verifier", kind: "system" }, verificationVerdict: "fail", reviewDecision: "awaiting_human", releaseDecision: "not_eligible", outcomeStatus: "pending", unresolvedUnknownCount: 0, blockedReason: "The authentication verification gate failed.", updatedAt: "12 min ago", cost: { computeCents: 12, platformCents: 2, inferenceCents: 4, providerCents: 0, ownershipLabel: "Measured Tinkerbot-managed spend." } },
    { workOrderId: "wo-progress", factoryId: "fac_1", issueOrPullRequest: "Implement checkout", repositoryId: "acme/payments", lineId: "feature", status: "implementation", currentStage: "implementation", group: "in_progress", outputKind: "pr", autonomyMode: "approval_gated", intent: "Implement the checkout flow.", actor: { id: "agent_builder", name: "Builder", kind: "agent" }, verificationVerdict: "not_run", reviewDecision: "not_required", releaseDecision: "not_eligible", outcomeStatus: "pending", updatedAt: "28 min ago" },
    { workOrderId: "wo-ready", factoryId: "fac_1", issueOrPullRequest: "Add refund audit trail", repositoryId: "acme/payments", lineId: "feature", status: "ready", currentStage: "verification", group: "ready", outputKind: "pr", autonomyMode: "approval_gated", intent: "Add an immutable audit trail for refund decisions.", actor: { id: "agent_reviewer", name: "Reviewer", kind: "agent" }, verificationVerdict: "pass", reviewDecision: "approved", releaseDecision: "awaiting_authorization", outcomeStatus: "pending", updatedAt: "8 min ago", latestRunId: "run-wo-ready", cost: { computeCents: 8, platformCents: 1, inferenceCents: 3, providerCents: 0, ownershipLabel: "Measured Tinkerbot-managed spend." } },
    { workOrderId: "wo-approval", factoryId: "fac_1", issueOrPullRequest: "Spec for refunds", repositoryId: "acme/payments", lineId: "feature", status: "specification", currentStage: "specification", group: "awaiting_review", outputKind: "spec", autonomyMode: "approval_gated", intent: "Define the refund workflow and acceptance criteria.", actor: { id: "agent_foreman", name: "Foreman", kind: "agent" }, verificationVerdict: "pass", reviewDecision: "awaiting_human", releaseDecision: "not_eligible", outcomeStatus: "pending", updatedAt: "43 min ago" },
    { workOrderId: "wo-blocked", factoryId: "fac_1", issueOrPullRequest: "Unmapped repository", repositoryId: "acme/unknown", lineId: "feature", status: "blocked", currentStage: "foreman", group: "blocked", outputKind: "pr", autonomyMode: "restricted", intent: "Route the requested change to a repository.", actor: { id: "agent_foreman", name: "Foreman", kind: "agent" }, verificationVerdict: "blocked", reviewDecision: "not_required", releaseDecision: "not_eligible", outcomeStatus: "unknown", unresolvedUnknownCount: 1, blockedReason: "No repository mapping or authorized environment is available.", updatedAt: "1 hr ago" },
    { workOrderId: "wo-unknown", factoryId: "fac_1", issueOrPullRequest: "Preview environment signal missing", repositoryId: "acme/payments", lineId: "verification", status: "unknown", currentStage: "verification", group: "unknown", outputKind: "pr", autonomyMode: "restricted", intent: "Confirm the preview environment before release review.", actor: { id: "system", name: "Factory system", kind: "system" }, verificationVerdict: "unknown", reviewDecision: "awaiting_human", releaseDecision: "not_eligible", outcomeStatus: "unknown", unresolvedUnknownCount: 2, blockedReason: "The preview environment has not reported a trustworthy result.", updatedAt: "2 hr ago" },
    { workOrderId: "wo-done", factoryId: "fac_1", issueOrPullRequest: "Docs typo", repositoryId: "acme/payments", lineId: "bugfix", status: "released", currentStage: "complete", group: "released", outputKind: "pr", autonomyMode: "policy_autonomous", intent: "Correct the checkout documentation typo.", actor: { id: "user_1", name: "Alex Morgan", kind: "human" }, verificationVerdict: "pass", reviewDecision: "approved", releaseDecision: "released", outcomeStatus: "accepted", updatedAt: "Yesterday", latestRunId: "run-done" },
  ],
  factories: [{ factoryId: "fac_1", name: "payments", status: "active" }],
  products: [{ name: "payments", risk_class: "high" }],
  cells: [{ repository: "acme/payments", branch: "tinkerbot/wo", status: "leased", kind: "sandbox" }],
  skills: [{ skill_id: "sk_1", name: "reviewer-checklist", status: "active" }],
  proposals: [{ proposal_id: "prop_1", title: "Add reviewer checklist", status: "draft", evidence_json: "[\"8 similar PRs\"]" }],
  releases: [{ release_id: "rc1", factoryId: "fac_1", name: "payments 2026.08.20", status: "blocked", commit_sha: "abc1234", owner: "Release steward", workOrderId: "wo-attention" }],
  runs: [{ run_id: "run-done", factory_id: "fac_1", work_order_id: "wo-done", status: "completed", verificationVerdict: "pass", evidenceCoverage: "6/6", duration: "4m 12s", cost: "$0.18" }],
  environments: [{ id: "env-preview", name: "Preview", status: "healthy", owner: "Tinkerbot", updatedAt: "12 min ago" }, { id: "env-production", name: "Production", status: "approval gated", owner: "Release steward", updatedAt: "Yesterday" }],
  integrations: [{ id: "github", name: "GitHub", kind: "forge", status: "connected", owner: "Workspace", updatedAt: "Today", scopes: "Issues, pull requests" }],
  secrets: [{ id: "secret-github-token", name: "github-token", owner: "Workspace", status: "managed", updatedAt: "Yesterday", references: "GitHub integration" }],
  agents: [{ id: "agent_foreman", name: "Foreman", role: "Orchestrator", state: "active", activeAssignment: "wo-approval", health: "Healthy", lastRun: "43 min ago", cost: "$0.04" }, { id: "agent_builder", name: "Builder", role: "Implementation", state: "active", activeAssignment: "wo-progress", health: "Healthy", lastRun: "28 min ago", cost: "$0.07" }, { id: "agent_reviewer", name: "Reviewer", role: "Review", state: "idle", activeAssignment: "Unassigned", health: "Healthy", lastRun: "Yesterday", cost: "$0.02" }],
  automations: [{ id: "automation-intake", name: "GitHub issue intake", trigger: "github.issue.opened", enabled: true, owner: "Foreman", lastExecution: "12 min ago", nextExecution: "On event", result: "accepted" }],
  policies: [{ id: "policy-release", name: "Restricted release gate", status: "active", owner: "Security", updatedAt: "Today" }, { id: "policy-verification", name: "Deterministic verification", status: "active", owner: "Quality", updatedAt: "Today" }],
  repositories: [{ id: "acme/payments", name: "acme/payments", status: "connected", owner: "GitHub", updatedAt: "Today" }],
  outcomes: [{ kind: "successful_release", association: "human" }],
  usage: [{ kind: "Tinkerbot hosted inference", tokens: 1200, createdAt: "2030-01-01T00:00:00.000Z" }],
  billing: { planId: "developer", subscriptionState: "active", activeBillableSeats: 1, pricePerSeatCents: 2000, paidSeatCap: "none" },
};

function titleCase(value) { return String(value ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function previewGraphEvents(workOrderId) {
  const order = preview.workOrders.find((item) => item.workOrderId === workOrderId) ?? preview.workOrders[0];
  const base = { aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: "org_1", factoryId: "fac_1", actorId: "system", actorType: "system", schemaVersion: 1, correlationId: order.workOrderId, provenance: "ATTESTED" };
  const events = [
    { ...base, eventId: `evt_${order.workOrderId}`, type: "work_order.created", occurredAt: "2030-01-01T00:00:00.000Z", payload: { workOrderId: order.workOrderId, intent: order.intent ?? order.issueOrPullRequest } },
  ];
  const changeSetId = `change_${order.workOrderId}`;
  const changeSetDigest = `sha256:${order.workOrderId}`;
  events.push({ ...base, eventId: `change_${order.workOrderId}`, type: "change.proposed", occurredAt: "2030-01-01T00:02:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId, changeSetDigest } });
  if (order.status === "failed") events.push({ ...base, eventId: `verify_${order.workOrderId}`, type: "verification.recorded", actorId: "deterministic-verifier", provenance: "DETERMINISTICALLY_VERIFIED", occurredAt: "2030-01-01T00:03:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId, changeSetDigest, verificationRunId: `run_${order.workOrderId}`, verdict: "FAIL" } });
  if (order.status === "released") events.push(
    { ...base, eventId: `verify_${order.workOrderId}`, type: "verification.recorded", actorId: "deterministic-verifier", provenance: "DETERMINISTICALLY_VERIFIED", occurredAt: "2030-01-01T00:03:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId, changeSetDigest, verificationRunId: `run_${order.workOrderId}`, verdict: "PASS" } },
    { ...base, eventId: `review_${order.workOrderId}`, type: "review.recorded", actorId: "user_1", actorType: "human", provenance: "HUMAN_VERIFIED", occurredAt: "2030-01-01T00:04:00.000Z", payload: { workOrderId: order.workOrderId, changeSetId, changeSetDigest, reviewId: `review_${order.workOrderId}`, reviewerId: "user_1", outcome: "NO_FINDINGS", independence: "SECOND_HUMAN" } },
    { ...base, eventId: `approval_${order.workOrderId}`, type: "approval.recorded", actorId: "user_1", actorType: "human", provenance: "HUMAN_VERIFIED", occurredAt: "2030-01-01T00:04:30.000Z", payload: { workOrderId: order.workOrderId, changeSetId, changeSetDigest, approvalEventId: `approval_${order.workOrderId}`, scope: "RELEASE", outcome: "GRANTED", targetOutcome: "RELEASE", approverId: "user_1" } },
    { ...base, eventId: `release_decision_${order.workOrderId}`, type: "release.decided", actorId: "user_1", actorType: "human", provenance: "HUMAN_VERIFIED", occurredAt: "2030-01-01T00:04:45.000Z", payload: { workOrderId: order.workOrderId, releaseId: `release_${order.workOrderId}`, outcome: "RELEASE", changeSetId, changeSetDigest, approvalRef: { kind: "release_approval", eventId: `approval_${order.workOrderId}`, scope: "RELEASE", targetOutcome: "RELEASE", changeSetDigest } } },
    { ...base, eventId: `release_${order.workOrderId}`, type: "release.executed", actorId: "system", actorType: "system", provenance: "ATTESTED", occurredAt: "2030-01-01T00:05:00.000Z", payload: { workOrderId: order.workOrderId, releaseId: `release_${order.workOrderId}`, changeSetDigest } },
  );
  return events;
}

function previewGraph(workOrderId) {
  const events = previewGraphEvents(workOrderId);
  const verification = events.findLast?.((event) => event.type === "verification.recorded") ?? events.slice().reverse().find((event) => event.type === "verification.recorded");
  const review = events.findLast?.((event) => event.type === "review.recorded") ?? events.slice().reverse().find((event) => event.type === "review.recorded");
  const release = events.findLast?.((event) => event.type === "release.decided") ?? events.slice().reverse().find((event) => event.type === "release.decided");
  return {
    aggregateId: events[0]?.aggregateId,
    verificationVerdict: verification?.payload?.verdict ?? "UNKNOWN",
    reviewDecision: review?.payload?.outcome === "NO_FINDINGS" ? "APPROVE" : review?.payload?.outcome === "FINDINGS" ? "REQUEST_CHANGES" : review?.payload?.outcome === "ESCALATE" ? "ESCALATE" : "NOT_REVIEWED",
    releaseDecision: release?.payload?.outcome ?? "NOT_RELEASED",
    outcomeStatus: "UNMEASURED",
    outcomeMaturity: "IMMATURE",
    eventCount: events.length,
  };
}

function previewOrder(workOrderId) {
  return preview.workOrders.find((item) => item.workOrderId === workOrderId);
}

function previewActions(order) {
  const verification = String(order.verificationVerdict ?? "unknown").toLowerCase();
  const review = String(order.reviewDecision ?? order.reviewAssessment ?? "awaiting_human").toLowerCase();
  const release = String(order.releaseDecision ?? "not_eligible").toLowerCase();
  const canRelease = verification === "pass" && ["approved", "clear"].includes(review) && ["awaiting_authorization", "approved"].includes(release);
  return [
    { id: order.heldBy ? "return" : "take", label: order.heldBy ? "Return cell" : "Take cell", allowed: true },
    { id: "steer", label: "Add operator note", allowed: true },
    { id: "retry", label: "Retry run", allowed: ["failed", "blocked"].includes(String(order.status).toLowerCase()), reason: ["failed", "blocked"].includes(String(order.status).toLowerCase()) ? undefined : "Retry is available after a failed or blocked run." },
    { id: "review", label: "Record review", allowed: review === "awaiting_human", reason: review === "awaiting_human" ? undefined : "Review is not currently required." },
    { id: "authorize_release", label: "Authorize release", allowed: canRelease, reason: canRelease ? undefined : "Deterministic verification, human review, and release policy must be resolved first." },
  ];
}

function previewActivity(factoryId) {
  return preview.workOrders
    .filter((order) => !factoryId || order.factoryId === factoryId)
    .map((order) => ({
      id: `activity-${order.workOrderId}`,
      title: order.issueOrPullRequest,
      workOrderId: order.workOrderId,
      factoryId: order.factoryId,
      repositoryId: order.repositoryId,
      actor: order.actor,
      eventType: order.status === "released" ? "Release completed" : order.currentStage,
      occurredAt: order.updatedAt,
      ...order,
    }));
}

function previewRuns(factoryId) {
  const orders = preview.workOrders.filter((order) => !factoryId || order.factoryId === factoryId);
  const known = preview.runs.filter((run) => !factoryId || run.factory_id === factoryId);
  const generated = orders
    .filter((order) => !known.some((run) => run.work_order_id === order.workOrderId))
    .map((order) => ({
      run_id: `run-${order.workOrderId}`,
      factory_id: order.factoryId,
      work_order_id: order.workOrderId,
      status: order.status === "blocked" ? "blocked" : order.status === "failed" ? "failed" : "running",
      verificationVerdict: order.verificationVerdict ?? "not_run",
      evidenceCoverage: order.verificationVerdict === "pass" ? "6/6" : order.verificationVerdict === "fail" ? "5/6" : "2/6",
      duration: order.status === "implementation" ? "—" : "2m 18s",
      cost: order.cost ? `$${((Number(order.cost.computeCents ?? 0) + Number(order.cost.platformCents ?? 0) + Number(order.cost.inferenceCents ?? 0)) / 100).toFixed(2)}` : "—",
    }));
  return [...known, ...generated];
}

function previewEvidence(factoryId) {
  return preview.workOrders
    .filter((order) => !factoryId || order.factoryId === factoryId)
    .flatMap((order) => ["diff", "tests", "policy", "environment", "artifact", "outcome"].map((type, index) => ({
      id: `evidence-${order.workOrderId}-${type}`,
      evidenceId: `evidence-${order.workOrderId}-${type}`,
      name: `${titleCase(type)} · ${order.workOrderId}`,
      title: `${titleCase(type)} evidence`,
      workOrderId: order.workOrderId,
      factoryId: order.factoryId,
      type,
      producer: order.actor?.name ?? "Factory system",
      provenance: type === "tests" && order.verificationVerdict !== "pass" ? "blocked" : type === "policy" ? "policy_attested" : "recorded",
      recordedAt: order.updatedAt,
      sequence: index + 1,
    })));
}

function previewFactoryView(factoryId) {
  const factory = preview.factories.find((item) => item.factoryId === factoryId);
  if (!factory) return null;
  const orders = preview.workOrders.filter((order) => order.factoryId === factoryId);
  const groups = { blocked: 0, awaiting_review: 0, in_progress: 0, ready: 0, released: 0, unknown: 0 };
  orders.forEach((order) => { if (groups[order.group] != null) groups[order.group] += 1; });
  const activity = previewActivity(factoryId);
  const runs = previewRuns(factoryId);
  const evidence = previewEvidence(factoryId);
  return {
    factory: { ...factory, activeWorkOrders: orders.filter((order) => order.group !== "released").length, recentRelease: orders.find((order) => order.group === "released")?.updatedAt ?? "—" },
    activity,
    runs,
    evidence,
    agents: preview.agents,
    automations: preview.automations,
    policies: preview.policies,
    repositories: preview.repositories,
    releases: preview.releases.filter((item) => item.factoryId === factoryId),
    metrics: { inProgress: groups.in_progress, blocked: groups.blocked, awaitingReview: groups.awaiting_review, released: groups.released },
    costs: { totalCents: 18, acceptedChanges: groups.released, medianDurationSeconds: 252, ownershipLabel: "Measured Tinkerbot-managed spend." },
    graph: Object.fromEntries(orders.map((order) => [order.workOrderId, previewGraph(order.workOrderId)])),
  };
}

function previewResourceItems(resource, factoryId) {
  if (resource === "activity") return previewActivity(factoryId);
  if (resource === "runs") return previewRuns(factoryId);
  if (resource === "evidence") return previewEvidence(factoryId);
  if (resource === "agents") return preview.agents;
  if (resource === "automations") return preview.automations;
  if (resource === "policies") return preview.policies;
  if (resource === "repositories") return preview.repositories;
  if (resource === "releases") return preview.releases.filter((item) => !factoryId || item.factoryId === factoryId);
  if (resource === "costs") return [{ id: `cost-${factoryId || "workspace"}`, name: "Factory economics", status: "measured", owner: "Tinkerbot", updatedAt: "Today", totalCents: 18, acceptedChanges: 1 }];
  return [];
}

function previewSearch(query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  preview.workOrders.forEach((order) => {
    if (`${order.workOrderId} ${order.issueOrPullRequest} ${order.repositoryId}`.toLowerCase().includes(needle)) results.push({ kind: "Work order", title: order.issueOrPullRequest, meta: `${order.workOrderId} · ${order.repositoryId}`, href: `/factories/${encodeURIComponent(order.factoryId)}/work-orders/${encodeURIComponent(order.workOrderId)}` });
  });
  preview.factories.forEach((factory) => {
    if (`${factory.factoryId} ${factory.name}`.toLowerCase().includes(needle)) results.push({ kind: "Factory", title: factory.name, meta: factory.factoryId, href: `/factories/${encodeURIComponent(factory.factoryId)}` });
  });
  preview.runs.forEach((run) => {
    if (`${run.run_id} ${run.work_order_id}`.toLowerCase().includes(needle)) results.push({ kind: "Run", title: run.run_id, meta: run.work_order_id, href: `/runs/${encodeURIComponent(run.run_id)}` });
  });
  preview.integrations.forEach((integration) => {
    if (`${integration.id} ${integration.name}`.toLowerCase().includes(needle)) results.push({ kind: "MCP or app", title: integration.name, meta: integration.status, href: `/integrations/${encodeURIComponent(integration.id)}` });
  });
  preview.secrets.forEach((secret) => {
    if (`${secret.id} ${secret.name}`.toLowerCase().includes(needle)) results.push({ kind: "Secret metadata", title: secret.name, meta: "Value hidden", href: `/secrets/${encodeURIComponent(secret.id)}` });
  });
  return results.slice(0, 20);
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8", allow: "GET, HEAD, POST" });
  response.end(JSON.stringify(body));
}

function sendFile(response, file, requestUrl, method) {
  const contentType = types[extname(file)] ?? "application/octet-stream";
  if (contentType.startsWith("text/html")) {
    let contents = readFileSync(file, "utf8");
    if (!contents.includes("<base ")) contents = contents.replace("<head>", "<head><base href=\"/\">");
    response.writeHead(200, { ...headers, "content-type": contentType });
    if (method === "HEAD") { response.end(); return; }
    response.end(contents);
    return;
  }
  response.writeHead(200, { ...headers, "content-type": contentType });
  if (method === "HEAD") { response.end(); return; }
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}

function previewApi(request, body = {}) {
  const url = new URL(request.url ?? "/", "http://tinkerbot.preview");
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  const pageRequest = (method === "GET" || method === "HEAD") && !String(request.headers?.accept || "").includes("application/json");
  if (pathname === "/auth/workos/start") return { redirect: "/app" };
  if (pageRequest) return null;
  if (pathname === "/auth/session") return { body: preview.session };
  if (pathname === "/auth/signout") return { body: { signedOut: true } };
  if (pathname === "/search") return { body: { results: previewSearch(url.searchParams.get("q")) } };

  if (pathname === "/work-orders" && method === "POST") {
    const id = `wo-preview-${Date.now()}`;
    const workOrder = {
      workOrderId: id,
      factoryId: body.factoryId || preview.factories[0]?.factoryId || "fac_1",
      issueOrPullRequest: body.intent || "Untitled work order",
      repositoryId: body.repositoryId || "Unassigned repository",
      lineId: "manual",
      status: "intake",
      currentStage: "intake",
      group: "in_progress",
      outputKind: "pr",
      intent: body.intent || "No intent provided.",
      sourceType: "Operator intake",
      actor: { id: "user_1", name: "Alex Morgan", kind: "human" },
      verificationVerdict: "not_run",
      reviewDecision: "not_required",
      releaseDecision: "not_eligible",
      outcomeStatus: "pending",
      unresolvedUnknownCount: 0,
      updatedAt: "Just now",
    };
    preview.workOrders.unshift(workOrder);
    return { status: 201, body: { workOrder, availableActions: previewActions(workOrder) } };
  }
  if (pathname === "/work-orders") {
    const factoryId = url.searchParams.get("factoryId");
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const group = url.searchParams.get("group");
    const stage = url.searchParams.get("stage");
    const risk = url.searchParams.get("risk");
    const workOrders = preview.workOrders.filter((order) => (!factoryId || order.factoryId === factoryId) && (!q || `${order.workOrderId} ${order.issueOrPullRequest} ${order.repositoryId}`.toLowerCase().includes(q)) && (!group || order.group === group) && (!stage || order.currentStage === stage || order.stage === stage) && (!risk || order.risk === risk));
    return { body: { workOrders: workOrders.map((order) => ({ ...order, availableActions: previewActions(order) })) } };
  }

  const graphMatch = pathname.match(/^\/work-orders\/([^/]+)\/graph$/);
  if (graphMatch) {
    const workOrder = previewOrder(graphMatch[1]);
    if (!workOrder) return { status: 404, body: { error: "Work order not found.", code: "not_found" } };
    const events = previewGraphEvents(graphMatch[1]);
    const nodes = previewEvidence(workOrder.factoryId).filter((item) => item.workOrderId === workOrder.workOrderId).map((item) => ({ id: item.id, label: titleCase(item.type), type: item.type, status: item.provenance === "blocked" ? "blocked" : "linked" }));
    return { body: { workOrder, graph: { ...previewGraph(graphMatch[1]), nodes }, economics: { cogsCents: 18, copqCents: workOrder.status === "failed" ? 8 : 0, acceptedChanges: workOrder.status === "released" ? 1 : 0, unrevertedChanges: workOrder.status === "released" ? 1 : 0, outcomePositiveChanges: 0, costPerAcceptedUnrevertedOutcomePositiveChange: null }, events, sourceOfTruth: "append_only_factory_graph" } };
  }

  const decisionMatch = pathname.match(/^\/work-orders\/([^/]+)\/decisions$/);
  if (decisionMatch && method === "POST") {
    const workOrder = previewOrder(decisionMatch[1]);
    if (!workOrder) return { status: 404, body: { error: "Work order not found.", code: "not_found" } };
    const type = body.type;
    if (type === "review") {
      if (workOrder.reviewDecision !== "awaiting_human") return { status: 409, body: { error: "This work order is not awaiting human review.", code: "review_not_available" } };
      workOrder.reviewDecision = body.decision === "rejected" ? "rejected" : body.decision === "changes_requested" ? "changes_requested" : "approved";
      if (workOrder.reviewDecision === "approved" && workOrder.verificationVerdict === "pass") { workOrder.releaseDecision = "awaiting_authorization"; workOrder.group = "ready"; }
    } else if (type === "release_authorization") {
      if (workOrder.verificationVerdict !== "pass" || workOrder.reviewDecision !== "approved" || !body.evidenceAcknowledged) return { status: 409, body: { error: "Release authorization requires a passing deterministic verdict, human approval, and acknowledged evidence.", code: "release_gate_blocked" } };
      workOrder.releaseDecision = "released"; workOrder.outcomeStatus = "accepted"; workOrder.status = "released"; workOrder.currentStage = "complete"; workOrder.group = "released"; workOrder.updatedAt = "Just now";
    } else return { status: 400, body: { error: "Unsupported decision type.", code: "invalid_decision" } };
    return { body: { workOrder, availableActions: previewActions(workOrder) } };
  }

  const workActionMatch = pathname.match(/^\/work-orders\/([^/]+)\/([^/]+)$/);
  if (workActionMatch && method === "POST") {
    const [, workOrderId, action] = workActionMatch;
    const workOrder = previewOrder(workOrderId);
    if (!workOrder) return { status: 404, body: { error: "Work order not found.", code: "not_found" } };
    if (action === "retry") {
      if (!["failed", "blocked"].includes(String(workOrder.status).toLowerCase())) return { status: 409, body: { error: "Retry is not available for this work order.", code: "retry_not_available" } };
      workOrder.status = "implementation"; workOrder.currentStage = "implementation"; workOrder.group = "in_progress"; workOrder.verificationVerdict = "not_run"; workOrder.reviewDecision = "not_required"; workOrder.releaseDecision = "not_eligible"; workOrder.updatedAt = "Just now";
    } else if (action === "take") workOrder.heldBy = "user_1";
    else if (action === "return") delete workOrder.heldBy;
    else if (action === "steer") workOrder.lastOperatorNote = body.note || "Operator note recorded.";
    else if (action === "approve") workOrder.specApproved = true;
    else if (!["cancel"].includes(action)) return { status: 404, body: { error: "Work order action not found.", code: "not_found" } };
    return { body: { workOrder, availableActions: previewActions(workOrder), ok: true, specApproved: Boolean(workOrder.specApproved) } };
  }

  const workOrderDetailMatch = pathname.match(/^\/work-orders\/([^/]+)$/);
  if (workOrderDetailMatch) {
    const workOrder = previewOrder(workOrderDetailMatch[1]);
    if (!workOrder) return { status: 404, body: { error: "Work order not found.", code: "not_found" } };
    const run = previewRuns(workOrder.factoryId).find((item) => item.work_order_id === workOrder.workOrderId);
    return { body: { workOrder, run, stages: ["intake", "spec", "build", "verify", "release"], events: previewGraphEvents(workOrder.workOrderId), availableActions: previewActions(workOrder) } };
  }

  if (pathname === "/factories" && method === "POST") {
    const id = `fac_${Date.now()}`;
    const factory = { factoryId: id, name: body.name || "New factory", status: "active", activeWorkOrders: 0, recentRelease: "—", updatedAt: "Just now" };
    preview.factories.push(factory);
    return { status: 201, body: { factory } };
  }
  if (pathname === "/factories") return { body: { factories: preview.factories.map((factory) => ({ ...factory, activeWorkOrders: preview.workOrders.filter((order) => order.factoryId === factory.factoryId && order.group !== "released").length })) } };

  const factoryActionMatch = pathname.match(/^\/factories\/([^/]+)\/(agents|automations)$/);
  if (factoryActionMatch && method === "POST") {
    const [, factoryId, resource] = factoryActionMatch;
    if (!preview.factories.some((factory) => factory.factoryId === factoryId)) return { status: 404, body: { error: "Factory not found.", code: "not_found" } };
    const item = resource === "agents" ? { id: `agent_${Date.now()}`, name: body.name || "New agent", role: body.role || "Specialist", state: "idle", activeAssignment: "Unassigned", health: "Healthy", lastRun: "Never", cost: "—" } : { id: `automation_${Date.now()}`, name: body.name || "New automation", trigger: body.trigger || "manual", enabled: true, owner: "Factory", lastExecution: "Never", nextExecution: "On event", result: "pending" };
    preview[resource].push(item);
    return { status: 201, body: { item } };
  }

  const factoryPathMatch = pathname.match(/^\/factories\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (factoryPathMatch) {
    const [, factoryId, resource, entityId] = factoryPathMatch;
    const view = previewFactoryView(factoryId);
    if (!view) return { status: 404, body: { error: "Factory not found.", code: "not_found" } };
    if (!resource) return { body: view };
    const items = resource === "work-orders" ? preview.workOrders.filter((item) => item.factoryId === factoryId) : previewResourceItems(resource, factoryId);
    if (entityId) {
      const item = items.find((candidate) => String(candidate.id || candidate.workOrderId || candidate.run_id || candidate.runId || candidate.evidenceId || candidate.release_id) === entityId);
      return item ? { body: { item } } : { status: 404, body: { error: "Factory record not found.", code: "not_found" } };
    }
    return { body: { items } };
  }

  if (pathname === "/secrets" && method === "POST") {
    const secret = { id: `secret-${Date.now()}`, name: body.name || "managed-secret", owner: "Workspace", status: "managed", updatedAt: "Just now", references: "Not referenced yet" };
    preview.secrets.push(secret);
    return { status: 201, body: { secret } };
  }
  if (pathname === "/integrations" && method === "POST") {
    const integration = { id: `integration-${Date.now()}`, name: body.name || "New integration", kind: body.kind || "custom_mcp", status: "pending", owner: "Workspace", updatedAt: "Just now", scopes: "Awaiting configuration" };
    preview.integrations.push(integration);
    return { status: 201, body: { integration } };
  }
  const workspaceMatch = pathname.match(/^\/(runs|environments|integrations|secrets)(?:\/([^/]+))?$/);
  if (workspaceMatch) {
    const [, resource, entityId] = workspaceMatch;
    const items = resource === "runs" ? previewRuns() : preview[resource];
    if (entityId) {
      const item = items.find((candidate) => String(candidate.id || candidate.run_id || candidate.runId || candidate.secretId || candidate.integrationId) === entityId);
      return item ? { body: { item } } : { status: 404, body: { error: `${titleCase(resource)} record not found.`, code: "not_found" } };
    }
    return { body: { items } };
  }

  if (pathname === "/products") return { body: { products: preview.products } };
  if (pathname === "/cells") return { body: { cells: preview.cells } };
  if (pathname === "/skills") return { body: { skills: preview.skills } };
  if (pathname === "/evolution" || pathname.startsWith("/evolution/")) {
    if (method === "POST") return { status: 409, body: { error: "Release Steward cannot approve its own activation.", code: "steward_cannot_self_approve" } };
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

async function requestBody(request) {
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "PUT") return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers);
    response.end();
    return;
  }
  const apiLikePath = String(request.headers.accept ?? "").includes("application/json") || !["GET", "HEAD"].includes(request.method ?? "GET");
  if (!previewBackendEnabled && apiLikePath) {
    sendJson(response, { error: "The local preview backend is disabled; configure the hosted control-plane API.", code: "preview_backend_disabled" }, 503);
    return;
  }
  const mocked = previewBackendEnabled ? previewApi(request, await requestBody(request)) : null;
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
  sendFile(response, file, request.url, request.method);
}).listen(port, host, () => {
  console.log(`Tinkerbot preview: http://${host}:${port}/`);
  console.log(`Dashboard:        http://${host}:${port}/app`);
  console.log(`Pricing:          http://${host}:${port}/pricing`);
});
