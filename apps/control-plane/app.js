import { plans } from "./data.js";

const app = document.querySelector("#app");
const h = (...parts) => parts.join("");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

const GROUP_ORDER = ["needs_attention", "in_progress", "waiting_for_approval", "blocked", "completed"];
const GROUP_TITLES = {
  needs_attention: "Needs attention",
  in_progress: "In progress",
  waiting_for_approval: "Waiting for approval",
  blocked: "Blocked",
  completed: "Recently completed",
};

const ACTIVITY_ORDER = ["triage", "planning", "building", "reviewing", "blocked", "done"];
const ACTIVITY_TITLES = {
  triage: "Triage",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  blocked: "Blocked",
  done: "Done",
};

const state = {
  session: null,
  factories: [],
  workOrders: [],
  products: [],
  cells: [],
  skills: [],
  proposals: [],
  releases: [],
  outcomes: [],
  usage: [],
  billing: null,
  organizations: [],
  seats: null,
  github: null,
  factoryView: null,
  plans: [],
  costs: [],
  evals: [],
  evalCompare: { improved: [], regressed: [], unchanged: [], upgradesVerdict: false },
  error: null,
  workError: null,
  factoryError: null,
  evidenceError: null,
  billingNotice: null,
  wizardNotice: null,
  focusedId: null,
  selectedIds: new Set(),
  anchorId: null,
  paletteOpen: false,
  paletteQuery: "",
  paletteIndex: 0,
  orgMenu: false,
  releasesTab: "candidates",
};

