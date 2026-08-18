import { createDevelopmentAuth, safeReturnTo as safeAuthReturnTo } from "./auth.js";
import {
  findingById,
  findings,
  localReport,
  plans,
  repositories,
  repositoryById,
  runById,
  runs,
  setupTasks,
  workspace,
} from "./data.js";

const app = document.querySelector("#app");
const storage = (() => {
  try { return window.localStorage; } catch {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
  }
})();
const auth = createDevelopmentAuth(storage);
const h = (...parts) => parts.join("");

function icon(name, className = "") {
  return h("<svg class=\"ui-icon ", esc(className), "\" aria-hidden=\"true\" viewBox=\"0 0 24 24\"><use href=\"/assets/circle-icons.svg#", esc(name), "\"></use></svg>");
}

function iconButton(action, name, label, extra = "", className = "") {
  return h("<button type=\"button\" class=\"icon-button ", esc(className), "\" data-action=\"", esc(action), "\" aria-label=\"", esc(label), "\" ", extra, ">", icon(name), "</button>");
}

const state = {
  session: null,
  paletteOpen: false,
  accountMenu: false,
  orgMenu: false,
  sidebarOpen: true,
  mobileNav: false,
  selectedFindingId: null,
  toast: null,
  toastTimer: null,
  report: localReport,
  reportSource: "bundled preview report",
  hosted: {
    teamLoaded: false,
    teamLoading: false,
    invitations: [],
    error: null,
    inviteOpen: false,
    inviteSubmitting: false,
    inviteMessage: null,
    billingLoaded: false,
    billingLoading: false,
    billing: null,
    billingError: null,
    billingSubmitting: false,
  },
  filters: {
    findingQuery: "",
    findingSeverity: "all",
    findingStatus: "all",
    runQuery: "",
    runVerdict: "all",
  },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function currentPath() {
  return window.location.pathname || "/";
}

function currentSearch() {
  return new URLSearchParams(window.location.search);
}

function hostedApiBase() {
  const configured = typeof window.__TINKERBOT_CONTROL_PLANE_API__ === "string"
    ? window.__TINKERBOT_CONTROL_PLANE_API__
    : document.querySelector("meta[name=\"tinkerbot-api-base\"]")?.content ?? "";
  const value = configured.trim();
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function hostedRequest(path, init = {}) {
  const base = hostedApiBase();
  if (!base) throw new Error("Hosted control-plane API is not configured for this preview.");
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, base + "/").toString(), { ...init, credentials: "include", headers });
  let payload = null;
  try { payload = await response.json(); } catch { /* the status still communicates failure */ }
  if (!response.ok) throw new Error(payload?.error || `Hosted request failed with HTTP ${response.status}.`);
  return payload ?? {};
}

async function loadHostedTeam() {
  if (!hostedApiBase() || state.hosted.teamLoading || state.hosted.teamLoaded) return;
  state.hosted.teamLoading = true;
  state.hosted.error = null;
  renderCurrent();
  try {
    const result = await hostedRequest("/tenant/invitations");
    state.hosted.invitations = Array.isArray(result.invitations) ? result.invitations : [];
    state.hosted.teamLoaded = true;
  } catch (error) {
    state.hosted.error = error instanceof Error ? error.message : "Hosted team data could not be loaded.";
    state.hosted.teamLoaded = true;
  } finally {
    state.hosted.teamLoading = false;
    if (currentPath() === "/app/team") renderCurrent();
  }
}

async function loadHostedBilling(force = false) {
  if (!hostedApiBase() || state.hosted.billingLoading || (state.hosted.billingLoaded && !force)) return;
  state.hosted.billingLoading = true;
  state.hosted.billingError = null;
  renderCurrent();
  try {
    state.hosted.billing = await hostedRequest("/billing/summary");
  } catch (error) {
    state.hosted.billingError = error instanceof Error ? error.message : "Hosted billing data could not be loaded.";
  } finally {
    state.hosted.billingLoaded = true;
    state.hosted.billingLoading = false;
    if (currentPath() === "/app/settings/billing") renderCurrent();
  }
}

function safeReturnTo(value) {
  return safeAuthReturnTo(value);
}

function badge(value, tone = "neutral") {
  return h("<span class=\"status ", esc(tone), "\">", esc(value), "</span>");
}

function button(label, action, kind = "secondary", extra = "") {
  return h("<button type=\"button\" class=\"button ", esc(kind), "\" data-action=\"", esc(action), "\" ", extra, ">", label, "</button>");
}

const navIconByLabel = {
  Overview: "home",
  Repositories: "git",
  "Verification runs": "shield",
  Findings: "exclamation",
  Baselines: "archive",
  Policies: "settings",
  Team: "agents",
  Integrations: "plugin",
  "Change Sets": "git",
  Releases: "files",
  Outcomes: "checkmark",
  Settings: "settings",
};

function link(href, label, active = false, extra = "") {
  return h("<a class=\"nav-link", active ? " active" : "", "\" href=\"", esc(href), "\" ", extra, ">", icon(navIconByLabel[label] ?? "shield"), "<span class=\"nav-text\">", esc(label), "</span></a>");
}

function settingsLink(href, label, active = false, iconName = "settings", extra = "") {
  return h("<a class=\"settings-link", active ? " active" : "", "\" href=\"", esc(href), "\" ", active ? "aria-current=\"page\"" : "", " ", extra, ">", icon(iconName), "<span>", esc(label), "</span></a>");
}

function pageHeading(eyebrow, title, description = "", actions = "") {
  return h(
    "<div class=\"page-heading\"><div><div class=\"eyebrow\">",
    esc(eyebrow),
    "</div><h1>",
    esc(title),
    "</h1>",
    description ? h("<p>", esc(description), "</p>") : "",
    "</div>",
    actions ? h("<div class=\"page-actions\">", actions, "</div>") : "",
    "</div>",
  );
}

function previewBanner(title = "Hosted sync is not connected.", detail = "This local preview renders structured metadata and keeps provider-dependent actions visibly unavailable.") {
  return h("<div class=\"preview-banner\"><span class=\"preview-badge\">Preview</span><div><strong>", esc(title), "</strong>", esc(detail), "</div></div>");
}

function toastMarkup() {
  if (!state.toast) return "";
  return h("<div class=\"toast\" role=\"status\"><strong>", esc(state.toast.title), "</strong><span>", esc(state.toast.message), "</span>", iconButton("dismiss-toast", "x", "Dismiss message"), "</div>");
}

function showToast(title, message) {
  state.toast = { title, message };
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toast = null;
    renderCurrent();
  }, 5200);
  renderCurrent();
}

function commandPalette() {
  const items = [
    { href: "/app/overview", label: "Overview", detail: "Workspace health and attention" },
    { href: "/app/repositories", label: "Repositories", detail: "Connections and latest evidence" },
    { href: "/app/history", label: "Verification runs", detail: "Structured run summaries" },
    { href: "/app/findings", label: "Findings", detail: "Evidence, severity, and resolution" },
    { href: "/app/policies", label: "Policies", detail: "Workspace and repository controls" },
    { href: "/app/settings/billing", label: "Settings / Billing", detail: "Plan, usage, and provider status" },
    { href: "/local/report", label: "Local report viewer", detail: "Open a report without hosted auth" },
  ];
  return h(
    "<div class=\"overlay\" data-action=\"close-palette\" role=\"presentation\"><div class=\"palette\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Navigate\"><input class=\"palette-input\" data-palette-search autofocus placeholder=\"Search control plane\" aria-label=\"Search control plane\" /><div class=\"palette-list\">",
    items.map((item) => h("<a class=\"palette-item\" href=\"", esc(item.href), "\" data-palette-item data-search=\"", esc((item.label + " " + item.detail).toLowerCase()), "\">", icon("arrow-right"), "<span><strong>", esc(item.label), "</strong><span>", esc(item.detail), "</span></span></a>")).join(""),
    "</div></div></div>",
  );
}

function accountMenu() {
  if (!state.accountMenu) return "";
  const session = state.session;
  return h(
    "<div class=\"menu\" role=\"menu\"><div class=\"menu-section\"><strong>",
    esc(session?.name ?? "Developer"),
    "</strong><span>",
    esc(session?.email ?? "development session"),
    "</span></div><a class=\"menu-button\" href=\"/app/settings/account\">Account settings</a><a class=\"menu-button\" href=\"/app/settings/security\">Security</a><button class=\"menu-button danger\" data-action=\"sign-out\">Sign out</button></div>",
  );
}

function orgMenu() {
  if (!state.orgMenu) return "";
  return h("<div class=\"menu org-menu\" role=\"menu\"><div class=\"menu-section\"><strong>Atlas Engineering</strong><span>Developer plan · local preview</span></div><button class=\"menu-button\" data-action=\"organization-unavailable\">Organization switching is unavailable</button><a class=\"menu-button\" href=\"/app/team\">View team</a></div>");
}

function primarySidebar(pathname) {
  return h(
    "<nav class=\"sidebar-nav\" aria-label=\"Primary navigation\"><div class=\"nav-group nav-group-personal\"><div class=\"nav-list\">",
    link("/app/overview", "Overview", pathname === "/app" || pathname === "/app/overview"),
    link("/app/repositories", "Repositories", pathname.startsWith("/app/repositories")),
    link("/app/history", "Verification runs", pathname === "/app/history" || pathname.startsWith("/app/runs")),
    link("/app/findings", "Findings", pathname.startsWith("/app/findings")),
    "</div></div><div class=\"nav-group\"><span class=\"nav-label\">Workspace</span><div class=\"nav-list\">",
    link("/app/baselines", "Baselines", pathname.startsWith("/app/baselines")),
    link("/app/policies", "Policies", pathname.startsWith("/app/policies")),
    link("/app/change-sets", "Change Sets", pathname.startsWith("/app/change-sets")),
    link("/app/releases", "Releases", pathname.startsWith("/app/releases")),
    link("/app/outcomes", "Outcomes", pathname.startsWith("/app/outcomes")),
    link("/app/team", "Team", pathname.startsWith("/app/team")),
    link("/app/integrations", "Integrations", pathname === "/app/integrations"),
    "</div></div><div class=\"nav-group nav-group-team\"><span class=\"nav-label\">Your team</span><div class=\"nav-list\"><a class=\"nav-link team-link\" href=\"/app/overview\"><span class=\"team-avatar\">PR</span><span class=\"nav-text\">PR Proof</span>", icon("chevron-down", "team-chevron"), "</a><div class=\"nav-sublist\">",
    link("/app/overview", "Home", pathname === "/app" || pathname === "/app/overview"),
    link("/app/repositories", "Evidence", pathname.startsWith("/app/repositories")),
    link("/app/history", "Runs", pathname === "/app/history" || pathname.startsWith("/app/runs")),
    "</div></div></div></nav>",
  );
}

