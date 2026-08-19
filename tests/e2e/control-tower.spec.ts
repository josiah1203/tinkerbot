import { test, expect, type Page } from "@playwright/test";

const workOrders = [
  { workOrderId: "wo-attention", issueOrPullRequest: "Verification failed on auth", repositoryId: "acme/payments", lineId: "security", status: "failed", currentStage: "verification", group: "needs_attention", outputKind: "pr", autonomyMode: "restricted", intent: "Repair the auth finding." },
  { workOrderId: "wo-progress", issueOrPullRequest: "Implement checkout", repositoryId: "acme/payments", lineId: "feature", status: "implementation", currentStage: "implementation", group: "in_progress", outputKind: "pr", autonomyMode: "approval_gated" },
  { workOrderId: "wo-approval", issueOrPullRequest: "Spec for refunds", repositoryId: "acme/payments", lineId: "feature", status: "specification", currentStage: "specification", group: "waiting_for_approval", outputKind: "spec", autonomyMode: "approval_gated" },
  { workOrderId: "wo-blocked", issueOrPullRequest: "Unmapped repository", repositoryId: "acme/unknown", lineId: "feature", status: "blocked", currentStage: "foreman", group: "blocked", outputKind: "pr", autonomyMode: "restricted" },
  { workOrderId: "wo-done", issueOrPullRequest: "Docs typo", repositoryId: "acme/payments", lineId: "bugfix", status: "released", currentStage: "complete", group: "completed", outputKind: "pr", autonomyMode: "policy_autonomous" },
];

const proposals = [
  { proposal_id: "prop_1", title: "Add reviewer checklist", status: "draft", evidence_json: "[\"8 similar PRs\"]" },
];