function apiBase() {
  const configured = typeof window.__TINKERBOT_CONTROL_PLANE_API__ === "string"
    ? window.__TINKERBOT_CONTROL_PLANE_API__
    : document.querySelector("meta[name=\"tinkerbot-api-base\"]")?.content ?? "";
  try {
    const url = new URL(configured.trim() || window.location.origin, window.location.origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return "";
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

async function api(pathname, method = "GET", body) {
  const base = apiBase();
  if (!base) throw new Error("unavailable");
  const response = await fetch(`${base}${pathname}`, { method, credentials: "include", headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload });
  return payload;
}

function pathName() { return window.location.pathname || "/"; }
function searchParams() { return new URLSearchParams(window.location.search); }
function segments() { return pathName().split("/").filter(Boolean); }
function localAdapter() {
  return document.querySelector("meta[name=\"tinkerbot-local-adapter\"]")?.content === "1" || window.__TINKERBOT_LOCAL_ADAPTER__ === true;
}
function signedIn() { return localAdapter() || Boolean(state.session?.authenticated); }

function navigate(href, replace = false) {
  const url = new URL(href, window.location.origin);
  const next = url.pathname + url.search;
  if (replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
  state.paletteOpen = false;
  state.orgMenu = false;
  render();
}

function canonicalHref() {
  const path = pathName();
  const search = window.location.search;
  const parts = segments();
  if (path === "/sign-in") return `/login${search}`;
  if (path === "/app/overview") return "/app";
  if (path === "/app/work-orders") return "/app/work";
  if (parts[0] === "app" && parts[1] === "work-orders" && parts[2]) return `/app/work/${parts[2]}`;
  if (path === "/app/findings" || (parts[0] === "app" && parts[1] === "findings" && !parts[2])) return "/app/evidence";
  if (parts[0] === "app" && parts[1] === "findings" && parts[2]) return `/app/evidence/${parts[2]}`;
  if (path === "/app/integrations") return "/app/settings/github";
  if (path === "/app/outcomes" || path.startsWith("/app/outcomes/")) return "/app/releases";
  if (path === "/login" && signedIn()) {
    const returnTo = searchParams().get("returnTo");
    return returnTo && returnTo.startsWith("/app") ? returnTo : "/app";
  }
  if (path === "/github/install") return signedIn() ? "/app/settings/github" : `/login?returnTo=${encodeURIComponent("/app/settings/github")}`;
  if (path.startsWith("/app") && !signedIn()) return `/login?returnTo=${encodeURIComponent(path + search)}`;
  return path + search;
}

function workosStart() {
  const returnTo = pathName() === "/login" ? (searchParams().get("returnTo") || "/app") : "/app";
  const safe = returnTo.startsWith("/app") ? returnTo : "/app";
  return `${apiBase() || ""}/auth/workos/start?returnTo=${encodeURIComponent(safe)}`;
}

function icon(name) {
  const marks = {
    inbox: '<circle cx="8" cy="8" r="5.5"/><path d="M5 8h6"/>',
    work: '<rect x="3" y="3.5" width="10" height="9" rx="1.5"/><path d="M3 6.5h10"/>',
    product: '<path d="M8 2.5 13.5 6v4.5L8 13.5 2.5 10.5V6z"/>',
    factory: '<path d="M3 13.5V7l4 2.5V7l6-3v9.5z"/>',
    release: '<path d="M4 11.5 8 3.5l4 8H4z"/>',
    evolution: '<path d="M4 12a4 4 0 1 0 0-2"/><path d="M12 4a4 4 0 1 0 0 2"/>',
    settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.5v1.5M8 12v1.5M2.5 8h1.5M12 8h1.5"/>',
    usage: '<path d="M3 12h10M4.5 12V7M8 12V4.5M11.5 12V9"/>',
    search: '<circle cx="7" cy="7" r="3.5"/><path d="m12.5 12.5-2.2-2.2"/>',
  };
  return h("<svg class=\"ui-icon\" viewBox=\"0 0 16 16\" aria-hidden=\"true\">", marks[name] ?? marks.work, "</svg>");
}

function navActive(href) {
  if (href === "/app") return pathName() === "/app";
  return pathName() === href || pathName().startsWith(`${href}/`);
}

function marketingHeader() {
  const productOpen = signedIn();
  return h(
    "<header class=\"marketing-header\">",
    "<a class=\"marketing-brand\" href=\"/\">Tinkerbot</a>",
    "<nav class=\"marketing-nav\">",
    "<a href=\"/product\">Product</a>",
    "<a href=\"/changelog\">Changelog</a>",
    "<a href=\"/docs\">Docs</a>",
    "<a href=\"/pricing\">Pricing</a>",
    "</nav>",
    "<div class=\"marketing-actions\">",
    productOpen ? "<a class=\"button primary\" href=\"/app\">Open app</a>" : h("<a class=\"button\" href=\"/login\">Log in</a><a class=\"button primary\" href=\"/login?returnTo=", encodeURIComponent("/app"), "\">Start trial</a>"),
    "</div></header>",
  );
}

function marketingFooter() {
  return h(
    "<footer class=\"marketing-footer\">",
    "<a href=\"/security\">Security</a>",
    "<a href=\"/support\">Support</a>",
    "<a href=\"/privacy\">Privacy</a>",
    "<a href=\"/terms\">Terms</a>",
    "</footer>",
  );
}

function marketingShell(body) {
  return h("<div class=\"marketing-shell\">", marketingHeader(), body, marketingFooter(), "</div>");
}

function prose(title, body) {
  return h("<main class=\"prose\"><h1>", esc(title), "</h1>", body, "</main>");
}

const CHANGELOG = [
  {
    slug: "2026-08-18-seat-billing",
    date: "Aug 18, 2026",
    title: "Seat billing catalog",
    summary: "Paid plans are $20 / $40 / $60 per active human seat. Team trial is cardless and owned by Tinkerbot. Token and run counts are not invoiced.",
    body: "<p>Developer, Team, and Business are billed per active human seat. Annual is ten months. The 14-day Team trial does not collect a card. Paid plans have no seat or repository cap.</p><p>Deleted $12 / $18 / $29 prices, paid-cap fields in Stripe JSON, and Checkout trialPeriodDays. Clients cannot submit price IDs, quantities, or entitlements.</p>",
  },
];

const DOCS = {
  quickstart: { title: "Quickstart", body: "<p><code>tb login</code> stores a hosted session. <code>tb dashboard</code> opens <code>/app</code>. Local <code>tb check</code> remains the verification verdict and does not grant hosted authority.</p>" },
  factories: { title: "Factories", body: "<p>A factory is a Foreman plus specialist agents defined in <code>.tinkerbot/</code>. Create from <code>/app/factories/new</code> or <code>tb factory new</code>, then sync. Automations start work; Activity groups Triage, Planning, Building, and Reviewing. <code>tb check</code> is the only verdict. Agents never merge. GitLab MR and issue hooks are intake only. Seats are billed, not credits. Hosted inference is included on your plan. Claude Code and Codex harnesses are not supported.</p>" },
  cli: { title: "CLI", body: "<p>Hosted commands: factory, work, cell, product, skill, evolution, billing, org seats. Local commands: check, doctor, report, agents. <code>tb tui</code> is a tabbed master terminal on a TTY (<code>pnpm tb tui</code>); <code>tb tui --once</code> is a CI check transcript. Nested Claude/Gemini/Codex/Cursor CLIs use their own OAuth. <code>tb dashboard</code> opens <code>/app</code>.</p>" },
  action: { title: "GitHub Action", body: "<p>Tinkerbot Verify runs on <code>pull_request</code> only. Forks stay write-disabled. Missing ingest is UNKNOWN. Agents cannot rewrite verdicts. Humans merge.</p>" },
  billing: { title: "Billing", body: "<p>Active human seats are the billing unit. Developer $20, Team $40, Business $60 per month ($200 / $400 / $600 annual). Team includes a 14-day trial with no card. Hosted inference is included on your plan and is not invoiced per token.</p>" },
  security: { title: "Security", body: "<p>Tinkerbot sessions authenticate humans. SSO is a Business entitlement. Evidence is source-minimized. Past-due and unknown billing fail closed for paid mutations.</p>" },
};

function publicPage() {
  const path = pathName();
  const parts = segments();
  if (path === "/login") return loginPage();
  if (path === "/pricing") {
    return marketingShell(h(
      "<main class=\"prose pricing-page\"><h1>Pricing</h1>",
      "<p>Developer $20/mo, Team $40/mo, Business $60/mo per active human seat. Annual is 10 months: $200 / $400 / $600. Team includes a 14-day trial with no card. Enterprise is custom. AI tokens are internal cost telemetry, not the billing unit. Paid plans have no seat or repository cap.</p>",
      "<div class=\"plan-list\">",
      plans.map((plan) => h("<article class=\"plan-option\"><h3>", esc(plan.name), "</h3><strong>", esc(plan.price), "</strong><p>", esc(plan.detail), "</p></article>")).join(""),
      "</div></main>",
    ));
  }
  if (path === "/product") {
    return marketingShell(prose("Factory OS", "<p>Tinkerbot turns software intent into verified, traceable, releasable changes. Work orders move through cells. Humans merge. The Release Steward cannot self-approve or auto-merge.</p><p>Agents produce drafts and receipts. They never rewrite <code>tb check</code> verdicts.</p>"));
  }
  if (path === "/verification") {
    return marketingShell(prose("Verification", "<p><code>tb check</code> is the only verification verdict. Missing evidence is UNKNOWN. Agents cannot rewrite verdicts. GitHub Actions use <code>pull_request</code>, never <code>pull_request_target</code>.</p>"));
  }
  if (path === "/github") {
    return marketingShell(prose("GitHub", "<p>Install the Tinkerbot GitHub App to connect repositories. Fork pull requests stay write-disabled. Agents never merge.</p><p><a class=\"button primary\" href=\"/github/install\">Install GitHub App</a></p>"));
  }
  if (path === "/agents") {
    return marketingShell(prose("Agents", "<p>Governed agents run inside factory lines. Every run writes a receipt. Factory evolution is an explicit proposal. The Steward cannot silently rewrite prompts, policies, or merge rules.</p>"));
  }
  if (path === "/changelog") {
    return marketingShell(h("<main class=\"prose\"><h1>Changelog</h1>", CHANGELOG.map((entry) => h("<article class=\"changelog-item\"><a href=\"/changelog/", esc(entry.slug), "\"><strong>", esc(entry.title), "</strong></a><span>", esc(entry.date), "</span><p>", esc(entry.summary), "</p></article>")).join(""), "</main>"));
  }
  if (parts[0] === "changelog" && parts[1]) {
    const entry = CHANGELOG.find((item) => item.slug === parts[1]);
    return marketingShell(prose(entry?.title ?? "Changelog", entry ? h("<p class=\"muted\">", esc(entry.date), "</p>", entry.body) : "<p>That entry was not found.</p>"));
  }
  if (path === "/docs") {
    return marketingShell(h("<main class=\"prose\"><h1>Docs</h1><ul>", Object.entries(DOCS).map(([slug, doc]) => h("<li><a href=\"/docs/", slug, "\">", esc(doc.title), "</a></li>")).join(""), "</ul></main>"));
  }
  if (parts[0] === "docs" && parts[1]) {
    const doc = DOCS[parts[1]];
    return marketingShell(prose(doc?.title ?? "Docs", doc?.body ?? "<p>That page is not in the curated set.</p>"));
  }
  if (path === "/security") {
    return marketingShell(prose("Security", "<p>Tinkerbot sessions authenticate humans. Seat quantity is calculated server-side from active human members. Entitlements are calculated in the control plane. Source and full diffs stay on the customer runner. Hosted evidence is source-minimized. Paid mutations fail closed when billing is unknown or past due.</p>"));
  }
  if (path === "/method") {
    return marketingShell(prose("Method", "<p>Intent becomes a work order. A cell leases a branch. Agents implement. <code>tb check</code> verifies. A human merges. Outcomes are recorded after release. Evidence, not chat, is the record.</p>"));
  }
  if (path === "/support") {
    return marketingShell(prose("Support", "<p>Contact support from the signed-in dashboard after log in. Hosted session required for org and billing questions. Local <code>tb check</code> does not require an account.</p>"));
  }
  if (path === "/privacy") {
    return marketingShell(prose("Privacy", "<p>Source and full diffs stay on the customer runner. Hosted evidence is source-minimized. Seat billing does not invoice tokens.</p>"));
  }
  if (path === "/terms") {
    return marketingShell(prose("Terms", "<p>Tinkerbot is a proprietary hosted factory operating system. Hosted commands require an authenticated session. Local verification remains independently authoritative.</p>"));
  }
  return marketingShell(h(
    "<main class=\"hero\">",
    "<p class=\"eyebrow\">Factory operating system</p>",
    "<h1>Tinkerbot Factory OS</h1>",
    "<p>A governed production system that turns software intent into verified, traceable, releasable changes.</p>",
    "<p class=\"hero-actions\">",
    signedIn() ? "<a class=\"button primary\" href=\"/app\">Open app</a>" : h("<a class=\"button primary\" href=\"/login\">Start trial</a> <a class=\"button\" href=\"/login\">Log in</a>"),
    " <a href=\"/pricing\">Pricing</a></p>",
    "</main>",
  ));
}

function loginPage() {
  return h(
    "<div class=\"auth-page\">",
    "<section class=\"auth-story\"><div class=\"auth-copy\"><p class=\"eyebrow\">Tinkerbot</p><h1>Log in to the factory.</h1><p>After sign-in you land in Inbox. <code>tb check</code> stays the verification verdict.</p></div></section>",
    "<section class=\"auth-panel\"><div class=\"auth-card\"><h2>Log in</h2><p>Continue with Google, GitHub, or SSO.</p><a class=\"button primary full\" href=\"", esc(workosStart()), "\">Log in</a><p class=\"auth-links\"><a href=\"/\">Back to website</a></p></div></section>",
    "</div>",
  );
}

function sidebar() {
  const orgName = state.session?.organizationId ?? "Organization";
  const email = state.session?.user?.email ?? "Signed in";
  const items = [
    ["/app", "Inbox", "inbox"],
    ["/app/work", "Work", "work"],
    ["/app/products", "Products", "product"],
    ["/app/factories", "Factories", "factory"],
    ["/app/releases", "Releases", "release"],
    ["/app/evolution", "Evolution", "evolution"],
  ];
  if (localAdapter()) {
    items.splice(1, 0, ["/app/plan", "Plan", "work"], ["/app/cost", "Cost", "usage"], ["/app/eval", "Eval", "inbox"]);
  }
  return h(
    "<aside class=\"sidebar\"><div class=\"sidebar-frame\">",
    "<div class=\"sidebar-header\"><div class=\"sidebar-org-row\"><div class=\"menu-wrap\">",
    "<button type=\"button\" class=\"org-switcher\" data-org-menu aria-expanded=\"", state.orgMenu ? "true" : "false", "\"><span class=\"org-avatar\">", esc(String(orgName).slice(0, 2).toUpperCase()), "</span><span class=\"org-copy\"><strong>", esc(orgName), "</strong><span>", esc(email), "</span></span></button>",
    state.orgMenu ? h("<div class=\"menu org-menu\">", (state.organizations.length ? state.organizations : [{ organizationId: orgName }]).map((org) => h("<button type=\"button\" class=\"menu-button\" data-org-switch=\"", esc(org.organizationId), "\">", esc(org.organizationId), "</button>")).join(""), "</div>") : "",
    "</div><div class=\"sidebar-tools\"><button type=\"button\" class=\"icon-button\" data-palette title=\"Command menu\">", icon("search"), "</button></div></div></div>",
    "<nav class=\"sidebar-nav\"><div class=\"nav-group\"><div class=\"nav-list\">",
    items.map(([href, label, name]) => h("<a class=\"nav-link", navActive(href) ? " active" : "", "\" href=\"", href, "\">", icon(name), "<span class=\"nav-text\">", label, "</span></a>")).join(""),
    "</div></div></nav>",
    "<div class=\"sidebar-footer\">",
    "<a class=\"sidebar-footer-row", navActive("/app/settings") ? "\" aria-current=\"page\"" : "\"", " href=\"/app/settings\">", icon("settings"), " Settings</a>",
    "<a class=\"sidebar-footer-row", navActive("/app/usage") ? "\" aria-current=\"page\"" : "\"", " href=\"/app/usage\">", icon("usage"), " Usage</a>",
    "</div></div></aside>",
  );
}

function appShell(title, body, options = {}) {
  return h(
    "<div class=\"app-shell\">",
    sidebar(),
    "<div class=\"main\"><div class=\"main-frame\">",
    "<header class=\"topbar\"><div class=\"topbar-left\"><div class=\"breadcrumbs\"><strong>", esc(title), "</strong></div></div>",
    "<div class=\"topbar-actions\"><button type=\"button\" class=\"command-button\" data-palette>", icon("search"), "<span>Go to</span><kbd>⌘K</kbd></button></div></header>",
    options.split ? body : h("<div class=\"content\">", body, "</div>"),
    "</div></div></div>",
    palette(),
  );
}

function factoryPageKey() {
  const parts = segments();
  if (parts[0] !== "app" || parts[1] !== "factories" || !parts[2]) return null;
  if (parts[2] === "new") return { id: "new", page: "wizard" };
  return { id: parts[2], page: parts[3] ?? "dashboard" };
}

function factorySubnav(id, page) {
  const items = [
    ["dashboard", "Dashboard", ""],
    ["activity", "Activity", "/activity"],
    ["runs", "Runs", "/runs"],
    ["agents", "Agents", "/agents"],
    ["automations", "Automations", "/automations"],
    ["scorers", "Scorers", "/scorers"],
    ["self-improvement", "Self-improvement", "/self-improvement"],
    ["definition", "Definition", "/definition"],
  ];
  return h(
    "<div class=\"subnav\">",
    items.map(([key, label, suffix]) => h("<a class=\"", page === key ? "active" : "", "\" href=\"/app/factories/", esc(id), suffix, "\">", label, "</a>")).join(""),
    "</div>",
  );
}

function factoryPages() {
  const key = factoryPageKey();
  if (!key) {
    if (state.factoryError === "unauthorized") return appShell("Factories", "<p>Sign in to list factories.</p>");
    if (state.factoryError === "forbidden") return appShell("Factories", "<p>You do not have access to factories in this organization.</p>");
    if (state.factoryError === "unavailable") return appShell("Factories", "<p>The control plane API is unavailable.</p>");
    return appShell("Factories", state.factories.length
      ? h("<p><a class=\"button primary\" href=\"/app/factories/new\">New factory</a></p>", state.factories.map((factory) => h("<a class=\"run-row\" href=\"/app/factories/", esc(factory.factoryId), "\"><div class=\"row-main\"><strong>", esc(factory.name), "</strong><span>", esc(factory.status), "</span></div></a>")).join(""))
      : "<p>No factories yet.</p><p><a class=\"button primary\" href=\"/app/factories/new\">Create a factory</a></p>");
  }
  if (key.id === "new") {
    return appShell("New factory", h(
      "<p class=\"muted\">Writes a starter <code>.tinkerbot</code> tree on the control plane. Agents and automations stay git-edited. Hosted inference is included on your plan.</p>",
      state.wizardNotice ? h("<p>", esc(state.wizardNotice), "</p>") : "",
      "<form data-factory-create>",
      "<p><label>Name <input name=\"name\" required placeholder=\"payments\" /></label></p>",
      "<p><label>Owner <input name=\"owner\" required placeholder=\"acme\" /></label></p>",
      "<p><label>Repository <input name=\"repository\" required placeholder=\"payments\" /></label></p>",
      "<p><button class=\"button primary\" type=\"submit\">Create factory</button></p>",
      "</form>",
    ));
  }
  const view = state.factoryView;
  const factory = view?.factory ?? state.factories.find((item) => item.factoryId === key.id);
  if (!factory) return appShell(key.id, "<p>Factory not found.</p>");
  return appShell(factory.name ?? key.id, h(factorySubnav(key.id, key.page), factoryPageBody(key.page, view)));
}

function factoryPageBody(page, view) {
  if (!view) return "<p class=\"muted\">Factory definition is read from git. Run <code>tb factory sync</code> after you change agents, automations, or runners.</p>";
  if (page === "activity") {
    const columns = ACTIVITY_ORDER.map((column) => ({ column, items: (view.activity ?? []).filter((item) => item.column === column) }));
    return h(
      "<p class=\"muted\">Work items for this factory. Org Inbox stays exception-first. Steer lives on the work-order page. Agents never merge.</p>",
      "<div class=\"inbox-grid factory-activity\">",
      columns.map((col) => h(
        "<section class=\"inbox-group\"><h2>", ACTIVITY_TITLES[col.column], "</h2>",
        col.items.length ? col.items.map((order) => h("<a class=\"run-row\" href=\"/app/work/", esc(order.workOrderId), "\"><div class=\"row-main\"><strong>", esc(order.issueOrPullRequest || order.intent || order.workOrderId), "</strong><span>", esc(order.status), "</span></div></a>")).join("") : "<p class=\"muted\">None.</p>",
        "</section>",
      )).join(""),
      "</div>",
    );
  }
  if (page === "runs") {
    return (view.runs ?? []).length
      ? view.runs.map((run) => h("<a class=\"run-row\" href=\"/app/work/", esc(run.work_order_id || run.workOrderId || ""), "\"><div class=\"row-main\"><strong>", esc(run.run_id || run.runId), "</strong><span>", esc(run.status), "</span></div></a>")).join("")
      : "<p>No factory runs yet.</p>";
  }
  if (page === "agents") {
    return (view.agents ?? []).length
      ? view.agents.map((agent) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(agent.id), "</strong><span>", esc(agent.agentType || agent.harness || ""), " · ", esc(agent.model || ""), "</span></div></div>")).join("")
      : "<p>No agents in the synced definition.</p>";
  }
  if (page === "automations") {
    return (view.automations ?? []).length
      ? view.automations.map((automation) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(automation.name), "</strong><span>", automation.enabled === false ? "off" : "on", " · ", esc(automation.agent || "foreman"), "</span></div></div>")).join("")
      : "<p>No automations. Add <code>.tinkerbot/automations/&lt;name&gt;/automation.md</code> and sync.</p>";
  }
  if (page === "scorers") {
    return h(
      "<p class=\"muted\">Scorers classify completed conversations. They never upgrade a <code>tb check</code> verdict.</p>",
      (view.scorers ?? []).length
        ? view.scorers.map((scorer) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(scorer.name), "</strong><span>", esc(scorer.criteria), " · cannot upgrade verdict</span></div></div>")).join("")
        : "<p>No scorers configured.</p>",
    );
  }
  if (page === "self-improvement") {
    return h(
      "<p class=\"muted\">Follow-up tasks from Scorer failures. Auto-merge is forbidden. Steward cannot self-approve.</p>",
      (view.selfImprovement ?? []).length
        ? view.selfImprovement.map((task) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(task.title), "</strong><span>", esc(task.status || "open"), " · auto-merge forbidden</span></div></div>")).join("")
        : "<p>No self-improvement tasks.</p>",
    );
  }
  if (page === "definition") {
    const files = view.definitionFiles ?? [];
    return files.length
      ? h("<p class=\"muted\">Read-only tree from the last sync. Edit in git.</p>", files.map((file) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(file.path), "</strong><span>", esc(String(file.contents || "").split("\n")[0] || ""), "</span></div></div>")).join(""))
      : "<p>No definition files synced. Run <code>tb factory sync</code>.</p>";
  }
  const metrics = view.metrics ?? {};
  return h(
    "<p class=\"muted\">", esc(metrics.caption || "Opened and waiting work. Hosted inference included on your plan. tb check remains the verdict. Humans merge."), "</p>",
    "<div class=\"metric-row\">",
    "<div class=\"run-row\"><div class=\"row-main\"><strong>PRs opened (estimate)</strong><span>", esc(metrics.opened ?? 0), "</span></div></div>",
    "<div class=\"run-row\"><div class=\"row-main\"><strong>PRs merged</strong><span>", esc(metrics.merged ?? 0), "</span></div></div>",
    "<div class=\"run-row\"><div class=\"row-main\"><strong>Blocked work</strong><span>", esc(metrics.blocked ?? 0), "</span></div></div>",
    "<div class=\"run-row\"><div class=\"row-main\"><strong>Waiting</strong><span>", esc(metrics.waiting ?? 0), "</span></div></div>",
    "<div class=\"run-row\"><div class=\"row-main\"><strong>Autonomy</strong><span>", metrics.autonomyShare == null ? "Needs GitHub App merge history" : esc(metrics.autonomyShare), "</span></div></div>",
    "</div>",
    "<p>Status ", esc(view.factory?.status || ""), ". Alias ", esc(view.factory?.alias || "unset"), ". Skills stay versioned. The Steward cannot silently rewrite factory rules.</p>",
  );
}