function shell(title, body) {
  const pathname = currentPath();
  const settingsMode = pathname.startsWith("/app/settings");
  const sidebarExpanded = window.matchMedia("(max-width: 767px)").matches ? state.mobileNav : state.sidebarOpen;
  const account = state.session
    ? h("<div class=\"menu-wrap\"><button class=\"account-trigger\" data-action=\"toggle-account\" aria-expanded=\"", state.accountMenu ? "true" : "false", "\"><span class=\"org-avatar\">", esc((state.session.name || "D").slice(0, 1).toUpperCase()), "</span><span class=\"account-label\">", esc(state.session.name), "</span>", icon("chevron-down"), "</button>", accountMenu(), "</div>")
    : h("<a class=\"button small\" href=\"/sign-in\">Sign in</a>");
  const sidebar = settingsMode
    ? h("<div class=\"settings-sidebar-wrap\">", settingsSidebar(), "</div><div class=\"sidebar-footer\"><a class=\"sidebar-footer-row\" href=\"/local/report\">", icon("files"), "<span>Local report</span></a><div class=\"sidebar-meta\"><span>pr-proof 0.1.0</span><span>dev mode</span></div></div>")
    : h(
      "<div class=\"sidebar-header\"><div class=\"sidebar-org-row\"><div class=\"menu-wrap\"><button class=\"org-switcher\" data-action=\"toggle-org\" aria-expanded=\"",
      state.orgMenu ? "true" : "false",
      "\"><span class=\"org-avatar\">PR</span><span class=\"org-copy\"><strong>pr-proof</strong><span>Control plane</span></span>",
      icon("chevron-down"),
      "</button>",
      orgMenu(),
      "</div><div class=\"sidebar-tools\">",
      iconButton("open-palette", "search", "Search"),
      iconButton("open-local-report", "plus", "Open local report"),
      iconButton("toggle-account", "settings", "Account", "aria-expanded=\"" + (state.accountMenu ? "true" : "false") + "\""),
      iconButton("toggle-mobile-nav", "x", "Close navigation", "", "mobile-nav-close"),
      "</div></div><div class=\"sidebar-context\"><span>",
      esc(workspace.name),
      "</span><span>",
      esc(workspace.plan),
      " plan · preview</span></div></div>",
      primarySidebar(pathname),
      "<div class=\"sidebar-footer\"><a class=\"sidebar-footer-row\" href=\"/app/settings/account\" ",
      pathname.startsWith("/app/settings") ? "aria-current=\"page\"" : "",
      ">",
      icon("settings"),
      "<span>Settings</span></a><a class=\"sidebar-footer-row\" href=\"/local/report\">",
      icon("files"),
      "<span>Local report</span></a><div class=\"sidebar-meta\"><span>pr-proof 0.1.0</span><span>dev mode</span></div></div>",
    );
  return h(
    "<div class=\"app-shell\"><aside id=\"app-sidebar\" class=\"sidebar",
    state.sidebarOpen ? "" : " closed",
    state.mobileNav ? " open" : "",
    "\"><div class=\"sidebar-frame\">",
    sidebar,
    "</div></aside>",
    state.mobileNav ? "<button type=\"button\" class=\"mobile-nav-scrim\" data-action=\"toggle-mobile-nav\" aria-label=\"Close navigation\"></button>" : "",
    "<main class=\"main\"><div class=\"main-frame\"><header class=\"topbar\"><div class=\"topbar-left\"><button class=\"icon-button topbar-mobile-menu\" data-action=\"toggle-mobile-nav\" aria-label=\"Toggle sidebar\" aria-expanded=\"", sidebarExpanded ? "true" : "false", "\" aria-controls=\"app-sidebar\">",
    icon("sidebar"),
    "</button><div class=\"breadcrumbs\"><span>Atlas Engineering</span><span class=\"crumb-separator\">/</span><strong>",
    esc(title),
    "</strong></div></div><div class=\"topbar-actions\"><button class=\"command-button\" data-action=\"open-palette\">",
    icon("search"),
    "<span>Search</span><kbd>⌘K</kbd></button><a class=\"topbar-link\" href=\"/local/report\">",
    icon("files"),
    "<span>Local report</span></a>",
    account,
    "</div></header><div class=\"circle-header-strip\"><span>PR Proof workspace</span><span class=\"circle-header-hint\">Local-first verification</span></div><section class=\"content\">",
    body,
    "</section></div></main></div>",
    state.paletteOpen ? commandPalette() : "",
    state.selectedFindingId ? findingPanel(state.selectedFindingId) : "",
    toastMarkup(),
  );
}

function localAssuranceBundleSection(report) {
  const assurance = report?.assurance;
  if (!assurance) return "";
  return h("<div class=\"card\" style=\"margin-top:12px\"><div class=\"card-header\"><div><h2>Change assurance</h2><p>Optional sections appear only when the local evidence bundle contains them.</p></div>", badge("Local evidence", "verified"), "</div><div class=\"card-body\"><div class=\"repo-metric-grid\">", metric("Record", assurance.record?.id ?? "Unavailable"), metric("Receipts", assurance.receipts?.length ?? 0), metric("Graph snapshots", assurance.graphs?.length ?? 0), metric("Coverage", assurance.coverage?.id ?? "Unknown"), metric("Contracts", assurance.contractAssessment?.status ?? "Unknown"), metric("Unknowns", assurance.unknowns?.length ?? 0), "</div>", assurance.unknowns?.length ? h("<div class=\"callout\" style=\"margin-top:12px\"><strong>Unknown or partial evidence remains visible.</strong><ul>", assurance.unknowns.map((item) => h("<li>", esc(item), "</li>")).join(""), "</ul></div>") : "", "</div></div>");
}

function localReportShell(body) {
  return h("<div class=\"local-report-shell\"><header class=\"local-report-topbar\"><div class=\"brand\"><span class=\"brand-wordmark\">pr-proof</span><span class=\"brand-subtitle\">local report viewer</span></div><div class=\"topbar-actions\"><span class=\"local-only-label\">127.0.0.1 · local only</span><a class=\"button small secondary\" href=\"/sign-in\">Open control plane</a></div></header><main class=\"content\">", body, localAssuranceBundleSection(state.report), "</main></div>", toastMarkup());
}

function statCard(label, value, detail, tone = "") {
  return h("<div class=\"stat-card\" data-tone=\"", esc(tone), "\"><span class=\"stat-label\">", esc(label), "</span><strong class=\"stat-value\">", esc(value), "</strong><span class=\"stat-caption\">", esc(detail), "</span></div>");
}

function attentionRow(finding) {
  return h("<button class=\"attention-row\" data-action=\"open-finding\" data-finding=\"", esc(finding.id), "\"><span>", badge(finding.severity, finding.tone), "</span><span class=\"row-main\"><strong>", esc(finding.title), "</strong><span>", esc(finding.repository), " · ", esc(finding.file), ":", esc(finding.line), "</span></span><span class=\"row-meta\">", esc(finding.status), "</span></button>");
}

function runRow(run, options = {}) {
  const repository = repositoryById(run.repositoryId);
  return h("<a class=\"run-row\" href=\"", esc(options.href ?? ("/app/runs/" + run.id)), "\"><span class=\"repo-mark\">", esc(run.repository.slice(0, 2).toUpperCase()), "</span><span class=\"row-main\"><strong>", esc(run.repository), "</strong><span>", esc(run.ref), " · ", esc(run.commit), "</span></span>", badge(run.verdict, run.tone), "<span class=\"row-meta\">", esc(repository?.coverage ?? run.coverage), " · ", esc(run.time), "</span></a>");
}

function overview() {
  const needsReview = repositories.filter((repository) => repository.verdictTone === "review").length;
  const unknown = repositories.reduce((sum, repository) => sum + repository.unknowns, 0);
  const highFindings = findings.filter((finding) => finding.severity === "High");
  return shell("Overview", h(
    pageHeading("Workspace overview", "Evidence at a glance", "A compact view of verification health across the repositories connected to this workspace.", h(button("Connect repository", "connect-repository", "primary"), button("View local report", "open-local-report"))),
    previewBanner(),
    "<div class=\"stat-grid\">",
    statCard("Connected repositories", repositories.length, workspace.activePrivateRepositories + " private in use"),
    statCard("Needs review", needsReview, "Across this workspace", "review"),
    statCard("Open unknowns", unknown, "Evidence gaps remain visible", "unknown"),
    statCard("Private capacity", workspace.activePrivateRepositories + "/" + workspace.privateRepositoryLimit, workspace.billingStatus),
    "</div><div class=\"two-column\"><div class=\"card\"><div class=\"card-header\"><div><h2>Needs attention</h2><p>Findings with the clearest next action.</p></div><a class=\"button small text\" href=\"/app/findings\">View all</a></div><div class=\"attention-list\">",
    (highFindings.length ? highFindings : findings.slice(0, 3)).map(attentionRow).join(""),
    "</div></div><div class=\"card\"><div class=\"card-header\"><div><h2>Workspace setup</h2><p>Provider-independent readiness tasks.</p></div></div><div class=\"task-list\">",
    setupTasks.map((task) => h("<div class=\"task-row ", esc(task.state), "\"><span class=\"task-check\">", icon(task.state === "done" ? "checkmark" : "exclamation"), "</span><span class=\"row-main\"><strong>", esc(task.label), "</strong><span>", esc(task.detail), "</span></span></div>")).join(""),
    "</div></div></div><div class=\"two-column\"><div class=\"card\"><div class=\"card-header\"><div><h2>Repositories</h2><p>Latest verdicts and evidence completeness.</p></div><a class=\"button small text\" href=\"/app/repositories\">View all</a></div><div class=\"run-list\">",
    repositories.map((repository) => h("<a class=\"run-row\" href=\"/app/repositories/", esc(repository.id), "\"><span class=\"repo-mark\">", esc(repository.name.slice(0, 2).toUpperCase()), "</span><span class=\"row-main\"><strong>", esc(repository.name), "</strong><span>", esc(repository.visibility), " · ", esc(repository.lastRun), "</span></span>", badge(repository.verdict, repository.verdictTone), "</a>")).join(""),
    "</div></div><div class=\"card\"><div class=\"card-header\"><div><h2>Recent runs</h2><p>Summaries only; full evidence stays local.</p></div><a class=\"button small text\" href=\"/app/history\">History</a></div><div class=\"run-list\">",
    runs.slice(0, 4).map(runRow).join(""),
    "</div></div></div>",
  ));
}

function repositoriesPage() {
  const used = workspace.activePrivateRepositories / workspace.privateRepositoryLimit * 100;
  return shell("Repositories", h(
    pageHeading("Workspace", "Repositories", "Repository connections and the latest local verification state.", h(button("Connect repository", "connect-repository", "primary"))),
    previewBanner("Repository sync is local-first.", "The preview keeps repository metadata and structured summaries visible; provider connection setup is not configured."),
    "<div class=\"card\"><div class=\"card-header\"><div><h2>Private repository capacity</h2><p>Entitlements are authoritative on the server in production.</p></div><a class=\"button small text\" href=\"/app/settings/billing\">View plan</a></div><div class=\"card-body\"><div class=\"usage-bar\"><span style=\"width:",
    String(Math.min(100, used)),
    "%\"></span></div><div class=\"usage-meta\"><span>",
    workspace.activePrivateRepositories,
    " of ",
    workspace.privateRepositoryLimit,
    " private repositories connected</span><span>",
    workspace.plan,
    "</span></div></div></div><div class=\"card table-card\" style=\"margin-top:12px\"><table class=\"data-table\"><thead><tr><th>Repository</th><th>Connection</th><th>Verdict</th><th>Coverage</th><th>Last run</th></tr></thead><tbody>",
    repositories.map((repository) => h("<tr><td><a class=\"repo-name\" href=\"/app/repositories/", esc(repository.id), "\"><span class=\"repo-mark\">", esc(repository.name.slice(0, 2).toUpperCase()), "</span><span><strong>", esc(repository.name), "</strong><span>", esc(repository.visibility), " · ", esc(repository.defaultBranch), "</span></span></a></td><td>", badge(repository.connection, "verified"), "</td><td>", badge(repository.verdict, repository.verdictTone), "</td><td class=\"table-number\">", esc(repository.coverage), "</td><td class=\"muted\">", esc(repository.lastRun), "</td></tr>")).join(""),
    "</tbody></table></div>",
  ));
}

function repoSubnav(repository, active) {
  const base = "/app/repositories/" + repository.id;
  return h("<nav class=\"subnav\" aria-label=\"Repository sections\">", [
    ["", "Overview"],
    ["/assurance", "Assurance"],
    ["/graph", "Verification graph"],
    ["/coverage", "Behavioral coverage"],
    ["/contracts", "Contracts"],
    ["/runs", "Runs"],
    ["/policies", "Policies"],
    ["/baselines", "Baselines"],
    ["/findings", "Findings"],
    ["/change-sets", "Change sets"],
    ["/releases", "Releases"],
    ["/outcomes", "Outcomes"],
  ].map(([suffix, label]) => h("<a class=\"", active === (suffix ? suffix.slice(1) : "overview") ? "active" : "", "\" href=\"", esc(base + suffix), "\">", esc(label), "</a>")).join(""), "</nav>");
}