function json(route: { fulfill: (init: { status?: number; contentType?: string; body: string }) => Promise<void> }, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function apiPath(url: URL, prefix: string): boolean {
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

async function mockControlPlane(page: Page, options: { signedIn?: boolean; evolutionStatus?: number } = {}) {
  const posts: Array<{ path: string; method: string }> = [];
  await page.route((url) => apiPath(url, "/auth/session"), (route) => {
    if (options.signedIn === false) return json(route, { authenticated: false, code: "not_authenticated" }, 401);
    return json(route, { authenticated: true, organizationId: "org_1", user: { id: "user_1", email: "alex@example.com" } });
  });
  await page.route((url) => apiPath(url, "/work-orders"), async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    posts.push({ path: url.pathname, method });
    if (method === "POST") return json(route, { ok: true, specApproved: url.pathname.endsWith("/approve") });
    return json(route, { workOrders });
  });
  await page.route((url) => apiPath(url, "/evolution"), async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    posts.push({ path: url.pathname, method });
    if (method === "POST") return json(route, { error: "Release Steward cannot approve its own activation.", code: "steward_cannot_self_approve" }, options.evolutionStatus ?? 409);
    return json(route, { proposals });
  });
  await page.route((url) => apiPath(url, "/products"), (route) => json(route, { products: [{ name: "payments", risk_class: "high" }] }));
  await page.route((url) => apiPath(url, "/cells"), (route) => json(route, { cells: [{ repository: "acme/payments", branch: "tinkerbot/wo", status: "leased", kind: "sandbox" }] }));
  await page.route((url) => apiPath(url, "/releases"), (route) => json(route, { releases: [{ release_id: "rc1", status: "blocked", commit_sha: "" }] }));
  await page.route((url) => apiPath(url, "/outcomes"), (route) => json(route, { outcomes: [{ kind: "successful_release", association: "human" }] }));
  await page.route((url) => apiPath(url, "/factories"), (route) => {
    if (route.request().method() === "POST") return json(route, { factory: { factoryId: "fac_new", name: "demo", status: "active" } }, 201);
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/factories/fac_1")) {
      return json(route, {
        factory: { factoryId: "fac_1", name: "payments", status: "active", alias: "payments" },
        activity: workOrders.map((order) => ({
          ...order,
          column: order.status === "implementation" ? "building" : order.status === "specification" ? "planning" : order.status === "failed" || order.status === "blocked" ? "blocked" : order.status === "released" ? "done" : "triage",
        })),
        runs: [{ run_id: "run_1", work_order_id: "wo-progress", status: "running" }],
        scorers: [{ name: "tb-check-gate", criteria: "tb check ingested", upgradesVerdict: false }],
        selfImprovement: [{ title: "factory-eval: tb-check-gate", status: "open", autoMerge: false }],
        automations: [{ name: "labeled-issue", agent: "foreman", enabled: true }],
        agents: [{ id: "foreman", agentType: "FOREMAN", model: "@cf/openai/gpt-oss-120b" }],
        definitionFiles: [{ path: ".tinkerbot/factory.yaml", contents: "name: payments" }],
        metrics: { opened: 2, merged: 1, estimatedCostCents: 0, autonomyShare: null, caption: "Estimated COGS, not billing." },
      });
    }
    return json(route, { factories: [{ factoryId: "fac_1", name: "payments", status: "active" }] });
  });
  await page.route((url) => apiPath(url, "/usage"), (route) => json(route, { usage: [] }));
  await page.route((url) => apiPath(url, "/billing/summary"), (route) => json(route, { planId: "developer", subscriptionState: "active", activeBillableSeats: 1, pricePerSeatCents: 2000, paidSeatCap: "none", account: { planId: "developer", status: "active" } }));
  await page.route((url) => apiPath(url, "/billing/trial/start"), async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    return json(route, { pending: false, trial: { state: "trialing" }, grantedFromRedirect: false });
  });
  await page.route((url) => apiPath(url, "/billing/portal"), async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    return json(route, { portal: { url: "https://billing.example/session" } });
  });
  await page.route((url) => apiPath(url, "/skills"), (route) => json(route, { skills: [] }));
  await page.route((url) => apiPath(url, "/tenant/organizations"), (route) => json(route, { organizations: [{ organizationId: "org_1", role: "owner" }] }));
  await page.route((url) => apiPath(url, "/org/seats"), (route) => json(route, { activeBillableSeats: 1 }));
  await page.route((url) => apiPath(url, "/integrations/github"), (route) => json(route, { installed: false }));
  return posts;
}

test("signed-out marketing is not the control tower", async ({ page }) => {
  await mockControlPlane(page, { signedIn: false });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tinkerbot Factory OS" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Inbox" })).toHaveCount(0);
  await expect(page.getByText("Triage")).toHaveCount(0);
  await expect(page.getByText("Planning")).toHaveCount(0);
  await expect(page.getByText("Building")).toHaveCount(0);
});

test("login is a dedicated auth screen, not the homepage", async ({ page }) => {
  await mockControlPlane(page, { signedIn: false });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with WorkOS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tinkerbot Factory OS" })).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
});