function palette() {
  if (!state.paletteOpen) return "";
  const q = state.paletteQuery.trim().toLowerCase();
  const items = [
    { href: "/app", label: "Inbox", hint: "Control tower" },
    { href: "/app/work", label: "Work", hint: "Work orders" },
    { href: "/app/products", label: "Products" },
    { href: "/app/factories", label: "Factories" },
    { href: "/app/factories/new", label: "New factory", hint: "Starter tree" },
    { href: "/app/releases", label: "Releases" },
    { href: "/app/evolution", label: "Evolution" },
    { href: "/app/settings", label: "Settings" },
    { href: "/app/settings/billing", label: "Billing" },
    { href: "/app/settings/github", label: "GitHub settings" },
    { href: "/app/settings/gitlab", label: "GitLab settings" },
    { href: "/app/settings/export", label: "Evidence export" },
    { href: "/app/settings/api", label: "API" },
    { href: "/app/usage", label: "Usage" },
    ...state.workOrders.map((order) => ({ href: `/app/work/${order.workOrderId}`, label: order.issueOrPullRequest || order.workOrderId, hint: order.repositoryId })),
    ...state.factories.map((factory) => ({ href: `/app/factories/${factory.factoryId}`, label: factory.name, hint: "Factory" })),
  ].filter((item) => !q || `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(q));
  const index = Math.min(state.paletteIndex, Math.max(0, items.length - 1));
  return h(
    "<div class=\"overlay\" data-palette-dismiss><div class=\"palette\" role=\"dialog\" aria-label=\"Command menu\">",
    "<input class=\"palette-input\" data-palette-input value=\"", esc(state.paletteQuery), "\" placeholder=\"Go to inbox, work, settings…\" />",
    "<div class=\"palette-list\">",
    items.map((item, i) => h("<a class=\"palette-item", i === index ? " selected" : "", "\" href=\"", item.href, "\"><strong>", esc(item.label), "</strong><span>", esc(item.hint ?? ""), "</span></a>")).join("") || "<p class=\"muted\" style=\"padding:12px\">No matches.</p>",
    "</div></div></div>",
  );
}

function towerGroup(order) {
  if (order.group) return order.group;
  if (order.status === "blocked") return "blocked";
  if (order.status === "failed" || order.status === "unknown") return "needs_attention";
  if (order.status === "approval" || order.status === "ready" || order.status === "specification") return "waiting_for_approval";
  if (order.status === "merged" || order.status === "released" || order.status === "cancelled") return "completed";
  return "in_progress";
}

function groupOrders(orders) {
  const groups = { needs_attention: [], in_progress: [], waiting_for_approval: [], blocked: [], completed: [] };
  for (const order of orders) (groups[towerGroup(order)] ?? groups.in_progress).push(order);
  return groups;
}

function visibleOrderIds() {
  if (pathName() === "/app") return GROUP_ORDER.flatMap((key) => groupOrders(state.workOrders)[key].map((order) => order.workOrderId));
  return state.workOrders.map((order) => order.workOrderId);
}

function orderRow(order) {
  const id = order.workOrderId;
  const selected = state.selectedIds.has(id) ? " selected" : "";
  const focused = state.focusedId === id ? " focused" : "";
  return h(
    "<div class=\"run-row", selected, focused, "\" data-work-id=\"", esc(id), "\" data-group=\"", esc(towerGroup(order)), "\" role=\"option\" aria-selected=\"", state.selectedIds.has(id) ? "true" : "false", "\">",
    "<div class=\"row-main\"><a href=\"/app/work/", esc(id), "\"><strong>", esc(order.issueOrPullRequest || id), "</strong></a>",
    "<span>", esc(order.repositoryId), " · ", esc(order.lineId || order.currentStage), " · ", esc(order.status), order.autonomyMode ? ` · ${order.autonomyMode}` : "", "</span></div></div>",
  );
}

function selectionBar() {
  if (!state.selectedIds.size) return "";
  const selected = state.workOrders.filter((order) => state.selectedIds.has(order.workOrderId));
  const canApprove = selected.every((order) => order.status === "specification");
  return h(
    "<div class=\"selection-bar\">",
    "<span>", String(state.selectedIds.size), " selected</span>",
    "<button type=\"button\" class=\"button small\" data-bulk=\"take\">Take cell</button>",
    "<button type=\"button\" class=\"button small\" data-bulk=\"return\">Return cell</button>",
    canApprove ? "<button type=\"button\" class=\"button small\" data-bulk=\"approve\">Approve spec</button>" : "",
    "</div>",
  );
}

function inbox() {
  if (state.workError === "unauthorized") return h("<div class=\"page-heading\"><div><h1>Inbox</h1><p>Sign in required.</p></div></div>");
  if (state.workError === "forbidden") return h("<div class=\"page-heading\"><div><h1>Inbox</h1><p>You do not have access to this organization inbox.</p></div></div>");
  if (state.workError === "unavailable") return h("<div class=\"page-heading\"><div><h1>Inbox</h1><p>The control plane API is unavailable.</p></div></div>");
  const groups = groupOrders(state.workOrders);
  return h(
    "<div class=\"page-heading\"><div><h1>Inbox</h1><p>Exception-first. Not a kanban.</p></div></div>",
    selectionBar(),
    "<div class=\"inbox\">",
    GROUP_ORDER.map((key) => h(
      "<section class=\"attention-list\" data-inbox-group=\"", key, "\"><h2>", GROUP_TITLES[key], "</h2>",
      groups[key].length ? groups[key].map(orderRow).join("") : "<p class=\"muted\">None</p>",
      "</section>",
    )).join(""),
    "</div>",
  );
}

function workDetail(order) {
  if (!order) return "<div class=\"work-detail-pane\"><p class=\"muted\">Select a work order.</p></div>";
  return h(
    "<div class=\"work-detail-pane\">",
    "<div class=\"page-heading\"><div><h1>", esc(order.issueOrPullRequest || order.workOrderId), "</h1>",
    "<p>", esc(order.repositoryId), " · line ", esc(order.lineId || "unrouted"), " · ", esc(order.status), " · ", esc(order.currentStage), " · autonomy ", esc(order.autonomyMode || "approval_gated"), "</p></div></div>",
    "<p>Producing: ", esc(order.outputKind || "pr"), ". Blocking: ", esc(order.status === "blocked" ? (order.heldBy ? "human hold" : "action required") : "none"), ". Next: ", esc(order.status === "specification" ? "human spec approval" : order.status === "approval" ? "human merge" : order.currentStage), ".</p>",
    "<p>", esc(order.intent ?? order.issueOrPullRequest ?? "No intent recorded."), "</p>",
    "<form data-steer=\"", esc(order.workOrderId), "\"><textarea name=\"note\" placeholder=\"Steer the Foreman\"></textarea><button type=\"submit\" class=\"button\">Steer</button></form>",
    "<div class=\"page-actions\">",
    order.status === "specification" ? h("<button class=\"button\" data-approve=\"", esc(order.workOrderId), "\">Approve spec</button>") : "",
    "<button class=\"button\" data-take=\"", esc(order.workOrderId), "\">Take cell</button> <button class=\"button\" data-return=\"", esc(order.workOrderId), "\">Return cell</button>",
    "</div></div>",
  );
}

function workSplit(selectedId) {
  if (state.workError === "unauthorized") return "<p>Sign in required.</p>";
  if (state.workError === "forbidden") return "<p>You do not have access to work orders in this organization.</p>";
  if (state.workError === "unavailable") return "<p>The control plane API is unavailable.</p>";
  const order = state.workOrders.find((item) => item.workOrderId === selectedId);
  return h(
    "<div class=\"work-split\">",
    "<div class=\"work-list-pane\" role=\"listbox\">", selectionBar(), state.workOrders.length ? state.workOrders.map(orderRow).join("") : "<p class=\"muted\">No work orders.</p>", "</div>",
    workDetail(order),
    "</div>",
  );
}

function settingsNav() {
  const items = [
    ["/app/settings", "General"],
    ["/app/settings/members", "Members"],
    ["/app/settings/billing", "Billing"],
    ["/app/settings/github", "GitHub"],
    ["/app/settings/gitlab", "GitLab"],
    ["/app/settings/sso", "SSO"],
    ["/app/settings/api", "API"],
    ["/app/settings/export", "Evidence export"],
    ["/app/settings/notifications", "Notifications"],
    ["/app/settings/roles", "Roles"],
    ["/app/settings/audit", "Audit"],
  ];
  return h("<nav class=\"settings-nav\">", items.map(([href, label]) => h("<a class=\"settings-link", pathName() === href ? " active" : "", "\" href=\"", href, "\">", esc(label), "</a>")).join(""), "</nav>");
}

function settingsShell(title, body) {
  return h("<div class=\"settings-layout\">", settingsNav(), "<section class=\"settings-panel\"><h1>", esc(title), "</h1>", body, "</section></div>");
}

function settingsPage() {
  const path = pathName();
  if (path === "/app/settings/members") {
    const seats = state.seats?.activeBillableSeats ?? "—";
    return settingsShell("Members", h("<p>Humans with enabled membership are billable seats. Service credentials are not seats.</p><div class=\"billing-fact\"><span>Active seats</span><strong>", esc(String(seats)), "</strong></div>"));
  }
  if (path === "/app/settings/billing") {
    const planId = state.billing?.planId ?? state.billing?.account?.planId ?? "free";
    const status = state.billing?.subscriptionState ?? state.billing?.account?.status ?? "free";
    const seats = state.billing?.activeBillableSeats ?? 0;
    const price = state.billing?.pricePerSeatCents != null ? `$${(Number(state.billing.pricePerSeatCents) / 100).toFixed(0)}` : "—";
    const trial = state.billing?.trialState ? h("<p>Trial ", esc(state.billing.trialState), state.billing.trialEndsAt ? h(" until ", esc(state.billing.trialEndsAt)) : "", "</p>") : "";
    return settingsShell("Billing", state.billing ? h(
      "<div class=\"billing-facts\">",
      "<div class=\"billing-fact\"><span>Plan</span><strong>", esc(planId), "</strong></div>",
      "<div class=\"billing-fact\"><span>Status</span><strong>", esc(status), "</strong></div>",
      "<div class=\"billing-fact\"><span>Active seats</span><strong>", esc(String(seats)), "</strong></div>",
      "<div class=\"billing-fact\"><span>Price per seat</span><strong>", esc(price), "</strong></div></div>",
      trial,
      state.billingNotice ? h("<p>", esc(state.billingNotice), "</p>") : "",
      "<p>Paid seat and repository caps: none. Quantity is synchronized from active human members.</p>",
      "<p><button class=\"button\" data-billing=\"trial\">Start Team trial</button> <button class=\"button\" data-billing=\"portal\">Open billing portal</button></p>",
    ) : h("<p>Billing summary unavailable.</p>", state.billingNotice ? h("<p>", esc(state.billingNotice), "</p>") : ""));
  }
  if (path === "/app/settings/github") {
    const rows = state.github?.installations ?? [];
    return settingsShell("GitHub", h(
      "<p>Install the Tinkerbot GitHub App to connect repositories. Fork pull requests stay write-disabled. Agents never merge.</p>",
      rows.length ? rows.map((row) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(row.account_login || row.installation_id), "</strong><span>", esc(row.status), "</span></div></div>")).join("") : "<p class=\"muted\">No GitHub App installation returned for this organization.</p>",
      "<p><a class=\"button\" href=\"/github/install\">Install GitHub App</a></p>",
    ));
  }
  if (path === "/app/settings/gitlab") {
    return settingsShell("GitLab", h(
      "<p>Connect GitLab to start work from merge requests and issues. Job, pipeline, deployment, and system hooks are rejected. Tinkerbot never merges a GitLab MR.</p>",
      "<p>Webhook endpoint: <code>", esc((apiBase() || window.location.origin) + "/integrations/gitlab/webhook"), "</code></p>",
      "<p>Optional GitLab CI OIDC is a peer of GitHub Actions for <code>tb check</code> ingest only.</p>",
    ));
  }
  if (path === "/app/settings/sso") {
    return settingsShell("SSO", "<p>SSO and SCIM are Business entitlements. Connections are stored for your organization and used at log in.</p>");
  }
  if (path === "/app/settings/api") {
    return settingsShell("API", h("<p>Service credentials are hashed tokens, not billable seats. Create and revoke them on the Worker; this page does not mint vendor OAuth.</p><p>MCP endpoint: <code>", esc((apiBase() || window.location.origin) + "/mcp"), "</code></p><p>MCP <code>create_factory</code> writes the same starter tree as this wizard. Agents stay git-edited.</p>"));
  }
  if (path === "/app/settings/export") {
    return settingsShell("Evidence export", "<p>Evidence stays in your organization. Optional object-storage fan-out is configured by operators. Export failure does not change a <code>tb check</code> verdict.</p>");
  }
  if (path === "/app/settings/notifications") {
    return settingsShell("Notifications", "<p>Slack and Teams incoming webhooks are organization settings. They do not change verification verdicts.</p>");
  }
  if (path === "/app/settings/roles") {
    return settingsShell("Roles", "<p>Custom roles are a Business entitlement. Owner and admin retain billing and policy authority.</p>");
  }
  if (path === "/app/settings/audit") {
    return settingsShell("Audit", "<p>Audit export is a Business entitlement. Historical reads remain available during grace; paid mutations do not.</p>");
  }
  return settingsShell("Settings", h("<p>Organization <strong>", esc(state.session?.organizationId ?? ""), "</strong>. Switch from the sidebar workspace menu.</p>"));
}

function evidencePage(runId) {
  if (state.evidenceError === "unauthorized") return "<p>Sign in required.</p>";
  if (state.evidenceError === "forbidden") return "<p>You do not have access to evidence in this organization.</p>";
  if (state.evidenceError === "unavailable") return "<p>The control plane API is unavailable.</p>";
  const failed = state.workOrders.filter((order) => order.status === "failed" || order.status === "unknown");
  if (runId) return h("<p>Run <code>", esc(runId), "</code>. Absent evidence remains UNKNOWN. AI cannot rewrite verdicts.</p>");
  return h(
    "<p>Findings are attached to work-order runs. Absent evidence remains UNKNOWN. AI cannot rewrite verdicts.</p>",
    failed.length ? failed.map((order) => h("<a class=\"run-row\" href=\"/app/work/", esc(order.workOrderId), "\"><div class=\"row-main\"><strong>", esc(order.issueOrPullRequest || order.workOrderId), "</strong><span>", esc(order.status), " · UNKNOWN-safe</span></div></a>")).join("") : "<p class=\"muted\">No failed or unknown runs.</p>",
  );
}

function appPage() {
  const parts = segments();
  const path = pathName();
  if (path === "/app/plan") {
    const plans = state.plans ?? [];
    return appShell("Plan", plans.length
      ? plans.map((plan) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(plan.planId), "</strong><span>", esc(plan.selectedPipeline), " · skip ", esc((plan.skip || []).join(",") || "none"), "</span></div></div>")).join("")
      : "<p>No local execution plans. Run <code>tb factory plan</code> or <code>tb run --local</code>. Verification is never skipped.</p>");
  }
  if (path === "/app/cost") {
    const costs = state.costs ?? [];
    return appShell("Cost", h(
      "<p class=\"muted\">Tinkerbot invoices seats only. BYOK spend is billed by your provider, not Tinkerbot.</p>",
      costs.length ? costs.map((row) => {
        const estimate = row.estimate ?? {};
        const byok = estimate.byokSpendCents != null ? ` · BYOK ${estimate.byokSpendCents}¢ (${estimate.byokNote || "billed by your provider"})` : "";
        return h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(row.planId), "</strong><span>", esc(estimate.platformInvoice || "seats_only"), byok, "</span></div></div>");
      }).join("") : "<p>No cost estimates yet.</p>",
    ));
  }
  if (path === "/app/eval") {
    const compare = state.evalCompare ?? { improved: [], regressed: [], unchanged: [], upgradesVerdict: false };
    return appShell("Eval", h(
      "<p class=\"muted\">Scorers cannot upgrade <code>tb check</code>. upgradesVerdict=", esc(String(compare.upgradesVerdict)), "</p>",
      "<p>Improved ", esc(String(compare.improved.length)), " · regressed ", esc(String(compare.regressed.length)), " · unchanged ", esc(String(compare.unchanged.length)), "</p>",
    ));
  }
  if (path === "/app/settings" || path.startsWith("/app/settings/")) return appShell("Settings", settingsPage());
  if (path === "/app/usage") {
    return appShell("Usage", h("<p>Token and run counts are fair-use telemetry. They are not invoiced. Billing is per active human seat.</p>", state.usage.length ? `<table class="data-table">${state.usage.map((row) => `<tr><td>${esc(row.kind)}</td><td>${esc(row.tokens)}</td><td>${esc(row.createdAt || "")}</td></tr>`).join("")}</table>` : "<p>No usage events.</p>"));
  }
  if (path === "/app/products" || parts[1] === "products") {
    const id = parts[2];
    const product = state.products.find((item) => (item.name || item.productId) === id);
    if (id) return appShell(product?.name ?? id, product ? h("<p>Risk class: ", esc(product.risk_class || product.riskClass || "unspecified"), "</p>") : "<p>Product not found.</p>");
    return appShell("Products", state.products.length ? state.products.map((item) => h("<a class=\"run-row\" href=\"/app/products/", esc(item.name || item.productId), "\"><div class=\"row-main\"><strong>", esc(item.name), "</strong><span>", esc(item.risk_class || item.riskClass || ""), "</span></div></a>")).join("") : "<p>No products mapped yet.</p>");
  }
  if (path === "/app/factories" || parts[1] === "factories") return factoryPages();
  if (path === "/app/cells") {
    return appShell("Lines and work cells", state.cells.length ? state.cells.map((cell) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(cell.repository), " ", esc(cell.branch), "</strong><span>", esc(cell.status), " · ", esc(cell.kind), "</span></div></div>")).join("") : "<p>No leased work cells.</p>");
  }
  if (path === "/app/releases" || parts[1] === "releases") {
    const id = parts[2];
    const release = state.releases.find((item) => (item.release_id || item.releaseId) === id);
    const candidates = state.releases.length ? state.releases.map((item) => h("<a class=\"run-row\" href=\"/app/releases/", esc(item.release_id || item.releaseId), "\"><div class=\"row-main\"><strong>", esc(item.release_id || item.releaseId), "</strong><span>", esc(item.status), " · ", esc(item.commit_sha || item.commitSha || ""), "</span></div></a>")).join("") : "<p>No release candidates.</p>";
    const outcomes = state.outcomes.length ? state.outcomes.map((item) => h("<div class=\"run-row\"><div class=\"row-main\"><strong>", esc(item.kind), "</strong><span>", esc(item.association), "</span></div></div>")).join("") : "<p>No post-release outcomes recorded.</p>";
    if (id) return appShell(release?.release_id || id, release ? h("<p>Status ", esc(release.status), ". Humans merge. Agents cannot merge.</p>") : "<p>Release not found.</p>");
    return appShell("Releases", h(
      "<div class=\"subnav\"><a class=\"", state.releasesTab === "candidates" ? "active" : "", "\" href=\"/app/releases\" data-releases-tab=\"candidates\">Candidates</a><a class=\"", state.releasesTab === "outcomes" ? "active" : "", "\" href=\"/app/releases\" data-releases-tab=\"outcomes\">Outcomes</a></div>",
      state.releasesTab === "outcomes" ? outcomes : candidates,
    ));
  }
  if (path === "/app/evidence" || parts[1] === "evidence") return appShell("Evidence", evidencePage(parts[2]));
  if (path === "/app/evolution" || parts[1] === "evolution") {
    const id = parts[2];
    const proposal = state.proposals.find((item) => (item.proposal_id || item.proposalId) === id);
    if (id) {
      return appShell(proposal?.title ?? id, proposal ? h("<p>", esc(proposal.status), " · auto-merge forbidden</p><p>", esc(proposal.evidence_json || ""), "</p><button class=\"button\" data-evolution=\"", esc(proposal.proposal_id || proposal.proposalId), "\">Approve</button>") : "<p>Proposal not found.</p>");
    }
    return appShell("Evolution", state.proposals.length ? state.proposals.map((item) => h("<div class=\"run-row\"><div class=\"row-main\"><a href=\"/app/evolution/", esc(item.proposal_id || item.proposalId), "\"><strong>", esc(item.title), "</strong></a><span>", esc(item.status), " · auto-merge forbidden</span></div>", item.proposal_id || item.proposalId ? h("<button data-evolution=\"", esc(item.proposal_id || item.proposalId), "\">Approve</button>") : "", "</div>")).join("") : "<p>No improvement proposals. The Steward cannot silently rewrite factory rules.</p>");
  }
  if (path === "/app/work" || parts[1] === "work") {
    const id = parts[2] ?? state.focusedId ?? state.workOrders[0]?.workOrderId;
    if (parts[2] && state.focusedId !== parts[2]) state.focusedId = parts[2];
    return appShell("Work", workSplit(id), { split: true });
  }
  return appShell("Inbox", inbox());
}

function render() {
  const canonical = canonicalHref();
  if (canonical !== pathName() + window.location.search) {
    window.history.replaceState({}, "", canonical);
  }
  const path = pathName();
  if (path.startsWith("/app")) {
    if (!signedIn()) {
      app.innerHTML = publicPage();
      return;
    }
    app.innerHTML = appPage();
    const input = app.querySelector("[data-palette-input]");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    const focused = app.querySelector(".run-row.focused");
    focused?.scrollIntoView({ block: "nearest" });
    return;
  }
  app.innerHTML = publicPage();
}

function loadStatus(error) {
  if (error?.status === 401) return "unauthorized";
  if (error?.status === 403) return "forbidden";
  return "unavailable";
}

async function load() {
  try {
    const session = await api("/auth/session");
    state.session = session?.authenticated || localAdapter() ? { ...session, authenticated: true, organizationId: session?.organizationId ?? "local" } : null;
  } catch {
    state.session = localAdapter() ? { authenticated: true, organizationId: "local", user: { email: "local@tinkerbot" } } : null;
  }
  if (localAdapter()) {
    const runtime = await api("/local/runtime").catch(() => ({ plans: [], costs: [], evals: [], evalCompare: { improved: [], regressed: [], unchanged: [], upgradesVerdict: false }, workOrders: [] }));
    state.plans = runtime.plans ?? [];
    state.costs = runtime.costs ?? [];
    state.evals = runtime.evals ?? [];
    state.evalCompare = runtime.evalCompare ?? { improved: [], regressed: [], unchanged: [], upgradesVerdict: false };
    state.workOrders = runtime.workOrders ?? [];
    state.factories = [{ factoryId: "local-factory", name: "local", status: "active" }];
    render();
    return;
  }
  if (signedIn()) {
    state.workError = null;
    state.factoryError = null;
    state.evidenceError = null;
    const [factories, workOrders, products, cells, skills, proposals, releases, outcomes, usage, billing, organizations, seats, github] = await Promise.all([
      api("/factories").catch((error) => { state.factoryError = loadStatus(error); return { factories: [] }; }),
      api("/work-orders").catch((error) => { state.workError = loadStatus(error); return { workOrders: [] }; }),
      api("/products").catch(() => ({ products: [] })),
      api("/cells").catch(() => ({ cells: [] })),
      api("/skills").catch(() => ({ skills: [] })),
      api("/evolution").catch(() => ({ proposals: [] })),
      api("/releases").catch(() => ({ releases: [] })),
      api("/outcomes").catch(() => ({ outcomes: [] })),
      api("/usage").catch(() => ({ usage: [] })),
      api("/billing/summary").catch(() => null),
      api("/tenant/organizations").catch(() => ({ organizations: [] })),
      api("/org/seats").catch(() => null),
      api("/integrations/github").catch(() => null),
    ]);
    state.evidenceError = state.workError;
    state.factories = factories.factories ?? [];
    state.workOrders = workOrders.workOrders ?? [];
    state.products = products.products ?? [];
    state.cells = cells.cells ?? [];
    state.skills = skills.skills ?? [];
    state.proposals = proposals.proposals ?? [];
    state.releases = releases.releases ?? [];
    state.outcomes = outcomes.outcomes ?? [];
    state.usage = usage.usage ?? [];
    state.billing = billing;
    state.organizations = organizations.organizations ?? [];
    state.seats = seats;
    state.github = github;
    const factoryKey = factoryPageKey();
    if (factoryKey && factoryKey.id !== "new") {
      state.factoryView = await api(`/factories/${factoryKey.id}`).catch(() => null);
    } else {
      state.factoryView = null;
    }
    const ids = new Set(state.workOrders.map((order) => order.workOrderId));
    state.selectedIds = new Set([...state.selectedIds].filter((id) => ids.has(id)));
    if (state.focusedId && !ids.has(state.focusedId)) state.focusedId = null;
  }
  render();
}

function rangeSelect(targetId, ordered) {
  const anchor = state.anchorId ?? state.focusedId ?? targetId;
  const start = ordered.indexOf(anchor);
  const end = ordered.indexOf(targetId);
  if (start < 0 || end < 0) {
    state.selectedIds = new Set([targetId]);
    return;
  }
  const [from, to] = start < end ? [start, end] : [end, start];
  state.selectedIds = new Set(ordered.slice(from, to + 1));
  state.anchorId = anchor;
  state.focusedId = targetId;
}

function moveFocus(delta, twoD, shift) {
  const ordered = visibleOrderIds();
  if (!ordered.length) return;
  if (twoD && pathName() === "/app") {
    const groups = groupOrders(state.workOrders);
    const columns = GROUP_ORDER.map((key) => groups[key].map((order) => order.workOrderId));
    let gi = 0;
    let ri = 0;
    columns.forEach((col, i) => {
      const idx = col.indexOf(state.focusedId);
      if (idx >= 0) { gi = i; ri = idx; }
    });
    if (delta === "left") gi = Math.max(0, gi - 1);
    if (delta === "right") gi = Math.min(columns.length - 1, gi + 1);
    if (delta === "up") ri -= 1;
    if (delta === "down") ri += 1;
    while (gi >= 0 && gi < columns.length && !columns[gi].length) gi += delta === "left" ? -1 : 1;
    const col = columns[gi] ?? [];
    if (!col.length) return;
    ri = Math.max(0, Math.min(col.length - 1, ri));
    const next = col[ri];
    if (shift) rangeSelect(next, ordered);
    else { state.focusedId = next; state.anchorId = next; }
    render();
    return;
  }
  const current = Math.max(0, ordered.indexOf(state.focusedId));
  const nextIndex = Math.max(0, Math.min(ordered.length - 1, current + (delta === "up" || delta === "left" || delta === -1 ? -1 : 1)));
  const next = ordered[nextIndex];
  if (shift) rangeSelect(next, ordered);
  else { state.focusedId = next; state.anchorId = next; }
  render();
}

function typingTarget(event) {
  const tag = event.target?.closest?.("input, textarea, [contenteditable=true]");
  return Boolean(tag);
}

document.addEventListener("click", (event) => {
  const paletteDismiss = event.target.closest("[data-palette-dismiss]");
  if (paletteDismiss && event.target === paletteDismiss) {
    state.paletteOpen = false;
    render();
    return;
  }
  if (event.target.closest("[data-palette]")) {
    event.preventDefault();
    state.paletteOpen = true;
    render();
    return;
  }
  if (event.target.closest("[data-org-menu]")) {
    event.preventDefault();
    state.orgMenu = !state.orgMenu;
    render();
    return;
  }
  const orgSwitch = event.target.closest("[data-org-switch]");
  if (orgSwitch) {
    event.preventDefault();
    void api("/tenant/organizations/switch", "POST", { organizationId: orgSwitch.getAttribute("data-org-switch") }).then(() => {
      try { window.localStorage.setItem("tinkerbot.organizationId", orgSwitch.getAttribute("data-org-switch") || ""); } catch { /* persist is best-effort */ }
      return load();
    });
    return;
  }
  const releasesTab = event.target.closest("[data-releases-tab]");
  if (releasesTab) {
    event.preventDefault();
    state.releasesTab = releasesTab.getAttribute("data-releases-tab");
    render();
    return;
  }
  const bulk = event.target.closest("[data-bulk]");
  if (bulk) {
    event.preventDefault();
    const action = bulk.getAttribute("data-bulk");
    const ids = [...state.selectedIds];
    void Promise.all(ids.map((id) => api(`/work-orders/${id}/${action}`, "POST", {}))).then(load);
    return;
  }
  const workRow = event.target.closest("[data-work-id]");
  if (workRow) {
    const id = workRow.getAttribute("data-work-id");
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelect(id, visibleOrderIds());
      render();
      return;
    }
    if (!event.target.closest("a, button")) {
      event.preventDefault();
      state.focusedId = id;
      state.selectedIds = new Set([id]);
      state.anchorId = id;
      navigate(`/app/work/${id}`);
      return;
    }
    state.focusedId = id;
    state.anchorId = id;
  }
  const approve = event.target.closest("[data-approve]");
  if (approve) {
    event.preventDefault();
    void api(`/work-orders/${approve.getAttribute("data-approve")}/approve`, "POST", {}).then(load);
    return;
  }
  const take = event.target.closest("[data-take]");
  if (take) {
    event.preventDefault();
    void api(`/work-orders/${take.getAttribute("data-take")}/take`, "POST", {}).then(load);
    return;
  }
  const ret = event.target.closest("[data-return]");
  if (ret) {
    event.preventDefault();
    void api(`/work-orders/${ret.getAttribute("data-return")}/return`, "POST", {}).then(load);
    return;
  }
  const evolution = event.target.closest("[data-evolution]");
  if (evolution) {
    event.preventDefault();
    void api(`/evolution/${evolution.getAttribute("data-evolution")}/approve`, "POST", {}).then(load);
    return;
  }
  const billing = event.target.closest("[data-billing]");
  if (billing) {
    event.preventDefault();
    const action = billing.getAttribute("data-billing");
    if (action === "trial") void api("/billing/trial/start", "POST", {}).then(() => { state.billingNotice = "Team trial started."; return load(); }).catch((error) => { state.billingNotice = error.message || "Trial could not start."; render(); });
    if (action === "portal") void api("/billing/portal", "POST", {}).then((result) => { if (result?.portal?.url) window.location.assign(result.portal.url); else { state.billingNotice = "Billing portal URL was not returned."; void load(); } }).catch((error) => { state.billingNotice = error.message || "Billing portal unavailable."; render(); });
    return;
  }
  const link = event.target.closest("a");
  if (!link || link.target === "_blank") return;
  const url = new URL(link.href, window.location.origin);
  if (url.origin !== window.location.origin) return;
  if (url.pathname.startsWith("/auth/")) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});

document.addEventListener("submit", (event) => {
  const create = event.target.closest("form[data-factory-create]");
  if (create) {
    event.preventDefault();
    const data = new FormData(create);
    const name = String(data.get("name") || "").trim();
    const owner = String(data.get("owner") || "").trim();
    const repository = String(data.get("repository") || "").trim();
    const yaml = ["schemaVersion: v1alpha1", `name: ${name}`, "repositories:", `  - owner: ${owner}`, `    name: ${repository}`, "agentDefaults:", "  model: auto", "  runner: sandbox", ""].join("\n");
    const files = [
      { path: ".tinkerbot/factory.yaml", contents: yaml },
      { path: ".tinkerbot/agents/foreman/agent.md", contents: "---\nagentType: FOREMAN\ndescription: Route work. Never merge. Never rewrite tb check.\n---\nYou are the Tinkerbot Foreman. Humans merge. tb check is the only verdict.\n" },
      { path: ".tinkerbot/runners/sandbox.yaml", contents: "name: sandbox\nplatform:\n  os: linux\n  linux:\n    dockerImage: cloudflare/sandbox:next\n" },
    ];
    void api("/factories", "POST", { name, yaml, files }).then((result) => {
      const id = result?.factory?.factoryId;
      state.wizardNotice = "Factory created. Edit agents in git and run tb factory sync.";
      if (id) navigate(`/app/factories/${id}`);
      else void load();
    }).catch((error) => { state.wizardNotice = error.message || "Factory create failed."; render(); });
    return;
  }
  const form = event.target.closest("form[data-steer]");
  if (!form) return;
  event.preventDefault();
  const note = form.querySelector("textarea")?.value ?? "";
  void api(`/work-orders/${form.getAttribute("data-steer")}/steer`, "POST", { note }).then(load);
});

document.addEventListener("input", (event) => {
  if (!event.target.matches?.("[data-palette-input]")) return;
  state.paletteQuery = event.target.value;
  state.paletteIndex = 0;
  render();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    state.paletteOpen = !state.paletteOpen;
    render();
    return;
  }
  if (state.paletteOpen) {
    if (event.key === "Escape") { state.paletteOpen = false; render(); }
    if (event.key === "ArrowDown") { event.preventDefault(); state.paletteIndex += 1; render(); }
    if (event.key === "ArrowUp") { event.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); render(); }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = document.querySelector(".palette-item.selected");
      if (selected) navigate(selected.getAttribute("href"));
    }
    return;
  }
  if (typingTarget(event) || !signedIn() || !pathName().startsWith("/app")) return;
  if (event.key === "Escape") { state.selectedIds = new Set(); render(); return; }
  if (event.key === "x" || event.key === "X") {
    event.preventDefault();
    const id = state.focusedId;
    if (!id) return;
    if (event.shiftKey) rangeSelect(id, visibleOrderIds());
    else if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else { state.selectedIds.add(id); state.anchorId = id; }
    render();
    return;
  }
  if (event.key === "Enter" && state.focusedId) {
    event.preventDefault();
    navigate(`/app/work/${state.focusedId}`);
    return;
  }
  if (event.key === "j" || event.key === "k") {
    event.preventDefault();
    moveFocus(event.key === "j" ? 1 : -1, false, event.shiftKey);
    if (pathName().startsWith("/app/work/") && state.focusedId) navigate(`/app/work/${state.focusedId}`, true);
    return;
  }
  if (event.key === "ArrowDown") { event.preventDefault(); moveFocus("down", pathName() === "/app", event.shiftKey); }
  if (event.key === "ArrowUp") { event.preventDefault(); moveFocus("up", pathName() === "/app", event.shiftKey); }
  if (event.key === "ArrowRight" && pathName() === "/app") { event.preventDefault(); moveFocus("right", true, event.shiftKey); }
  if (event.key === "ArrowLeft" && pathName() === "/app") { event.preventDefault(); moveFocus("left", true, event.shiftKey); }
});

window.addEventListener("popstate", render);
void load();
setInterval(() => { if (pathName().startsWith("/app") && signedIn()) void load(); }, 15_000);