function metric(label, value) {
  return h("<div class=\"metric\"><dt>", esc(label), "</dt><dd>", esc(value), "</dd></div>");
}

function evidenceCard(label, value, detail, tone = "") {
  return h("<div class=\"evidence-card\"><h3>", esc(label), "</h3><p>", esc(detail), "</p><strong class=\"evidence-value ", esc(tone), "\">", esc(value), "</strong></div>");
}

function findingRow(finding) {
  return h("<button class=\"finding-row\" data-action=\"open-finding\" data-finding=\"", esc(finding.id), "\"><span>", badge(finding.severity, finding.tone), "</span><span class=\"row-main\"><strong>", esc(finding.title), "</strong><span class=\"finding-rule\">", esc(finding.rule), " · ", esc(finding.repository), "</span><span class=\"finding-location\">", esc(finding.file), ":", esc(finding.line), " · ", esc(finding.confidence), " confidence</span></span><span class=\"row-end\">", badge(finding.status, finding.status === "Unknown" ? "unknown" : "neutral"), "</span></button>");
}

function repoOverview(repository, repositoryFindings) {
  return h("<div class=\"repo-metric-grid\">", metric("Verdict", repository.verdict), metric("Open findings", repository.openFindings), metric("Unknowns", repository.unknowns), metric("Coverage", repository.coverage), metric("Changed files", repository.changedFiles), metric("Changed lines", repository.changedLines), "</div><div class=\"evidence-grid\">", evidenceCard("Test integrity", repository.verdict === "Verified" ? "Verified" : "Review", "Assertions and changed-test evidence", repository.verdict === "Verified" ? "verified" : "warning"), evidenceCard("Impact", repository.unknowns ? "Partial" : "Mapped", repository.unknowns ? repository.unknowns + " path unknowns" : "Downstream consumers mapped", repository.unknowns ? "unknown" : "verified"), evidenceCard("Coverage", repository.coverage, "Changed-line coverage", repository.coverage === "Unavailable" ? "unknown" : "verified"), evidenceCard("Mutation", repository.mutation, "Targeted mutation result", repository.mutation === "Not run" ? "unknown" : "verified"), "</div><div class=\"card\" style=\"margin-top:12px\"><div class=\"card-header\"><div><h2>Latest evidence</h2><p>Review evidence, then open a finding for the precise next action.</p></div></div>", repositoryFindings.length ? h("<div class=\"finding-list\">", repositoryFindings.map(findingRow).join(""), "</div>") : h("<div class=\"card-body\"><div class=\"empty-state\"><h3>No open findings</h3><p>This repository has no current findings in the local preview data.</p></div></div>"), "</div>");
}

function repoRuns(repository) {
  const repositoryRuns = runs.filter((run) => run.repositoryId === repository.id);
  return h("<div class=\"card\"><div class=\"card-header\"><div><h2>Runs for ", esc(repository.name), "</h2><p>Full reports remain local to the repository or local viewer.</p></div>", button("Run local check", "run-local-check", "small"), "</div><div class=\"run-list\">", repositoryRuns.length ? repositoryRuns.map(runRow).join("") : "<div class=\"card-body\"><div class=\"empty-state\"><h3>No runs recorded</h3><p>Run the CLI locally to create the first structured report.</p></div></div>", "</div></div>");
}

function policyCard(title, detail, status, tone, action) {
  return h("<div class=\"settings-card\"><div class=\"settings-row\"><div><h3>", esc(title), "</h3><p>", esc(detail), "</p></div><div class=\"settings-control\">", badge(status, tone), action ? button(action.label, action.action, "small") : "", "</div></div></div>");
}

function repoPolicies(repository) {
  return h("<div class=\"two-column\"><div>", policyCard("Strict review", "Flags weakened assertions and incomplete evidence for review.", repository.policy === "Strict review" ? "Active" : "Available", repository.policy === "Strict review" ? "verified" : "neutral", { label: repository.policy === "Strict review" ? "Active" : "Use policy", action: "policy-unavailable" }), "</div><div>", policyCard("Default advisory", "Reports evidence gaps without making a hosted merge decision.", repository.policy === "Default advisory" ? "Active" : "Available", repository.policy === "Default advisory" ? "verified" : "neutral", { label: repository.policy === "Default advisory" ? "Active" : "Use policy", action: "policy-unavailable" }), "</div></div><div class=\"callout\" style=\"margin-top:12px\"><strong>Policy changes are not persisted by this preview.</strong>Production policy writes must be authorized server-side and recorded in the audit log.</div>");
}

function repoBaselines(repository) {
  return h("<div class=\"card\"><div class=\"card-header\"><div><h2>Baseline state</h2><p>Only structured fingerprints and resolution state are shown here.</p></div>", button("Update baseline", "baseline-unavailable", "small"), "</div><div class=\"card-body\"><div class=\"billing-facts\"><div class=\"billing-fact\"><span>Current state</span><strong>", esc(repository.baseline), "</strong></div><div class=\"billing-fact\"><span>Source</span><strong>Local .pr-proof baseline</strong></div><div class=\"billing-fact\"><span>New findings</span><strong>", repository.openFindings, "</strong></div><div class=\"billing-fact\"><span>Waivers</span><strong>None in preview</strong></div></div></div></div><div class=\"callout\" style=\"margin-top:12px\"><strong>Baseline data stays in the repository.</strong>The control plane does not upload source or full diff content to make this view work.</div>");
}

function repoFindings(repository, repositoryFindings) {
  return h("<div class=\"card\"><div class=\"filter-bar\"><input data-filter=\"finding-query\" placeholder=\"Filter findings\" aria-label=\"Filter findings\" /><select data-filter=\"finding-severity\" aria-label=\"Filter severity\"><option value=\"all\">All severities</option><option value=\"high\">High</option><option value=\"warning\">Warning</option><option value=\"info\">Info</option></select><select data-filter=\"finding-status\" aria-label=\"Filter status\"><option value=\"all\">All states</option><option value=\"new\">New</option><option value=\"unknown\">Unknown</option><option value=\"resolved\">Resolved</option></select></div><div class=\"finding-list\">", repositoryFindings.length ? repositoryFindings.map((finding) => h("<div data-filter-row data-filter-group=\"findings\" data-search=\"", esc((finding.title + " " + finding.rule + " " + finding.file).toLowerCase()), "\" data-severity=\"", esc(finding.tone), "\" data-status=\"", esc(finding.status.toLowerCase()), "\">", findingRow(finding), "</div>")).join("") : "<div class=\"card-body\"><div class=\"empty-state\"><h3>No findings</h3><p>There are no findings for this repository in the preview data.</p></div></div>", "</div></div>");
}

function assuranceStateCard(title, state, detail) {
  const tone = /present|complete|configured|verified/i.test(state) ? "verified" : /missing|blocked|stale/i.test(state) ? "warning" : "unknown";
  return h("<div class=\"evidence-card\"><h3>", esc(title), "</h3><p>", esc(detail), "</p>", badge(state, tone), "</div>");
}

function assuranceDimensionRow(dimension, state, detail) {
  return h("<tr><td><strong>", esc(dimension), "</strong></td><td>", badge(state, /present/i.test(state) ? "verified" : /missing|stale/i.test(state) ? "warning" : "unknown"), "</td><td class=\"muted\">", esc(detail), "</td></tr>");
}

function repositoryAssurancePage(repository, active = "assurance") {
  const common = h("<div class=\"repo-metric-grid\">", metric("Record", "Available", "Structured metadata only"), metric("Receipts", "Unknown", "No receipt bundle loaded in preview"), metric("Graph", "Partial", "Parser-backed data is not synchronized here"), metric("Outcomes", "Unknown", "No external runtime adapter connected"), "</div>");
  const sections = {
    assurance: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Change Assurance Record</h2><p>The lifecycle record connects intent, change, evidence, review, release, and outcomes without storing source.</p></div>", badge("Preview metadata", "neutral"), "</div><div class=\"card-body\"><p class=\"muted\">The bundled preview has repository summaries but no assurance bundle loaded for this repository. Receipt, freshness, and approval states remain UNKNOWN until local evidence is exported.</p></div></div><div class=\"evidence-grid\">", assuranceStateCard("Verification receipt", "Unknown", "No portable receipt is synchronized in this preview."), assuranceStateCard("Evidence freshness", "Unknown", "Head, policy, tool, and artifact freshness need a receipt context."), assuranceStateCard("Required reviewers", "Unknown", "Review metadata is not available in the local preview."), assuranceStateCard("Runtime outcome", "Unknown", "Runtime and deployment adapters are not connected."), "</div>"),
    graph: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Verification Graph</h2><p>Typed impact paths are evidence only when backed by deterministic parser, test, artifact, or provenance data.</p></div>", badge("Partial", "unknown"), "</div><div class=\"card-body\"><div class=\"callout\"><strong>Graph snapshot unavailable.</strong> The hosted preview does not fabricate nodes or edges. Run <code>tb repo map --format json</code> locally and upload structured metadata only when hosted ingestion is authorized.</div></div></div><div class=\"evidence-grid\">", assuranceStateCard("Changed symbols", "Unknown", "No graph snapshot loaded."), assuranceStateCard("Impacted tests", "Unknown", "No deterministic test-to-change edges loaded."), assuranceStateCard("Owners", "Unknown", "Ownership evidence is not configured."), assuranceStateCard("Runtime edges", "Unknown", "Dynamic runtime relationships remain unresolved."), "</div>"),
    coverage: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Behavioral Verification Coverage</h2><p>Coverage dimensions stay separate from ordinary line coverage and never invent evidence.</p></div>", badge("Unknown", "unknown"), "</div><div class=\"table-card\"><table class=\"data-table\"><thead><tr><th>Dimension</th><th>State</th><th>Evidence note</th></tr></thead><tbody>", assuranceDimensionRow("Test evidence", "Unknown", "No assurance coverage surface is loaded."), assuranceDimensionRow("Test execution", "Unknown", "Execution receipts are not synchronized."), assuranceDimensionRow("Branch evidence", "Unknown", "Branch evidence requires an explicit artifact."), assuranceDimensionRow("Mutation evidence", "Unknown", "Mutation evidence is optional and absent here."), assuranceDimensionRow("Contract evidence", "Unknown", "Contract state is not configured for this preview."), assuranceDimensionRow("Fixture evidence", "Unknown", "Fixture and snapshot evidence is not loaded."), assuranceDimensionRow("Ownership / policy", "Unknown", "Owner and policy references are not present."), assuranceDimensionRow("Rollback / runtime", "Unknown", "External release and runtime adapters are not connected."), "</tbody></table></div></div>"),
    contracts: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Change Contracts</h2><p>Contracts are optional repository configuration. Missing configuration is not compliance.</p></div>", badge("Not configured", "unknown"), "</div><div class=\"card-body\"><div class=\"empty-state\"><h3>No contract loaded</h3><p>Add <code>.tinkerbot/change-contract.yml</code> and run <code>tb change contract validate</code> locally. Scope drift, required tests, reviewers, documentation, and rollback evidence will remain deterministic findings.</p></div></div></div>"),
    "change-sets": h("<div class=\"card\"><div class=\"card-header\"><div><h2>Cross-repository Change Sets</h2><p>Related repositories, shared API/schema references, merge order, and partial evidence.</p></div>", badge("Unavailable", "unknown"), "</div><div class=\"card-body\"><div class=\"empty-state\"><h3>No change set in this preview</h3><p>Use <code>tb change-set assess</code> with an explicit ChangeSet export. Missing repositories and incompatible relationships remain UNKNOWN.</p></div></div></div>"),
    releases: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Release Safety Assessment</h2><p>Advisory release evidence for receipts, migrations, flags, approvals, rollback, deployment, and runtime state.</p></div>", badge("Unknown", "unknown"), "</div><div class=\"card-body\"><div class=\"empty-state\"><h3>No release manifest</h3><p>Tinkerbot does not execute deployments, rollbacks, or feature-flag changes. Supply a manifest and external adapter evidence with <code>tb release assess</code>.</p></div></div></div>"),
    outcomes: h("<div class=\"card\"><div class=\"card-header\"><div><h2>Outcome History</h2><p>Observed facts and imported signals stay separate from human-confirmed or inferred associations.</p></div>", badge("No outcomes", "neutral"), "</div><div class=\"card-body\"><div class=\"empty-state\"><h3>No post-merge outcomes recorded</h3><p>CI failures, reverts, rollbacks, incidents, regressions, successful releases, and false alarms are only shown when explicitly recorded.</p></div></div></div>"),
  };
  return shell(repository.name, h("<div class=\"repo-hero\"><div class=\"repo-title\"><span class=\"repo-mark\">", esc(repository.name.slice(0, 2).toUpperCase()), "</span><div><h1>", esc(repository.name), "</h1><p>", esc(repository.visibility), " · ", esc(repository.defaultBranch), " · ", esc(repository.connection), "</p></div></div></div>", repoSubnav(repository, active), previewBanner("Source remains in the repository.", "This hosted preview renders structured assurance metadata only; unavailable evidence remains visible."), common, sections[active] ?? sections.assurance));
}