test("signed-in inbox is exception-first, not a kanban", async ({ page }) => {
  await mockControlPlane(page);
  await page.goto("/app/overview");
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "In progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blocked" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently completed" })).toBeVisible();
  await expect(page.getByText("Verification failed on auth")).toBeVisible();
  await expect(page.getByText("security")).toBeVisible();
  await expect(page.getByText("Triage")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start trial" })).toHaveCount(0);
  await expect(page.locator(".marketing-header")).toHaveCount(0);
});

test("work-order detail is list plus detail and keeps steer off the home view", async ({ page }) => {
  const posts = await mockControlPlane(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByPlaceholder("Steer the Foreman")).toHaveCount(0);
  await page.goto("/app/work-orders/wo-attention");
  await expect(page).toHaveURL(/\/app\/work\/wo-attention$/);
  await expect(page.locator(".work-split")).toBeVisible();
  await expect(page.getByText("Producing: pr.")).toBeVisible();
  await expect(page.getByText("line security")).toBeVisible();
  await expect(page.getByText("Blocking:")).toBeVisible();
  await expect(page.getByText("Next:")).toBeVisible();
  await expect(page.getByPlaceholder("Steer the Foreman")).toBeVisible();
  await page.getByRole("button", { name: "Take cell" }).click();
  await page.getByRole("button", { name: "Return cell" }).click();
  await expect.poll(() => posts.some((item) => item.path.endsWith("/take") && item.method === "POST")).toBe(true);
  await expect.poll(() => posts.some((item) => item.path.endsWith("/return") && item.method === "POST")).toBe(true);
  await page.goto("/app/work/wo-approval");
  await page.getByRole("button", { name: "Approve spec" }).click();
  await expect.poll(() => posts.some((item) => item.path.endsWith("/approve") && item.method === "POST")).toBe(true);
});

test("factory activity uses Warp stage names without turning Inbox into a kanban", async ({ page }) => {
  await mockControlPlane(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Triage")).toHaveCount(0);
  await page.goto("/app/factories/fac_1/activity");
  await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Planning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Building" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Activity" })).toBeVisible();
  await page.goto("/app/factories/fac_1/scorers");
  await expect(page.getByText("cannot upgrade verdict")).toBeVisible();
  await page.goto("/app/factories/fac_1/self-improvement");
  await expect(page.getByText("auto-merge forbidden")).toBeVisible();
});

test("evolution shows evidence, forbids auto-merge, and keeps a steward self-approve as 409", async ({ page }) => {
  await mockControlPlane(page, { evolutionStatus: 409 });
  await page.goto("/app/evolution");
  await expect(page.getByText("Add reviewer checklist")).toBeVisible();
  await expect(page.getByText("auto-merge forbidden")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("auto-merge forbidden")).toBeVisible();
});

test("public pricing and signed-in billing stay seat-based", async ({ page }) => {
  await mockControlPlane(page, { signedIn: false });
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  await expect(page.getByText("Developer $20/mo, Team $40/mo, Business $60/mo per active human seat")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await mockControlPlane(page);
  await page.goto("/app/settings/billing");
  await expect(page.getByText("developer", { exact: false })).toBeVisible();
  await expect(page.getByText("$20")).toBeVisible();
  await expect(page.getByText("Paid seat and repository caps: none.")).toBeVisible();
  await page.getByRole("button", { name: "Start Team trial" }).click();
});

test("factory wizard and settings destinations stay honest", async ({ page }) => {
  await mockControlPlane(page);
  await page.goto("/app/factories");
  await page.getByRole("link", { name: "New factory" }).click();
  await expect(page).toHaveURL(/\/app\/factories\/new/);
  await page.getByPlaceholder("payments").first().fill("demo");
  await page.getByPlaceholder("acme").fill("acme");
  await page.getByPlaceholder("payments").nth(1).fill("payments");
  await page.getByRole("button", { name: "Create factory" }).click();
  await expect(page).toHaveURL(/\/app\/factories\/fac_new/);
  await page.goto("/app/factories/fac_1/agents");
  await expect(page.getByText("foreman", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /save|edit/i })).toHaveCount(0);
  await page.goto("/app/settings/gitlab");
  await expect(page.getByText("never merges a GitLab MR")).toBeVisible();
  await page.goto("/app/settings/export");
  await expect(page.getByText("Export failure does not change")).toBeVisible();
});

test("command palette opens factory wizard from the inbox", async ({ page }) => {
  await mockControlPlane(page);
  await page.goto("/app");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
  await page.getByPlaceholder("Go to inbox").fill("new factory");
  await page.getByRole("link", { name: "New factory" }).click();
  await expect(page).toHaveURL(/\/app\/factories\/new/);
  await expect(page.locator(".breadcrumbs strong")).toHaveText("New factory");
});