function repositoryPage(id, active = "overview") {
  const repository = repositoryById(id);
  if (!repository) return notFoundPage();
  if (["assurance", "graph", "coverage", "contracts", "change-sets", "releases", "outcomes"].includes(active)) return repositoryAssurancePage(repository, active);
  const repositoryFindings = findings.filter((finding) => finding.repository === repository.name);
  const content = active === "runs"
    ? repoRuns(repository)
    : active === "policies"
      ? repoPolicies(repository)
      : active === "baselines"
        ? repoBaselines(repository)
        : active === "findings"
          ? repoFindings(repository, repositoryFindings)
          : repoOverview(repository, repositoryFindings);
  return shell(repository.name, h("<div class=\"repo-hero\"><div class=\"repo-title\"><span class=\"repo-mark\">", esc(repository.name.slice(0, 2).toUpperCase()), "</span><div><h1>", esc(repository.name), "</h1><p>", esc(repository.visibility), " · ", esc(repository.defaultBranch), " · ", esc(repository.connection), "</p></div></div><div class=\"repo-actions\">", button("Run local check", "run-local-check", "primary"), button("Repository settings", "repository-settings"), "</div></div>", repoSubnav(repository, active), previewBanner("Source remains in the repository.", "The control plane uses structured report metadata, fingerprints, and explicit limitations for this view."), content));
}

function historyTable(runsToRender = runs) {
  return h("<div class=\"card table-card\"><div class=\"filter-bar\"><input data-filter=\"run-query\" placeholder=\"Filter runs\" aria-label=\"Filter runs\" /><select data-filter=\"run-verdict\" aria-label=\"Filter run verdict\"><option value=\"all\">All verdicts</option><option value=\"verified\">Verified</option><option value=\"review\">Needs review</option><option value=\"unknown\">Unknown</option></select></div><table class=\"data-table\"><thead><tr><th>Repository</th><th>Ref</th><th>Verdict</th><th>Changed</th><th>Coverage</th><th>Recorded</th></tr></thead><tbody>", runsToRender.map((run) => h("<tr data-filter-row data-filter-group=\"runs\" data-search=\"", esc((run.repository + " " + run.ref + " " + run.commit).toLowerCase()), "\" data-verdict=\"", esc(run.tone), "\"><td><a href=\"/app/runs/", esc(run.id), "\"><strong>", esc(run.repository), "</strong><div class=\"muted mono\">", esc(run.commit), "</div></a></td><td class=\"mono\">", esc(run.ref), "</td><td>", badge(run.verdict, run.tone), "</td><td class=\"table-number\">", run.changedFiles, " files · ", run.changedLines, " lines</td><td class=\"table-number\">", esc(run.coverage), "</td><td class=\"muted\">", esc(run.time), "</td></tr>")).join(""), "</tbody></table></div>");
}

function historyPage() {
  return shell("Verification runs", h(pageHeading("Evidence", "Verification runs", "Structured summaries from local PR Proof checks.", button("Open local report", "open-local-report")), previewBanner("Runs are report summaries, not source mirrors.", "The full report and repository content remain local to the checked-out repository."), historyTable()));
}

function runsPage() {
  return shell("Runs", h(pageHeading("Evidence", "Run explorer", "Inspect individual verification results and their explicit evidence limits."), historyTable()));
}

function runPage(id) {
  const run = runById(id);
  if (!run) return notFoundPage();
  const repository = repositoryById(run.repositoryId);
  if (!repository) return notFoundPage();
  const runFindings = findings.filter((finding) => finding.repository === run.repository);
  return shell("Run " + run.commit, h("<div class=\"run-detail-head\"><div><div class=\"eyebrow\">Verification run</div><h1>", esc(run.repository), " · ", esc(run.ref), "</h1><p>", esc(run.time), " · ", esc(run.tool), " · structured metadata only</p></div><div class=\"page-actions\">", badge(run.verdict, run.tone), button("View local report", "open-local-report"), "</div></div><div class=\"run-facts\">", [["Head", run.commit], ["Base", run.base], ["Changed files", run.changedFiles], ["Changed lines", run.changedLines], ["Coverage", run.coverage], ["Findings", run.findings], ["Unknowns", run.unknowns], ["Repository", repository.name]].map(([label, value]) => h("<div class=\"fact\"><dt>", esc(label), "</dt><dd>", esc(value), "</dd></div>")).join(""), "</div><div class=\"evidence-grid\">", evidenceCard("Test integrity", run.verdict === "Verified" ? "Verified" : "Review", "Assertions and test behavior", run.verdict === "Verified" ? "verified" : "warning"), evidenceCard("Impact", run.unknowns ? "Partial" : "Mapped", run.unknowns ? run.unknowns + " unknown paths" : "Downstream consumers mapped", run.unknowns ? "unknown" : "verified"), evidenceCard("Coverage", run.coverage, "Changed-line coverage evidence", run.coverage === "Unavailable" ? "unknown" : "verified"), evidenceCard("Policy", repository.policy, "Policy applied to this summary", "verified"), "</div><div class=\"card\" style=\"margin-top:12px\"><div class=\"card-header\"><div><h2>Findings in this run</h2><p>Open a finding to review its evidence and suggested action.</p></div></div><div class=\"finding-list\">", runFindings.length ? runFindings.map(findingRow).join("") : "<div class=\"card-body\"><div class=\"empty-state\"><h3>No findings in this run</h3><p>The run completed without findings in this preview.</p></div></div>", "</div></div>"));
}

function findingsPage() {
  return shell("Findings", h(pageHeading("Evidence", "Findings", "Reviewable evidence with explicit severity, confidence, and resolution state.", h(button("Open local report", "open-local-report"), button("Export metadata", "download-report"))), previewBanner("Evidence is intentionally bounded.", "Finding rows include structured locations and explanations. They do not require uploading source or a full diff."), "<div class=\"card\"><div class=\"filter-bar\"><input data-filter=\"finding-query\" placeholder=\"Filter by title, rule, or file\" aria-label=\"Filter findings\" /><select data-filter=\"finding-severity\" aria-label=\"Filter severity\"><option value=\"all\">All severities</option><option value=\"high\">High</option><option value=\"warning\">Warning</option><option value=\"info\">Info</option></select><select data-filter=\"finding-status\" aria-label=\"Filter status\"><option value=\"all\">All states</option><option value=\"new\">New</option><option value=\"unknown\">Unknown</option></select></div><div class=\"finding-list\">", findings.map((finding) => h("<div data-filter-row data-filter-group=\"findings\" data-search=\"", esc((finding.title + " " + finding.rule + " " + finding.file + " " + finding.repository).toLowerCase()), "\" data-severity=\"", esc(finding.tone), "\" data-status=\"", esc(finding.status.toLowerCase()), "\">", findingRow(finding), "</div>")).join(""), "</div></div>"));
}

function policiesPage() {
  return shell("Policies", h(pageHeading("Administration", "Policies", "Policy packs define how the control plane handles failures, unknown evidence, and review states.", button("Create policy", "policy-unavailable", "primary")), previewBanner("Policy evaluation is local-first.", "The CLI applies the policy pack during verification; a hosted policy editor and server-side persistence are not configured."), "<div class=\"two-column\"><div>", policyCard("Default advisory", "Reports findings and unknowns without turning them into a hosted merge decision.", "Available", "neutral", { label: "Use in local config", action: "policy-unavailable" }), policyCard("Strict review", "Highlights weakened assertions and incomplete evidence for human review.", "Workspace default", "verified", { label: "Active", action: "policy-unavailable" }), "</div><div>", policyCard("Blocking unknowns", "A production-only option that requires a server-authorized policy decision.", "Unavailable", "unknown", { label: "Provider unavailable", action: "policy-unavailable" }), h("<div class=\"card\"><div class=\"card-header\"><div><h2>Repositories</h2><p>Current policy assignment.</p></div></div><div class=\"run-list\">", repositories.map((repository) => h("<a class=\"run-row\" href=\"/app/repositories/", esc(repository.id), "/policies\"><span class=\"repo-mark\">", esc(repository.name.slice(0, 2).toUpperCase()), "</span><span class=\"row-main\"><strong>", esc(repository.name), "</strong><span>", esc(repository.policy), "</span></span>", badge("Configured", "verified"), "</a>")).join(""), "</div></div>"), "</div></div>"));
}

function baselinesPage() {
  return shell("Baselines", h(pageHeading("Evidence", "Baselines", "Baseline fingerprints make new, resolved, and unknown findings explicit without retaining source content.", button("Initialize baseline", "baseline-unavailable", "primary")), previewBanner("Baseline files stay local.", "The preview exposes metadata from repository reports; baseline writes require a local CLI action."), "<div class=\"card table-card\"><table class=\"data-table\"><thead><tr><th>Repository</th><th>State</th><th>Open findings</th><th>Last run</th><th>Action</th></tr></thead><tbody>", repositories.map((repository) => h("<tr><td><a href=\"/app/repositories/", esc(repository.id), "/baselines\"><strong>", esc(repository.name), "</strong><div class=\"muted\">", esc(repository.visibility), "</div></a></td><td>", badge(repository.baseline, repository.baseline.includes("Stale") ? "warning" : "verified"), "</td><td class=\"table-number\">", repository.openFindings, "</td><td class=\"muted\">", esc(repository.lastRun), "</td><td>", button("Open", "open-repository", "small", "data-repository=\"" + esc(repository.id) + "\""), "</td></tr>")).join(""), "</tbody></table></div>"));
}

function invitationRow(invitation) {
  return h("<div class=\"member-row\"><span class=\"org-avatar\">", esc(invitation.email.slice(0, 2).toUpperCase()), "</span><span class=\"row-main\"><strong>", esc(invitation.email), "</strong><span>", esc(invitation.role), " · invited through WorkOS</span></span>", badge(invitation.state, invitation.state === "pending" ? "warning" : "neutral"), "<span class=\"row-meta\">", esc(invitation.createdAt ? new Date(invitation.createdAt).toLocaleDateString() : ""), "</span></div>");
}

function teamPage() {
  const hosted = Boolean(hostedApiBase());
  const members = [
    { name: "Alex Morgan", email: "alex@example.test", role: "Owner", state: "Active" },
    { name: "Taylor Chen", email: "taylor@example.test", role: "Maintainer", state: "Active" },
    { name: "Sam Rivera", email: "sam@example.test", role: "Reviewer", state: "Active" },
  ];
  const hostedState = state.hosted;
  const banner = hosted
    ? previewBanner(hostedState.error ? "Hosted team data needs attention." : "Hosted invitations are connected.", hostedState.error ?? "Invitation requests are checked against the server-side role, feature, and member entitlements before WorkOS sends email.")
    : previewBanner("Identity provider unavailable.", "The local preview uses a development-only owner session. Production member changes must be authorized and audited server-side.");
  const inviteForm = hosted && hostedState.inviteOpen
    ? h("<div class=\"card\" style=\"margin-top:12px\"><div class=\"card-header\"><div><h2>Invite a teammate</h2><p>Only viewer, reviewer, and maintainer invitations can be issued from this surface.</p></div>", button("Cancel", "close-invite", "small"), "</div><div class=\"card-body\"><form data-invite-form><div class=\"field\"><label for=\"invite-email\">Email</label><input id=\"invite-email\" name=\"email\" type=\"email\" autocomplete=\"email\" required maxlength=\"320\" /></div><div class=\"field\"><label for=\"invite-role\">Role</label><select id=\"invite-role\" name=\"role\"><option value=\"viewer\">Viewer</option><option value=\"reviewer\">Reviewer</option><option value=\"maintainer\">Maintainer</option></select></div>", hostedState.inviteMessage ? h("<div class=\"auth-error\" role=\"alert\">", esc(hostedState.inviteMessage), "</div>") : "", "<button class=\"button primary\" type=\"submit\" ", hostedState.inviteSubmitting ? "disabled" : "", ">", hostedState.inviteSubmitting ? "Sending…" : "Send invitation", "</button></form></div></div>")
    : "";
  const memberMarkup = hosted
    ? h("<div class=\"empty-state\"><h3>Server roster is authoritative</h3><p>WorkOS membership synchronization supplies the active roster. This surface shows invitation state without fabricating members in the browser.</p></div>")
    : members.map((member) => h("<div class=\"member-row\"><span class=\"org-avatar\">", esc(member.name.split(" ").map((part) => part[0]).join("").slice(0, 2)), "</span><span class=\"row-main\"><strong>", esc(member.name), "</strong><span>", esc(member.email), "</span></span>", badge(member.role, member.role === "Owner" ? "verified" : "neutral"), "<span class=\"row-meta\">", esc(member.state), "</span></div>")).join("");
  const invitations = hosted && hostedState.teamLoading
    ? "<div class=\"card-body\"><p class=\"muted\">Loading pending invitations…</p></div>"
    : hosted && hostedState.invitations.length
      ? hostedState.invitations.map(invitationRow).join("")
      : hosted
        ? "<div class=\"card-body\"><div class=\"empty-state\"><h3>No invitations</h3><p>Pending, accepted, and revoked invitation state will appear here.</p></div></div>"
        : "";
  return shell("Team", h(pageHeading("Administration", "Team", hosted ? "Organization membership and invitations are connected to the hosted control-plane API." : "Organization membership and roles are represented here without claiming a hosted identity provider.", button("Invite member", "invite-member", "primary")), banner, "<div class=\"card\"><div class=\"card-header\"><div><h2>", hosted ? "Members" : "Preview members", "</h2><p>", hosted ? "WorkOS is the identity source of truth; invitation changes are server-authorized." : workspace.memberCount + " seats represented in the workspace summary.", "</p></div><span class=\"muted\">", hosted ? "Hosted" : workspace.plan + " plan", "</span></div><div class=\"member-list\">", memberMarkup, "</div></div>", inviteForm, hosted ? h("<div class=\"card\" style=\"margin-top:12px\"><div class=\"card-header\"><div><h2>Invitations</h2><p>Provider-backed invitation state, synchronized through WorkOS webhooks or replay.</p></div></div><div class=\"member-list\">", invitations, "</div></div>") : "", "<div class=\"callout\" style=\"margin-top:12px\"><strong>Role model is enforced server-side.</strong>Client-side visibility never grants billing, policy, member, audit, or repository authority.</div>"));
}

function integrationsPage() {
  return shell("Integrations", h(pageHeading("Administration", "Integrations", "Connectors are explicit capability boundaries. This preview has local CLI and report viewing, but no hosted provider credentials.", button("Add integration", "integration-unavailable", "primary")), "<div class=\"two-column\"><div class=\"card\"><div class=\"card-header\"><div><h2>Local workflow</h2><p>Available without an account provider.</p></div>", badge("Available", "verified"), "</div><div class=\"card-body\"><div class=\"settings-row\"><div><h3>pr-proof CLI</h3><p>Run verification in the repository and open the structured report here.</p></div>", button("Open report viewer", "open-local-report", "small"), "</div><div class=\"settings-row\"><div><h3>Local server</h3><p>Bound to 127.0.0.1 by default with a strict static response policy.</p></div>", badge("Local only", "verified"), "</div></div></div><div class=\"card\"><div class=\"card-header\"><div><h2>Hosted providers</h2><p>Not connected in this environment.</p></div>", badge("Unavailable", "unknown"), "</div><div class=\"card-body\"><div class=\"settings-row\"><div><h3>GitHub App</h3><p>Required for hosted repository sync and pull request checks.</p></div>", button("Provider unavailable", "integration-unavailable", "small"), "</div><div class=\"settings-row\"><div><h3>Billing provider</h3><p>Required before checkout, invoices, or paid entitlement changes.</p></div>", button("Provider unavailable", "integration-unavailable", "small"), "</div></div></div></div>"));
}

function changeSetsPage() {
  return shell("Change Sets", h(pageHeading("Assurance", "Change Sets", "Bounded cross-repository relationships without automatic merging or deployment.", button("Export local change set", "download-report", "small")), previewBanner("No cross-repository evidence is connected.", "A missing repository, incompatible consumer, or stale receipt remains UNKNOWN until explicitly represented."), "<div class=\"card\"><div class=\"card-body\"><div class=\"empty-state\"><h3>No Change Sets</h3><p>Export a structured ChangeSet from <code>tb change-set export</code> or connect an authorized hosted repository group. Tinkerbot does not own merges or deployments.</p></div></div></div>"));
}

function releasesPage() {
  return shell("Releases", h(pageHeading("Assurance", "Release Assessments", "Advisory release evidence and explicit deployment/runtime uncertainty."), previewBanner("Deployment actions are unavailable.", "Tinkerbot consumes feature-flag, deployment, rollback, canary, telemetry, and incident evidence through adapters; it does not execute production actions."), "<div class=\"evidence-grid\">", assuranceStateCard("Release manifest", "Not configured", "No manifest is loaded in this preview."), assuranceStateCard("Verification receipts", "Unknown", "Required receipt references are not available."), assuranceStateCard("Migration / rollback", "Unknown", "Rollback or compensation evidence is an explicit input."), assuranceStateCard("Deployment / runtime", "Unknown", "External deployment and runtime evidence is not connected."), "</div><div class=\"card\" style=\"margin-top:12px\"><div class=\"card-body\"><p class=\"muted\">Use <code>tb release assess</code> locally to produce an advisory assessment. Unknown deployment state is not a pass.</p></div></div>"));
}

function outcomesPage() {
  return shell("Outcomes", h(pageHeading("Assurance", "Outcome History", "Post-merge facts, imported signals, and explicitly confirmed associations."), previewBanner("No causal claims are inferred.", "A PR preceding an incident is not treated as causation. Associations remain unknown or hypotheses until supported."), "<div class=\"card\"><div class=\"card-header\"><div><h2>Recorded outcomes</h2><p>CI failure, revert, hotfix, rollback, incident, regression, successful release, and false-alarm records.</p></div>", badge("Empty", "neutral"), "</div><div class=\"card-body\"><div class=\"empty-state\"><h3>No outcome records</h3><p>Run <code>tb outcome record</code> with an explicit event. Retention and deletion metadata remain part of the export.</p></div></div></div>"));
}

function runAssurancePage(id) {
  const run = runById(id);
  if (!run) return notFoundPage();
  return shell("Run " + run.commit, h(pageHeading("Pull request assurance", run.repository + " · " + run.ref, "Evidence context for this run, separated from the source repository and GitHub as the source of truth.", h("<a class=\"button small secondary\" href=\"/app/runs/", esc(id), "\">Run summary</a>", button("Open local report", "open-local-report"))), previewBanner("Receipt and graph state are explicit.", "The preview does not claim a hosted receipt, graph, agent provenance, approval, or runtime outcome when those objects are absent."), "<div class=\"evidence-grid\">", assuranceStateCard("Assurance record", "Available", "Run summary metadata is present."), assuranceStateCard("Verification receipt", "Unknown", "No portable receipt is synchronized."), assuranceStateCard("Impact paths", run.unknowns ? "Partial" : "Unknown", run.unknowns ? run.unknowns + " unresolved path(s)" : "No graph snapshot loaded."), assuranceStateCard("Finding lifecycle", "Unknown", "Freshness context is not present in this preview."), assuranceStateCard("Agent execution", "Not supplied", "No explicit agent receipt was provided; authorship is not inferred."), assuranceStateCard("Reviewer calibration", "Not reviewed", "Calibration events are opt-in and not present."), "</div><div class=\"card\" style=\"margin-top:12px\"><div class=\"card-body\"><p class=\"muted\">Use <code>tb evidence --format review-context</code> or <code>tb proof create</code> locally to export source-minimized evidence for this pull request.</p></div></div>"));
}

const settingsGroups = [
  { title: "Personal", items: [["account", "Account", "user"], ["security", "Security", "shield"], ["notifications", "Notifications", "bell"]] },
  { title: "Integrations", items: [["integrations", "MCP connections", "plugin"], ["billing", "Billing", "card"]] },
  { title: "Coding", items: [["policies", "Policies", "settings"], ["baselines", "Baselines", "archive"], ["report", "Report viewer", "files"]] },
  { title: "System", items: [["audit", "Audit log", "toolbox"]] },
  { title: "Archived", items: [["archived", "Deferred features", "archive"]] },
];

function settingsNav(section) {
  return h("<nav class=\"settings-nav\" aria-label=\"Settings sections\">", settingsGroups.map((group) => h("<div class=\"settings-nav-group\"><h2>", esc(group.title), "</h2>", group.items.map(([id, label, iconName]) => settingsLink("/app/settings/" + id, label, section === id, iconName)).join(""), "</div>")).join(""), "</nav>");
}

function settingsSidebar() {
  const activeSection = currentPath().split("/")[3] || "account";
  return h(
    "<nav class=\"settings-sidebar\" aria-label=\"Settings navigation\"><div class=\"settings-sidebar-header\"><a class=\"settings-back\" href=\"/app/overview\">",
    icon("arrow-left"),
    "<span>Back to app</span></a>",
    iconButton("toggle-mobile-nav", "x", "Close navigation", "", "mobile-nav-close"),
    "</div><label class=\"settings-search\"><span class=\"sr-only\">Search settings</span>",
    icon("search"),
    "<input data-settings-search placeholder=\"Search settings…\" aria-label=\"Search settings\" /></label>",
    settingsGroups.map((group) => h("<div class=\"settings-sidebar-group\" data-settings-group><h2>", esc(group.title), "</h2>", group.items.map(([id, label, iconName]) => settingsLink("/app/settings/" + id, label, activeSection === id, iconName, "data-settings-link data-search=\"" + esc(label.toLowerCase()) + "\"")).join(""), "</div>")).join(""),
    "<div class=\"settings-search-empty\" data-settings-empty hidden>No settings match that search.</div>",
    "</nav>",
  );
}

function settingsRow(title, description, control) {
  return h("<div class=\"settings-row\"><div><h3>", esc(title), "</h3><p>", esc(description), "</p></div><div class=\"settings-control\">", control, "</div></div>");
}

function accountSettings() {
  const session = state.session;
  return h("<div class=\"settings-group\"><h2>Profile</h2><div class=\"settings-card\">", settingsRow("Display name", "Used only in this development session.", "<input class=\"text-input\" value=\"" + esc(session?.name ?? "Developer") + "\" aria-label=\"Display name\" />"), settingsRow("Email", "A production provider would own email verification and change flows.", "<input class=\"text-input\" value=\"" + esc(session?.email ?? "") + "\" aria-label=\"Email\" type=\"email\" />"), settingsRow("Organization", "Current workspace selected for this local session.", "<span class=\"muted\">Atlas Engineering</span>"), "</div></div><div class=\"settings-group\"><h2>Environment</h2><div class=\"settings-card\">", settingsRow("Session mode", "This adapter is development-only and stores a short-lived session in local storage.", badge("Development only", "warning")), settingsRow("Plan", "Server-authoritative in production; preview data is not a billing claim.", badge(workspace.plan, "verified")), "</div></div><div class=\"page-actions\">", button("Save profile", "save-settings", "primary"), "</div>");
}

function securitySettings() {
  return h("<div class=\"settings-group\"><h2>Authentication</h2><div class=\"settings-card\">", settingsRow("Session lifetime", "Development sessions expire after eight hours.", "<span class=\"muted\">8 hours</span>"), settingsRow("Password reset", "Reset links require a configured production provider and token store.", badge("Unavailable", "unknown")), settingsRow("Current session", "Revoke the local session from this browser.", button("Sign out", "sign-out", "danger")), "</div></div><div class=\"callout\"><strong>No secrets are sent by the preview.</strong>The development adapter does not contact an identity provider and must be replaced before production use.</div>");
}

function notificationSettings() {
  return h("<div class=\"settings-group\"><h2>Notifications</h2><div class=\"settings-card\">", settingsRow("Finding digest", "A hosted notification channel is not configured.", "<button class=\"switch\" data-action=\"toggle-setting\" aria-label=\"Toggle finding digest\"></button>"), settingsRow("Run completion", "Local CLI output remains available without notification delivery.", "<button class=\"switch on\" data-action=\"toggle-setting\" aria-label=\"Toggle run completion\"></button>"), settingsRow("Billing alerts", "Billing alerts require a provider webhook and server-side delivery.", badge("Unavailable", "unknown")), "</div></div><div class=\"page-actions\">", button("Save notification settings", "save-settings", "primary"), "</div>");
}

function integrationSettings() {
  return h("<div class=\"settings-group\"><h2>Connected services</h2><div class=\"settings-card\">", settingsRow("GitHub App", "Repository sync and hosted checks are not configured.", badge("Not connected", "unknown")), settingsRow("Billing provider", "Checkout, webhook ingestion, and invoices are not configured.", badge("Unavailable", "unknown")), settingsRow("Local report viewer", "Reads a structured report file in this local browser session.", badge("Available", "verified")), "</div></div><div class=\"callout\"><strong>Provider status is honest by design.</strong>No button in this preview starts a checkout, creates a hosted session, or claims a webhook was processed.</div>");
}

function billingSettings() {
  if (hostedApiBase()) {
    if (state.hosted.billingLoading && !state.hosted.billingLoaded) return h("<div class=\"empty-state\"><h3>Loading billing</h3><p>Reading server-authorized subscription and entitlement state.</p></div>");
    if (state.hosted.billingError) return h("<div class=\"callout\"><strong>Billing could not be loaded.</strong>", esc(state.hosted.billingError), "</div>");
    const summary = state.hosted.billing;
    if (summary) {
      const account = summary.account ?? {};
      const entitlement = summary.entitlements ?? {};
      const catalog = Array.isArray(summary.plans) ? summary.plans : [];
      const currentPlan = account.planId || entitlement.planId || "No paid plan";
      const status = account.status || entitlement.billingStatus || "inactive";
      const planOptions = catalog.map((plan) => h("<div class=\"plan-option", plan.id === currentPlan ? " current" : "", "\"><h3>", esc(plan.id), "</h3><p>", esc(plan.privateRepositoryLimit), " private repositories · ", esc(plan.memberLimit), " members · ", esc(plan.retentionDays), " days retention</p>", plan.id === currentPlan ? badge("Current", "verified") : button("Choose monthly", "billing-checkout", "small", "data-plan=\"" + esc(plan.id) + "\" data-interval=\"month\""), plan.annualBillingAvailable && plan.id !== currentPlan ? button("Choose annual", "billing-checkout", "small", "data-plan=\"" + esc(plan.id) + "\" data-interval=\"year\"") : "", "</div>")).join("");
      const management = account.customerId ? button("Billing portal", "billing-portal", "secondary") : "";
      const subscriptionAction = account.subscriptionId ? account.cancelAtPeriodEnd ? button("Reactivate subscription", "billing-reactivate", "secondary") : button("Cancel at period end", "billing-cancel", "secondary") : "";
      return h("<div class=\"billing-grid\"><div class=\"card\"><div class=\"card-header\"><div><h2>Current plan</h2><p>Authoritative Stripe and entitlement state.</p></div>", badge(status, ["active", "trialing"].includes(status) ? "verified" : "warning"), "</div><div class=\"card-body\"><div class=\"plan-hero\"><div><h2>", esc(currentPlan), "</h2><p>", esc(entitlement.privateRepositoryLimit ?? 0), " private repositories · ", esc(entitlement.memberLimit ?? 0), " members</p></div></div><div class=\"page-actions\" style=\"margin-top:18px\">", management, subscriptionAction, "</div></div></div><div class=\"card\"><div class=\"card-header\"><div><h2>Available plans</h2><p>Checkout uses server-configured Stripe Price IDs.</p></div></div><div class=\"plan-list\">", planOptions || "<div class=\"empty-state\"><p>No server-side plans are configured.</p></div>", "</div></div></div><div class=\"callout\" style=\"margin-top:18px\"><strong>Entitlements are enforced server-side.</strong>Webhook state, not this page, controls paid capabilities.</div>");
    }
  }
  const used = workspace.activePrivateRepositories / workspace.privateRepositoryLimit * 100;
  return h("<div class=\"billing-grid\"><div class=\"card\"><div class=\"card-header\"><div><h2>Current plan</h2><p>Preview entitlement snapshot for Atlas Engineering.</p></div>", badge("Preview", "warning"), "</div><div class=\"card-body\"><div class=\"plan-hero\"><div><h2>", esc(workspace.plan), "</h2><p>", workspace.activePrivateRepositories, " of ", workspace.privateRepositoryLimit, " private repositories connected</p></div><strong class=\"plan-price\">$19/mo</strong></div><div class=\"usage-bar\" style=\"margin-top:22px\"><span style=\"width:", String(Math.min(100, used)), "%\"></span></div><div class=\"usage-meta\"><span>Private repository capacity</span><span>", workspace.activePrivateRepositories, "/", workspace.privateRepositoryLimit, "</span></div><div class=\"callout\" style=\"margin-top:18px\"><strong>Billing provider unavailable.</strong>A production provider, checkout session, webhook ledger, and server-side entitlement service are not configured.</div></div></div><div class=\"card\"><div class=\"card-header\"><div><h2>Available plans</h2><p>Catalog values are configuration, not a live price quote.</p></div></div><div class=\"plan-list\">", plans.map((plan) => h("<div class=\"plan-option", plan.name === workspace.plan ? " current" : "", "\"><h3>", esc(plan.name), "</h3><strong>", esc(plan.price), plan.price === "$0" || plan.price === "Custom" ? "" : "/mo", "</strong><p>", esc(plan.detail), "</p>", plan.name === workspace.plan ? badge("Current", "verified") : button("Learn more", "billing-unavailable", "small"), "</div>")).join(""), "</div></div></div><div class=\"settings-group\" style=\"margin-top:18px\"><h2>Billing facts</h2><div class=\"billing-facts\"><div class=\"billing-fact\"><span>Payment method</span><strong>Not collected</strong></div><div class=\"billing-fact\"><span>Subscription status</span><strong>Provider unavailable</strong></div><div class=\"billing-fact\"><span>Entitlement source</span><strong>Server-side in production</strong></div><div class=\"billing-fact\"><span>Webhook state</span><strong>Not configured</strong></div></div></div>");
}

function auditSettings() {
  const events = [
    ["Report viewed", "Local report viewer", "just now"],
    ["Development session created", "Local auth adapter", "today"],
    ["Run summary imported", "pr-proof / run-2026-08-17", "12 min ago"],
  ];
  return h("<div class=\"settings-group\"><h2>Audit log</h2><div class=\"settings-card\"><div class=\"audit-list\">", events.map(([event, actor, time]) => h("<div class=\"audit-row\"><span class=\"task-check\">", icon("checkmark"), "</span><span class=\"row-main\"><strong>", esc(event), "</strong><span>", esc(actor), "</span></span><span class=\"row-meta\">", esc(time), "</span></div>")).join(""), "</div></div></div><div class=\"callout\"><strong>Preview audit events are local display data.</strong>Production audit records must be append-only, server-authorized, retention-bound, and exportable according to the organization plan.</div>");
}

function settingsPage(section = "account") {
  const panels = {
    account: ["Account", "Profile and workspace context.", accountSettings()],
    security: ["Security", "Authentication, sessions, and recovery state.", securitySettings()],
    notifications: ["Notifications", "Delivery preferences for hosted channels.", notificationSettings()],
    integrations: ["Integrations", "Provider configuration and capability status.", integrationSettings()],
    billing: ["Billing", "Plan, usage, and entitlement provider status.", billingSettings()],
    audit: ["Audit log", "Local preview events and production requirements.", auditSettings()],
    policies: ["Policies", "Local policy packs and review thresholds.", h("<div class=\"settings-group\"><h2>Policy controls</h2><div class=\"settings-card\">", settingsRow("Default review posture", "The local CLI reports evidence gaps without claiming a hosted merge decision.", badge("Advisory", "neutral")), settingsRow("Blocking unknowns", "Enable this only in a server-authorized production policy.", badge("Unavailable", "unknown")), settingsRow("Open policy workspace", "Review the full policy assignment across repositories.", button("Open policies", "open-policies", "small")), "</div></div>")],
    baselines: ["Baselines", "Repository-local fingerprints for new and resolved findings.", h("<div class=\"settings-group\"><h2>Baseline controls</h2><div class=\"settings-card\">", settingsRow("Baseline storage", "Baseline writes remain in the repository and are not uploaded by this preview.", badge("Local only", "verified")), settingsRow("Unknown findings", "Unknown evidence is kept visible until a local run verifies the path.", badge("Visible", "neutral")), settingsRow("Open baseline workspace", "Inspect baseline state for every connected repository.", button("Open baselines", "open-baselines", "small")), "</div></div>")],
    report: ["Report viewer", "Render structured PR Proof JSON without hosted authentication.", h("<div class=\"settings-group\"><h2>Local report viewer</h2><div class=\"settings-card\">", settingsRow("Source handling", "Only the selected JSON report is read in this browser session; source and full diffs stay local.", badge("Local only", "verified")), settingsRow("Viewer availability", "The bundled preview report is ready to inspect.", button("Open report viewer", "open-local-report", "small")), "</div></div>")],
    archived: ["Archived", "Deferred control-plane surfaces and retired settings.", h("<div class=\"empty-state\"><h3>No archived settings</h3><p>Deferred surfaces stay out of the active paid control-plane workflow until their provider contracts are ready.</p></div>")],
  };
  const selected = panels[section] ?? panels.account;
  return shell("Settings", h("<div class=\"settings-layout settings-content-only\"><div class=\"settings-panel\"><h1>", esc(selected[0]), "</h1><p>", esc(selected[1]), "</p>", selected[2], "</div></div>"));
}

function findingPanel(id) {
  const finding = findingById(id);
  if (!finding) return "";
  return h("<div class=\"finding-scrim\" data-action=\"close-finding\" aria-hidden=\"true\"></div><aside class=\"finding-panel\" aria-label=\"Finding details\"><div class=\"finding-panel-header\"><div><div class=\"eyebrow\">", esc(finding.evidence), "</div><h2>", esc(finding.title), "</h2><p class=\"finding-rule\">", esc(finding.rule), " · ", esc(finding.file), ":", esc(finding.line), "</p></div>", iconButton("close-finding", "x", "Close finding"), "</div><div class=\"finding-panel-body\"><div class=\"cluster\">", badge(finding.severity, finding.tone), badge(finding.status, finding.status === "Unknown" ? "unknown" : "neutral"), badge(finding.confidence + " confidence", finding.confidence === "High" ? "verified" : "warning"), "</div><div class=\"detail-section\"><h3>Why it matters</h3><p>", esc(finding.explanation), "</p></div><div class=\"detail-section\"><h3>Evidence</h3><div class=\"code-compare\"><div class=\"code-block before\">", esc(finding.before), "</div><div class=\"code-block after\">", esc(finding.after), "</div></div></div><div class=\"detail-section\"><h3>Suggested action</h3><p>", esc(finding.action), "</p></div><div class=\"detail-section\"><h3>Baseline</h3><p>", esc(finding.baseline), "</p></div></div></aside>");
}

function reportVerdictTone(verdict) {
  const normalized = String(verdict ?? "").toLowerCase();
  if (normalized === "pass" || normalized === "verified") return "verified";
  if (normalized === "fail" || normalized === "failed") return "failed";
  if (normalized.includes("review")) return "review";
  return "unknown";
}

function reportFindingRow(finding) {
  const tone = finding.severity === "high" ? "high" : finding.severity === "warning" ? "warning" : "info";
  const line = finding.startLine ?? finding.line ?? "—";
  return h("<div class=\"finding-row\"><span>", badge(String(finding.severity ?? "unknown").toUpperCase(), tone), "</span><span class=\"row-main\"><strong>", esc(finding.title ?? finding.message ?? finding.ruleId), "</strong><span class=\"finding-rule\">", esc(finding.ruleId ?? "finding"), " · ", esc(finding.file ?? "repository"), ":", esc(line), "</span><span>", esc(finding.suggestedAction ?? finding.explanation ?? finding.message ?? "Review the report evidence."), "</span></span><span class=\"row-end\">", badge(finding.resolution ?? "unknown", finding.resolution === "open" ? "neutral" : "unknown"), "</span></div>");
}

function validLocalReport(value) {
  return Boolean(value && typeof value === "object" && value.schemaVersion === 1 && typeof value.repository === "string" && typeof value.verdict === "string" && value.summary && typeof value.summary === "object" && Array.isArray(value.findings) && Array.isArray(value.limitations));
}

function localReportPage() {
  const report = state.report;
  const summary = report.summary ?? {};
  const tone = reportVerdictTone(report.verdict);
  return localReportShell(h(pageHeading("Local-only", "Report viewer", "Render a structured PR Proof report without hosted authentication or outbound upload.", h("<label class=\"button small secondary\" for=\"report-file\">Open JSON report</label>", button("Download preview JSON", "download-report", "small"))), "<div class=\"report-toolbar\"><div><strong>Source:</strong> ", esc(state.reportSource), "</div><input class=\"sr-only\" id=\"report-file\" type=\"file\" accept=\"application/json,.json\" data-report-file aria-label=\"Open local JSON report\" /></div><div class=\"preview-banner\"><span class=\"preview-badge\">Local only</span><div><strong>No source or full diff is uploaded.</strong>The viewer reads the selected JSON file in this browser and only renders its structured report fields.</div></div><div class=\"card\"><div class=\"card-header\"><div><h2>", esc(report.repository), "</h2><p>", esc(report.base), " → ", esc(report.head), " · generated ", esc(report.generatedAt ?? "unknown"), "</p></div>", badge(report.verdict, tone), "</div><div class=\"card-body\"><div class=\"repo-metric-grid\">", metric("Findings", report.findings.length), metric("Unknowns", report.limitations.length), metric("Changed-line coverage", summary.changedLinesCoveredPercentage == null ? "Unavailable" : String(summary.changedLinesCoveredPercentage) + "%"), metric("Changed symbols", summary.changedSymbols ?? "Unavailable"), metric("Impacted tests", summary.impactedTests ?? "Unavailable"), metric("Unverified paths", summary.unverifiedPaths ?? "Unavailable"), "</div></div><div class=\"card-header\"><div><h2>Findings</h2><p>Structured locations, explanations, and suggested actions.</p></div></div><div class=\"finding-list\">", report.findings.length ? report.findings.map(reportFindingRow).join("") : "<div class=\"card-body\"><div class=\"empty-state\"><h3>No findings</h3><p>This report contains no findings.</p></div></div>", "</div>", report.limitations.length ? h("<div class=\"card-body\"><div class=\"callout\"><strong>Limitations</strong><ul>", report.limitations.map((limitation) => h("<li>", esc(limitation), "</li>")).join(""), "</ul></div></div>") : "", "</div>"));
}

function authPage(mode = "sign-in") {
  const signUp = mode === "sign-up";
  const forgot = mode === "forgot-password";
  const reset = mode === "reset-password";
  const title = signUp ? "Create a preview account" : forgot ? "Recover access" : reset ? "Reset password" : "Welcome back";
  const description = signUp ? "Create a local-only session to explore the control plane." : forgot ? "Request a recovery link from the configured identity provider." : reset ? "Complete a reset using a provider-issued token." : "Sign in to the local control-plane preview.";
  let fields = "";
  if (signUp) fields += "<div class=\"field\"><label for=\"name\">Name</label><input id=\"name\" name=\"name\" autocomplete=\"name\" required /></div>";
  fields += "<div class=\"field\"><label for=\"email\">Email</label><input id=\"email\" name=\"email\" type=\"email\" autocomplete=\"email\" required /></div>";
  if (!forgot) fields += "<div class=\"field\"><label for=\"password\">Password</label><input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"" + (signUp ? "new-password" : "current-password") + "\" minlength=\"8\" required /><span class=\"field-hint\">Use any 8+ character development password.</span></div>";
  if (reset) fields += "<div class=\"field\"><label for=\"confirm-password\">Confirm password</label><input id=\"confirm-password\" name=\"confirmPassword\" type=\"password\" autocomplete=\"new-password\" minlength=\"8\" required /></div>";
  const submitLabel = signUp ? "Create preview session" : forgot ? "Request reset link" : reset ? "Reset password" : "Sign in";
  const links = signUp ? "<a href=\"/sign-in\">Already have a session? Sign in</a><a href=\"/forgot-password\">Forgot password?</a>" : forgot || reset ? "<a href=\"/sign-in\">Back to sign in</a><a href=\"/sign-up\">Create preview account</a>" : "<a href=\"/sign-up\">Create preview account</a><a href=\"/forgot-password\">Forgot password?</a>";
  return h("<div class=\"auth-page\"><div class=\"auth-story\"><div class=\"brand\"><span class=\"brand-wordmark\">pr-proof</span><span class=\"brand-subtitle\">control plane</span></div><div class=\"auth-copy\"><div class=\"eyebrow\">Local-first verification</div><h1>Make evidence legible.</h1><p>Review proof-of-test, impact, coverage, mutation, baseline, and policy state in one calm workspace.</p><div class=\"auth-points\"><div class=\"auth-point\"><strong>Structured</strong>Reports keep facts and unknowns separate.</div><div class=\"auth-point\"><strong>Private by default</strong>Source stays in the repository.</div><div class=\"auth-point\"><strong>Honest states</strong>Unavailable providers remain unavailable.</div></div></div><div class=\"auth-footer\"><span>Development preview</span><a href=\"/local/report\">View local report</a></div></div><div class=\"auth-panel\"><div class=\"auth-card\"><h2>", title, "</h2><p>", description, "</p><form class=\"auth-form\" data-auth-form=\"", esc(mode), "\">", fields, "<div data-auth-message></div><button class=\"button primary full\" type=\"submit\">", submitLabel, "</button></form><div class=\"auth-links\">", links, "</div><div class=\"dev-note\">No email, password, token, or production session is sent anywhere by this preview.</div></div></div></div>", toastMarkup());
}

function notFoundPage() {
  return shell("Not found", h(pageHeading("Control plane", "Page not found", "This route is not part of the paid control-plane surface."), "<div class=\"empty-state\"><h3>Nothing here yet</h3><p>Use the workspace navigation to return to evidence, repositories, or settings.</p><a class=\"button primary\" href=\"/app/overview\">Back to overview</a></div>"));
}

function renderRoute(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (pathname === "/app" || pathname === "/app/overview") return overview();
  if (pathname === "/app/repositories") return repositoriesPage();
  if (segments[0] === "app" && segments[1] === "repositories" && segments[2]) return repositoryPage(segments[2], segments[3] ?? "overview");
  if (pathname === "/app/history") return historyPage();
  if (pathname === "/app/runs") return runsPage();
  if (segments[0] === "app" && segments[1] === "runs" && segments[2] && segments[3] === "assurance") return runAssurancePage(segments[2]);
  if (segments[0] === "app" && segments[1] === "runs" && segments[2]) return runPage(segments[2]);
  if (pathname === "/app/findings") return findingsPage();
  if (segments[0] === "app" && segments[1] === "findings" && segments[2]) return findingById(segments[2]) ? findingsPage() : notFoundPage();
  if (pathname === "/app/policies") return policiesPage();
  if (pathname === "/app/baselines") return baselinesPage();
  if (pathname === "/app/change-sets") return changeSetsPage();
  if (pathname === "/app/releases") return releasesPage();
  if (pathname === "/app/outcomes") return outcomesPage();
  if (pathname === "/app/team") return teamPage();
  if (pathname === "/app/integrations") return integrationsPage();
  if (pathname === "/app/settings" || pathname === "/app/settings/") return settingsPage("account");
  if (segments[0] === "app" && segments[1] === "settings" && segments[2]) return settingsPage(segments[2]);
  return notFoundPage();
}

function renderCurrent() {
  const pathname = currentPath();
  const authModes = {
    "/sign-in": "sign-in",
    "/sign-up": "sign-up",
    "/forgot-password": "forgot-password",
    "/reset-password": "reset-password",
  };
  if (authModes[pathname]) {
    app.innerHTML = authPage(authModes[pathname]);
    return;
  }
  if (pathname === "/local/report") {
    app.innerHTML = localReportPage();
    return;
  }
  if (!state.session) {
    app.innerHTML = authPage("sign-in");
    return;
  }
  if (pathname.startsWith("/app/findings/")) {
    const findingId = pathname.split("/")[3] ?? null;
    state.selectedFindingId = findingById(findingId) ? findingId : null;
  }
  if (pathname !== "/app/findings" && !pathname.startsWith("/app/findings/")) state.selectedFindingId = null;
  app.innerHTML = renderRoute(pathname);
  applyFilters();
  if (state.paletteOpen) window.setTimeout(() => document.querySelector("[data-palette-search]")?.focus(), 0);
}

async function navigate(pathname = currentPath()) {
  state.session = await auth.getSession();
  if (pathname.startsWith("/app") && !state.session) {
    const returnTo = safeReturnTo(pathname + window.location.search);
    window.history.replaceState({}, "", "/sign-in?returnTo=" + encodeURIComponent(returnTo));
    state.mobileNav = false;
    renderCurrent();
    return;
  }
  if (state.session && ["/sign-in", "/sign-up"].includes(pathname)) {
    window.history.replaceState({}, "", "/app/overview");
  }
  state.mobileNav = false;
  state.accountMenu = false;
  state.orgMenu = false;
  renderCurrent();
  if (pathname === "/app/team") void loadHostedTeam();
  if (pathname === "/app/settings/billing") void loadHostedBilling();
}

function applyFilters() {
  const findingQuery = state.filters.findingQuery.toLowerCase().trim();
  const severity = state.filters.findingSeverity;
  const status = state.filters.findingStatus;
  document.querySelectorAll("[data-filter-row][data-filter-group=\"findings\"]").forEach((row) => {
    const matches = (!findingQuery || (row.dataset.search ?? "").includes(findingQuery)) && (severity === "all" || row.dataset.severity === severity) && (status === "all" || row.dataset.status === status);
    row.hidden = !matches;
  });
  const runQuery = state.filters.runQuery.toLowerCase().trim();
  const verdict = state.filters.runVerdict;
  document.querySelectorAll("[data-filter-row][data-filter-group=\"runs\"]").forEach((row) => {
    row.hidden = !(!runQuery || (row.dataset.search ?? "").includes(runQuery)) || !(verdict === "all" || row.dataset.verdict === verdict);
  });
  applySettingsSearch(document.querySelector("[data-settings-search]")?.value ?? "");
}

function applySettingsSearch(value) {
  const query = String(value).toLowerCase().trim();
  let visibleLinks = 0;
  document.querySelectorAll("[data-settings-group]").forEach((group) => {
    let groupHasMatch = false;
    group.querySelectorAll("[data-settings-link]").forEach((link) => {
      const matches = !query || (link.dataset.search ?? "").includes(query);
      link.hidden = !matches;
      groupHasMatch ||= matches;
      if (matches) visibleLinks += 1;
    });
    group.hidden = !groupHasMatch;
  });
  const emptyState = document.querySelector("[data-settings-empty]");
  if (emptyState) emptyState.hidden = Boolean(!query || visibleLinks);
}

function handleFilterInput(target) {
  const name = target.dataset.filter;
  if (name === "finding-query") state.filters.findingQuery = target.value;
  if (name === "finding-severity") state.filters.findingSeverity = target.value;
  if (name === "finding-status") state.filters.findingStatus = target.value;
  if (name === "run-query") state.filters.runQuery = target.value;
  if (name === "run-verdict") state.filters.runVerdict = target.value;
  applyFilters();
}

function downloadReport() {
  const blob = new Blob([JSON.stringify(state.report, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "pr-proof-report.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast("Report exported", "The structured report was downloaded locally. No source or full diff was added.");
}

async function loadReportFile(file) {
  try {
    const value = JSON.parse(await file.text());
    if (!validLocalReport(value)) throw new Error("The file is not a compatible PR Proof report v1.");
    state.report = value;
    state.reportSource = "local file: " + file.name;
    showToast("Report loaded locally", "The JSON was parsed in this browser session only.");
  } catch (error) {
    showToast("Report not loaded", error instanceof Error ? error.message : "The selected file could not be read.");
  }
}

document.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  const action = actionElement?.dataset.action;
  if (action === "close-palette") {
    if (event.target === actionElement) {
      state.paletteOpen = false;
      renderCurrent();
    }
    return;
  }
  if (action === "open-palette") {
    state.paletteOpen = true;
    state.accountMenu = false;
    state.orgMenu = false;
    renderCurrent();
    return;
  }
  if (action === "toggle-mobile-nav") {
    if (window.matchMedia("(max-width: 767px)").matches) {
      state.mobileNav = !state.mobileNav;
    } else {
      state.sidebarOpen = !state.sidebarOpen;
    }
    renderCurrent();
    return;
  }
  if (action === "toggle-account") {
    state.accountMenu = !state.accountMenu;
    state.orgMenu = false;
    renderCurrent();
    return;
  }
  if (action === "toggle-org") {
    state.orgMenu = !state.orgMenu;
    state.accountMenu = false;
    renderCurrent();
    return;
  }
  if (action === "open-finding") {
    event.preventDefault();
    state.selectedFindingId = actionElement.dataset.finding;
    renderCurrent();
    return;
  }
  if (action === "close-finding") {
    if (currentPath().startsWith("/app/findings/")) window.history.replaceState({}, "", "/app/findings");
    state.selectedFindingId = null;
    renderCurrent();
    return;
  }
  if (action === "dismiss-toast") {
    state.toast = null;
    renderCurrent();
    return;
  }
  if (action === "sign-out") {
    event.preventDefault();
    void auth.signOut().then(() => {
      state.session = null;
      window.history.pushState({}, "", "/sign-in");
      navigate("/sign-in");
    });
    return;
  }
  if (action === "open-local-report") {
    event.preventDefault();
    window.history.pushState({}, "", "/local/report");
    navigate("/local/report");
    return;
  }
  if (action === "download-report") {
    event.preventDefault();
    downloadReport();
    return;
  }
  if (action === "open-policies" || action === "open-baselines") {
    event.preventDefault();
    const destination = action === "open-policies" ? "/app/policies" : "/app/baselines";
    window.history.pushState({}, "", destination);
    navigate(destination);
    return;
  }
  if (action === "open-repository") {
    event.preventDefault();
    window.history.pushState({}, "", "/app/repositories/" + actionElement.dataset.repository);
    navigate();
    return;
  }
  if (action === "invite-member") {
    event.preventDefault();
    if (!hostedApiBase()) {
      showToast("Invitation unavailable", "Configure the hosted control-plane API and WorkOS before sending member invitations.");
      return;
    }
    state.hosted.inviteOpen = true;
    state.hosted.inviteMessage = null;
    renderCurrent();
    window.setTimeout(() => document.querySelector("#invite-email")?.focus(), 0);
    return;
  }
  if (action === "close-invite") {
    event.preventDefault();
    state.hosted.inviteOpen = false;
    state.hosted.inviteSubmitting = false;
    state.hosted.inviteMessage = null;
    renderCurrent();
    return;
  }
  if (["billing-checkout", "billing-portal", "billing-cancel", "billing-reactivate"].includes(action)) {
    event.preventDefault();
    if (state.hosted.billingSubmitting) return;
    state.hosted.billingSubmitting = true;
    const path = action === "billing-checkout" ? "/billing/checkout" : action === "billing-portal" ? "/billing/portal" : action === "billing-cancel" ? "/billing/subscription/cancel" : "/billing/subscription/reactivate";
    const body = action === "billing-checkout" ? { planId: actionElement.dataset.plan, interval: actionElement.dataset.interval } : {};
    void hostedRequest(path, { method: "POST", body: JSON.stringify(body) })
      .then((result) => {
        const redirect = result.checkout?.url || result.portal?.url;
        if (redirect) {
          window.location.assign(redirect);
          return;
        }
        showToast(action === "billing-cancel" ? "Cancellation scheduled" : "Subscription updated", "Stripe accepted the server-authorized billing change.");
        return loadHostedBilling(true);
      })
      .catch((error) => showToast("Billing action failed", error instanceof Error ? error.message : "The billing action could not be completed."))
      .finally(() => {
        state.hosted.billingSubmitting = false;
      });
    return;
  }
  if (["connect-repository", "repository-settings", "run-local-check", "policy-unavailable", "baseline-unavailable", "organization-unavailable", "invite-member", "integration-unavailable", "billing-unavailable", "save-settings", "toggle-setting"].includes(action)) {
    event.preventDefault();
    const messages = {
      "connect-repository": ["Repository provider unavailable", "Connectors are not configured; use the local CLI and report viewer for now."],
      "repository-settings": ["Repository settings unavailable", "Hosted repository sync is not connected in this preview."],
      "run-local-check": ["Run locally", "Use pr-proof check in the repository, then open the generated JSON report here."],
      "policy-unavailable": ["Policy change not persisted", "The preview shows policy state but does not fake a server-authorized write."],
      "baseline-unavailable": ["Baseline stays local", "Use the CLI baseline command to write repository-local baseline metadata."],
      "organization-unavailable": ["Organization switching unavailable", "The development adapter exposes one local organization."],
      "invite-member": ["Invitation unavailable", "A production identity provider is required before member invitations can be sent."],
      "integration-unavailable": ["Integration unavailable", "No hosted provider credentials are configured in this environment."],
      "billing-unavailable": ["Checkout unavailable", "No billing provider or server-side entitlement service is configured."],
      "save-settings": ["Settings not persisted", "This development preview keeps settings controls honest and does not claim a hosted write."],
      "toggle-setting": ["Preference preview only", "Notification preferences require a configured delivery provider."],
    };
    showToast(messages[action][0], messages[action][1]);
    return;
  }
  const anchor = event.target.closest("a[href]");
  const href = anchor?.getAttribute("href");
  if (href && href.startsWith("/") && !href.startsWith("//")) {
    event.preventDefault();
    window.history.pushState({}, "", href);
    navigate();
  }
});

document.addEventListener("submit", (event) => {
  const invitationForm = event.target.closest("form[data-invite-form]");
  if (invitationForm) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(invitationForm).entries());
    state.hosted.inviteSubmitting = true;
    state.hosted.inviteMessage = null;
    renderCurrent();
    void hostedRequest("/tenant/invitations", { method: "POST", body: JSON.stringify({ email: String(values.email ?? ""), role: String(values.role ?? "viewer") }) })
      .then((result) => {
        if (result.invitation) state.hosted.invitations = [result.invitation, ...state.hosted.invitations];
        state.hosted.inviteOpen = false;
        state.hosted.teamLoaded = true;
        showToast("Invitation sent", "WorkOS accepted the invitation and the provider will deliver the email.");
      })
      .catch((error) => {
        state.hosted.inviteMessage = error instanceof Error ? error.message : "The invitation could not be sent.";
      })
      .finally(() => {
        state.hosted.inviteSubmitting = false;
        renderCurrent();
      });
    return;
  }
  const form = event.target.closest("form[data-auth-form]");
  if (!form) return;
  event.preventDefault();
  const mode = form.dataset.authForm;
  const values = Object.fromEntries(new FormData(form).entries());
  const message = form.querySelector("[data-auth-message]");
  if (mode === "forgot-password") {
    auth.requestPasswordReset(String(values.email ?? "")).then((result) => {
      message.innerHTML = "<div class=\"" + (result.accepted ? "auth-success" : "auth-error") + "\" role=\"status\">" + esc(result.message) + "</div>";
    });
    return;
  }
  if (mode === "reset-password") {
    message.innerHTML = "<div class=\"auth-error\" role=\"alert\">A provider-issued reset token is required. The development adapter does not accept password reset writes.</div>";
    return;
  }
  const request = mode === "sign-up"
    ? auth.signUp({ name: String(values.name ?? ""), email: String(values.email ?? ""), password: String(values.password ?? "") })
    : auth.signIn({ email: String(values.email ?? ""), password: String(values.password ?? "") });
  request.then((result) => {
    if (result.error) {
      message.innerHTML = "<div class=\"auth-error\" role=\"alert\">" + esc(result.error) + "</div>";
      return;
    }
    state.session = result.session ?? null;
    const returnTo = mode === "sign-in" ? safeReturnTo(currentSearch().get("returnTo")) : "/app/overview";
    window.history.pushState({}, "", returnTo);
    navigate(returnTo);
  });
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches("[data-filter]")) handleFilterInput(target);
  if (target.matches("[data-report-file]") && target.files?.[0]) void loadReportFile(target.files[0]);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches("[data-filter]")) handleFilterInput(target);
  if (target.matches("[data-settings-search]")) applySettingsSearch(target.value);
  if (target.matches("[data-palette-search]")) {
    const query = target.value.toLowerCase().trim();
    document.querySelectorAll("[data-palette-item]").forEach((item) => {
      item.hidden = Boolean(query) && !(item.dataset.search ?? "").includes(query);
    });
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    state.paletteOpen = true;
    renderCurrent();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    if (window.matchMedia("(max-width: 767px)").matches) {
      state.mobileNav = !state.mobileNav;
    } else {
      state.sidebarOpen = !state.sidebarOpen;
    }
    renderCurrent();
    return;
  }
  if (event.key === "Escape") {
    if (state.paletteOpen || state.accountMenu || state.orgMenu || state.selectedFindingId || state.mobileNav || !state.sidebarOpen) {
      state.paletteOpen = false;
      state.accountMenu = false;
      state.orgMenu = false;
      state.selectedFindingId = null;
      state.mobileNav = false;
      state.sidebarOpen = true;
      renderCurrent();
    }
  }
});

window.addEventListener("popstate", () => void navigate());
void navigate();
