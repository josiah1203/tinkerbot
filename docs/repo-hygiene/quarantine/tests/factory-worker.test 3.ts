import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import { createSelfHostedCompletion, implementBranchName, resetOidcJwksCache } from "../packages/factory/src";
import worker, { FactoryRunWorkflow, handleFactoryQueueMessage } from "../apps/control-plane-worker/src";
import { D1FactoryStore } from "../apps/control-plane-worker/src/factory-store";
import { ForemanDurableObject, handleFactoryMcpRequest, intakeFromIntegration, persistTranscript, runFactoryTurn, sweepFactoryOs } from "../apps/control-plane-worker/src/factory-runtime";

function cookieFrom(response: Response, name: string): string {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie().join("; ") : (response.headers.get("set-cookie") ?? "");
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`Missing cookie ${name} in ${raw}`);
  return decodeURIComponent(match[1]);
}

function oauthCookieHeader(response: Response): string {
  return `tinkerbot_oauth_state=${encodeURIComponent(cookieFrom(response, "tinkerbot_oauth_state"))}; tinkerbot_pkce=${encodeURIComponent(cookieFrom(response, "tinkerbot_pkce"))}`;
}

function signedOidcToken(claims: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], kid = "k1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function memoryFactoryDb(seed: {
  workOrders?: Array<Record<string, unknown>>;
  cells?: Array<Record<string, unknown>>;
  proposals?: Array<Record<string, unknown>>;
  factories?: Array<Record<string, unknown>>;
} = {}) {
  const webhooks = new Set<string>();
  const sessions = new Map<string, Record<string, unknown>>();
  const memberships = new Map([["user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" }]]);
  const entitlements = new Map<string, Record<string, unknown>>([["org_1", { organization_id: "org_1", plan_id: "business", billing_status: "active", private_repository_limit: 0, member_limit: 0, retention_days: 730, features_json: "{}", updated_at: "2030-01-01T00:00:00.000Z" }]]);
  const metadata = new Map<string, string>();
  const factories = new Map<string, Record<string, unknown>>((seed.factories ?? []).map((row) => [String(row.factory_id), row]));
  const workOrders = new Map<string, Record<string, unknown>>((seed.workOrders ?? []).map((row) => [String(row.work_order_id), row]));
  const cells = [...(seed.cells ?? [])];
  const proposals = new Map<string, Record<string, unknown>>((seed.proposals ?? []).map((row) => [String(row.proposal_id), row]));
  const runTokens = new Map<string, Record<string, unknown>>();
  const decisions: Array<Record<string, unknown>> = [];
  const rateLimits = new Map<string, { count: number; window_started_at: string }>();
  const runs = new Map<string, Record<string, unknown>>();
  const oidcJti = new Set<string>();
  const stages: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const publications: Array<Record<string, unknown>> = [];
  const installations = new Map<string, Record<string, unknown>>([["9", { installation_id: 9, organization_id: "org_1", status: "active", account_login: "acme" }]]);
  const repositories = new Map([["acme/payments", { full_name: "acme/payments", installation_id: 9 }]]);
  const definitions = new Map<string, Record<string, unknown>>();
  const scorers: Array<Record<string, unknown>> = [];
  const selfImprovement: Array<Record<string, unknown>> = [];
  const factoryEvents: Array<Record<string, unknown>> = [];

  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("FROM tinkerbot_sessions")) return (sessions.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_memberships")) return (memberships.get(`${String(args[1])}:${String(args[0])}`) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_entitlements")) return (entitlements.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_metadata")) return (metadata.has(String(args[0])) ? { value: metadata.get(String(args[0])) } : null) as T | null;
          if (query.includes("FROM tinkerbot_webhook_events")) return (webhooks.has(`${String(args[1])}:${String(args[0])}`) ? { event_id: args[0] } : null) as T | null;
          if (query.includes("FROM tinkerbot_rate_limits")) return (rateLimits.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_github_installations") && query.includes("installation_id")) return (installations.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_github_repositories")) {
            const fullName = String(args[0]).toLowerCase();
            const repo = [...repositories.values()].find((row) => String(row.full_name).toLowerCase() === fullName);
            if (!repo) return null;
            const installation = installations.get(String(repo.installation_id));
            return (installation ? { organization_id: installation.organization_id } : null) as T | null;
          }
          if (query.includes("FROM tinkerbot_factories") && query.includes("factory_id =")) return (factories.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_work_orders") && query.includes("work_order_id =")) return (workOrders.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_run_tokens")) {
            const row = runTokens.get(String(args[0]));
            return (row ? { run_id: row.run_id, repository: row.repository, sha: row.sha, expires_at: row.expires_at } : null) as T | null;
          }
          if (query.includes("FROM tinkerbot_improvement_proposals") && query.includes("proposal_id =")) return (proposals.get(String(args[0])) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_factory_runs") && query.includes("run_id =")) return ([...runs.values()].find((row) => row.run_id === args[0]) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_factory_runs") && query.includes("work_order_id =")) return ([...runs.values()].find((row) => row.work_order_id === args[0]) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_approvals")) return (approvals.find((row) => row.work_order_id === args[0] && row.decision === "approved") ?? null) as T | null;
          if (query.includes("FROM tinkerbot_github_publications")) return (publications.find((row) => row.run_id === args[0] && row.fingerprint === args[1] && row.commit_sha === args[2] && row.kind === args[3]) ?? null) as T | null;
          if (query.includes("FROM tinkerbot_factory_definitions")) return (definitions.get(String(args[0])) ?? null) as T | null;
          return null;
        },
        all: async <T>() => {
          if (query.includes("FROM tinkerbot_memberships")) return { results: [...memberships.values()].filter((membership) => membership.user_id === String(args[0]) && membership.status === "active") as T[] };
          if (query.includes("FROM tinkerbot_work_orders") && query.includes("organization_id =")) {
            return { results: [...workOrders.values()].filter((row) => row.organization_id === args[0]) as T[] };
          }
          if (query.includes("FROM tinkerbot_factories") && query.includes("organization_id =")) {
            return { results: [...factories.values()].filter((row) => row.organization_id === args[0]).map((row) => ({ factory_id: row.factory_id, name: row.name, status: row.status, updated_at: row.updated_at })) as T[] };
          }
          if (query.includes("FROM tinkerbot_work_cells") && query.includes("cleanup_at")) {
            return { results: cells.filter((cell) => String(cell.cleanup_at) <= String(args[0]) && ["leased", "held"].includes(String(cell.status))) as T[] };
          }
          if (query.includes("FROM tinkerbot_work_cells")) return { results: cells.filter((cell) => !args[0] || cell.factory_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_improvement_proposals")) return { results: [...proposals.values()].filter((row) => row.factory_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_products")) return { results: [] as T[] };
          if (query.includes("FROM tinkerbot_skills")) return { results: [] as T[] };
          if (query.includes("FROM tinkerbot_release_candidates")) return { results: [] as T[] };
          if (query.includes("FROM tinkerbot_outcomes")) return { results: [] as T[] };
          if (query.includes("FROM tinkerbot_usage_events")) return { results: [] as T[] };
          if (query.includes("FROM tinkerbot_github_installations")) return { results: [...installations.values()].filter((row) => !args[0] || row.organization_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_run_stages")) return { results: stages.filter((row) => row.run_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_scorers")) return { results: scorers.filter((row) => row.factory_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_self_improvement_tasks")) return { results: selfImprovement.filter((row) => row.factory_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_factory_runs") && query.includes("factory_id")) return { results: [...runs.values()].filter((row) => row.factory_id === args[0]) as T[] };
          if (query.includes("FROM tinkerbot_factory_graph_events")) return { results: factoryEvents.filter((row) => row.aggregate_id === args[0] && row.organization_id === args[1]).map((row) => ({ ...row, payload_json: row.payload_json })) as T[] };
          return { results: [] as T[] };
        },
        run: async () => {
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_oidc_jti")) {
            const key = String(args[0]);
            if (oidcJti.has(key)) return { meta: { changes: 0 } };
            oidcJti.add(key);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_factory_graph_events")) {
            const eventId = String(args[0]);
            if (factoryEvents.some((event) => event.event_id === eventId)) return { meta: { changes: 0 } };
            factoryEvents.push({ event_id: args[0], aggregate_id: args[1], aggregate_type: args[2], organization_id: args[3], factory_id: args[4], event_type: args[5], actor_id: args[6], actor_type: args[7], occurred_at: args[8], correlation_id: args[9], causation_id: args[10], schema_version: args[11], policy_version: args[12], provenance: args[13], external_references_json: args[14], payload_json: args[15] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT OR IGNORE INTO tinkerbot_webhook_events")) {
            const key = `${String(args[1])}:${String(args[0])}`;
            if (webhooks.has(key)) return { meta: { changes: 0 } };
            webhooks.add(key);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_webhook_events")) {
            webhooks.delete(`${String(args[1])}:${String(args[0])}`);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_sessions")) {
            sessions.set(String(args[0]), { session_id: args[0], user_id: args[1], email: args[2], first_name: args[3], last_name: args[4], email_verified: args[5], organization_id: args[6], expires_at: args[7], authentication_method: args[8], token_ciphertext: args[9] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_sessions")) {
            sessions.delete(String(args[0]));
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_metadata")) {
            metadata.set(String(args[0]), String(args[1]));
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_entitlements")) {
            entitlements.set(String(args[0]), { organization_id: args[0], plan_id: args[1], billing_status: args[2], private_repository_limit: args[3], member_limit: args[4], retention_days: args[5], features_json: args[6], updated_at: args[7] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_run_tokens")) {
            runTokens.set(String(args[0]), { token_id: args[0], run_id: args[1], repository: args[2], sha: args[3], expires_at: args[4] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_human_decisions")) {
            decisions.push({ decision_id: args[0], work_order_id: args[1], subject_id: args[2], actor: args[3], decision: args[4] ?? args[5], reason: args[5] ?? args[6] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_work_orders")) {
            workOrders.set(String(args[0]), {
              work_order_id: args[0], factory_id: args[1], organization_id: args[2], source_type: args[3], source_id: args[4], repository_id: args[5],
              issue_or_pull_request: args[6], intent: args[7], acceptance_criteria: args[8], policy_version: args[9], definition_version: args[10],
              definition_digest: args[11], current_stage: args[12], status: args[13], actor: args[14], created_at: args[15], updated_at: args[16],
              product_id: args[17], line_id: args[18], cell_id: args[19], owner: args[20], risk: args[21], autonomy_mode: args[22], output_kind: args[23],
              policy_json: args[24], dependencies_json: args[25], held_by: args[26],
            });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_factory_runs")) {
            runs.set(String(args[0]), { run_id: args[0], work_order_id: args[1], factory_id: args[2], definition_digest: args[3], status: args[4], started_at: args[5], updated_at: args[5] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_factory_runs")) {
            const row = runs.get(String(query.includes("definition_digest =") ? args[2] : args[3]));
            if (!row) return { meta: { changes: 0 } };
            if (query.includes("definition_digest =")) {
              row.definition_digest = args[0];
              row.updated_at = args[1];
              return { meta: { changes: 1 } };
            }
            row.status = args[0];
            row.updated_at = args[2];
            if (args[1] === 1) row.completed_at = args[2];
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_run_stages")) {
            stages.push({ run_stage_id: args[0], run_id: args[1], stage: args[2], status: args[3], summary: args[4] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_approvals")) {
            approvals.push({ approval_id: args[0], work_order_id: args[1], actor: args[2], decision: args[3] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_github_publications")) {
            publications.push({ publication_id: args[0], run_id: args[1], commit_sha: args[2], fingerprint: args[3], kind: args[4] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_rate_limits")) {
            const row = rateLimits.get(String(args[0]));
            if (row) row.count += 1;
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_work_orders")) {
            const id = String(args[args.length - 1]);
            const current = workOrders.get(id);
            if (!current) return { meta: { changes: 0 } };
            if (query.includes("SET status =")) {
              current.status = args[0];
              current.current_stage = args[1];
              current.actor = args[2];
              current.updated_at = args[3];
              if (args[4] != null) current.product_id = args[4];
              if (args[5] != null) current.line_id = args[5];
              if (args[6] != null) current.cell_id = args[6];
              if (args[7] != null) current.autonomy_mode = args[7];
              if (args[8] != null) current.output_kind = args[8];
              current.held_by = args[9];
            } else if (query.includes("product_id = ?1") || query.includes("product_id = ?")) {
              current.product_id = args[0];
              current.line_id = args[1];
              current.cell_id = args[2];
              current.owner = args[3];
              current.risk = args[4];
              current.autonomy_mode = args[5];
              current.output_kind = args[6];
              current.held_by = args[7];
              current.intent = args[8];
              current.acceptance_criteria = args[9];
              current.updated_at = args[10];
            } else if (query.includes("held_by")) {
              current.held_by = args[7];
              current.updated_at = args[10] ?? args[3] ?? current.updated_at;
            }
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_work_cells") || query.includes("tinkerbot_work_cells")) {
            const existing = cells.findIndex((cell) => cell.cell_id === args[0]);
            const row = { cell_id: args[0], factory_id: args[1], work_order_id: args[2], kind: args[3], repository: args[4], branch: args[5], status: args[6], leased_by: args[7], held_by: args[8], credential_scope: args[9], cleanup_at: args[10] };
            if (existing >= 0) cells[existing] = { ...cells[existing], ...row };
            else cells.push(row);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE tinkerbot_improvement_proposals")) {
            const row = proposals.get(String(args[1]));
            if (row) {
              row.human_approved = 1;
              row.status = "approved";
            }
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_rate_limits")) {
            rateLimits.set(String(args[0]), { count: 1, window_started_at: String(args[1]) });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_factories")) {
            factories.set(String(args[0]), { factory_id: args[0], organization_id: args[1], name: args[2], status: "active", definition_digest: args[3], created_at: args[4], updated_at: args[4] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_factory_definitions")) {
            definitions.set(String(args[1]), { yaml: args[3], files_json: args[4], digest: args[2] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_scorers")) {
            scorers.push({ scorer_id: args[0], factory_id: args[1], name: args[2], criteria: args[3], enabled: args[4], self_improve: args[5], updated_at: args[6] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("INSERT INTO tinkerbot_self_improvement_tasks")) {
            selfImprovement.push({ task_id: args[0], factory_id: args[1], work_order_id: args[2], title: args[3], status: "open", created_at: args[4] });
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("DELETE FROM tinkerbot_automations")) return { meta: { changes: 1 } };
          if (query.startsWith("INSERT INTO tinkerbot_automations")) return { meta: { changes: 1 } };
          if (query.startsWith("INSERT INTO tinkerbot_improvement_proposals")) {
            proposals.set(String(args[0]), { proposal_id: args[0], factory_id: args[1], title: args[2], steward_actor: args[7], auto_merge: 0, status: "draft" });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
    _state: { webhooks, sessions, workOrders, cells, proposals, decisions, runTokens, runs, factories, installations, memberships },
  };
  return database;
}

test("hosted queue messages are serialized through the Foreman Durable Object", async () => {
  const names: string[] = [];
  const env = {
    FOREMAN: {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: (_id: unknown) => ({
        fetch: async (request: Request) => {
          expect(request.headers.get("x-tinkerbot-internal")).toBe("foreman-v1");
          expect(await request.json()).toMatchObject({ deliveryId: "delivery-1", sourceId: "source-1" });
          return Response.json({ workOrderId: "wo-1", runId: "run-1", terminal: "implementation" });
        },
      }),
    },
  };
  const result = await handleFactoryQueueMessage(env, { deliveryId: "delivery-1", organizationId: "org-1", sourceType: "manual", sourceId: "source-1", actor: "operator" });
  expect(names).toEqual(["org-1:source-1"]);
  expect(result).toMatchObject({ workOrderId: "wo-1", runId: "run-1", terminal: "implementation" });
});

test("signed GitHub security alerts enqueue factory work and reject forged or replayed deliveries", async () => {
  const queued: unknown[] = [];
  const database = memoryFactoryDb();
  const payload = JSON.stringify({ action: "created", alert: { number: 7 }, repository: { full_name: "acme/payments" }, installation: { id: 9 } });
  const signature = createHmac("sha256", "github_webhook_secret").update(payload).digest("hex");
  const env = { DB: database, GITHUB_WEBHOOK_SECRET: "github_webhook_secret", FACTORY_EVENTS: { send: async (message: unknown) => void queued.push(message) } };
  const forged = await worker.fetch(new Request("https://control.example/integrations/github/webhook", { method: "POST", headers: { "x-github-event": "dependabot_alert", "x-github-delivery": "dep_1", "x-hub-signature-256": "sha256=invalid" }, body: payload }), env);
  expect(forged.status).toBe(401);
  const first = await worker.fetch(new Request("https://control.example/integrations/github/webhook", { method: "POST", headers: { "x-github-event": "dependabot_alert", "x-github-delivery": "dep_1", "x-hub-signature-256": `sha256=${signature}` }, body: payload }), env);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ received: true, duplicate: false });
  expect(queued[0]).toMatchObject({ sourceType: "github_dependabot", sourceId: "7" });
  const replay = await worker.fetch(new Request("https://control.example/integrations/github/webhook", { method: "POST", headers: { "x-github-event": "dependabot_alert", "x-github-delivery": "dep_1", "x-hub-signature-256": `sha256=${signature}` }, body: payload }), env);
  expect(await replay.json()).toEqual({ received: true, duplicate: true });
  const codePayload = JSON.stringify({ action: "created", alert: { number: 11 }, repository: { full_name: "acme/payments" } });
  const codeSignature = createHmac("sha256", "github_webhook_secret").update(codePayload).digest("hex");
  const scanning = await worker.fetch(new Request("https://control.example/integrations/github/webhook", { method: "POST", headers: { "x-github-event": "code_scanning_alert", "x-github-delivery": "code_1", "x-hub-signature-256": `sha256=${codeSignature}` }, body: codePayload }), env);
  expect(scanning.status).toBe(200);
  expect(queued.some((item) => (item as { sourceType?: string }).sourceType === "github_code_scanning")).toBe(true);
});

test("GitHub webhook remains retryable when queue dispatch fails", async () => {
  const database = memoryFactoryDb();
  const payload = JSON.stringify({ action: "created", alert: { number: 12 }, repository: { full_name: "acme/payments" }, installation: { id: 9 } });
  const signature = createHmac("sha256", "github_webhook_secret").update(payload).digest("hex");
  let attempts = 0;
  const env = {
    DB: database,
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
    FACTORY_EVENTS: { send: async () => { attempts += 1; if (attempts === 1) throw new Error("queue unavailable"); } },
  };
  const request = () => new Request("https://control.example/integrations/github/webhook", { method: "POST", headers: { "x-github-event": "dependabot_alert", "x-github-delivery": "retry_1", "x-hub-signature-256": `sha256=${signature}` }, body: payload });
  expect((await worker.fetch(request(), env)).status).toBe(500);
  const retry = await worker.fetch(request(), env);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ received: true, duplicate: false });
  expect(attempts).toBe(2);
});

test("incident and support webhooks normalize into factory work orders", async () => {
  const queued: Array<{ sourceType: string; sourceId: string }> = [];
  const env = { DB: memoryFactoryDb(), FACTORY_EVENTS: { send: async (message: { sourceType: string; sourceId: string }) => void queued.push(message) } };
  const incident = await worker.fetch(new Request("https://control.example/integrations/incident/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incident: { id: "inc_9", title: "Sev1", description: "500s" } }) }), env);
  expect(incident.status).toBe(200);
  expect(await incident.json()).toMatchObject({ received: true, sourceType: "incident" });
  const support = await worker.fetch(new Request("https://control.example/integrations/support/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "sup_2", subject: "Login", body: "cannot sign in" }) }), env);
  expect(support.status).toBe(200);
  expect(queued.map((item) => item.sourceType)).toEqual(["incident", "support"]);
  expect(intakeFromIntegration("incident", { incident: { id: "inc_9", title: "Sev1", description: "500s" } }).sourceType).toBe("incident");
});

test("public integration intake verifies signatures and pins the tenant in production", async () => {
  const queued: unknown[] = [];
  const payload = JSON.stringify({ event_id: "evt_slack_1", text: "@tinker fix login", organizationId: "attacker-org" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = "slack-webhook-secret-1234";
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex");
  const env = { ENVIRONMENT: "staging", DB: memoryFactoryDb(), SLACK_WEBHOOK_SECRET: secret, INTEGRATION_ORGANIZATION_ID: "org_1", FACTORY_EVENTS: { send: async (message: unknown) => void queued.push(message) } };
  const invalid = await worker.fetch(new Request("https://control.example/integrations/slack/webhook", { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=invalid" }, body: payload }), env);
  expect(invalid.status).toBe(401);
  const accepted = await worker.fetch(new Request("https://control.example/integrations/slack/webhook", { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` }, body: payload }), env);
  expect(accepted.status).toBe(200);
  expect(queued[0]).toMatchObject({ organizationId: "org_1" });
  const production = await worker.fetch(new Request("https://control.example/integrations/slack/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: payload }), { ENVIRONMENT: "production", DB: memoryFactoryDb() });
  expect(production.status).toBe(503);
});

test("OIDC exchange verifies JWKS, rejects unsigned helpers, and requires a GitHub App installation", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes(".well-known/jwks") || String(input).includes("oauth/discovery/keys")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  resetOidcJwksCache();
  try {
    const env = { DB: memoryFactoryDb(), ACTION_OIDC_AUDIENCE: "tinkerbot" };
    const unsigned = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `e30.${Buffer.from(JSON.stringify({ iss: "https://token.actions.githubusercontent.com", aud: "tinkerbot", repository: "acme/payments" })).toString("base64url")}.sig`, repository: "acme/payments" }) }), env);
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ code: "unsigned_or_malformed" });
    const baseClaims = { iss: "https://token.actions.githubusercontent.com", aud: "tinkerbot", repository: "acme/payments", sha: "abc", exp: now + 120, iat: now, nbf: now, jti: "jti-exchange-1" };
    const badIssuer = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken({ ...baseClaims, iss: "https://evil.example" }, privateKey), repository: "acme/payments" }) }), env);
    expect(await badIssuer.json()).toMatchObject({ code: "invalid_issuer" });
    const badAudience = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken({ ...baseClaims, aud: "other", jti: "jti-aud" }, privateKey), repository: "acme/payments" }) }), env);
    expect(await badAudience.json()).toMatchObject({ code: "invalid_audience" });
    const expired = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken({ ...baseClaims, exp: now - 120, jti: "jti-exp" }, privateKey), repository: "acme/payments" }) }), env);
    expect(await expired.json()).toMatchObject({ code: "expired" });
    const forged = signedOidcToken({ ...baseClaims, jti: "jti-forged" }, privateKey).split(".");
    const tampered = `${forged[0]}.${Buffer.from(JSON.stringify({ ...baseClaims, repository: "evil/repo", jti: "jti-forged" })).toString("base64url")}.${forged[2]}`;
    expect((await (await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tampered, repository: "evil/repo" }) }), env)).json())).toMatchObject({ code: "invalid_signature" });
    const missingInstall = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken({ ...baseClaims, repository: "acme/missing", jti: "jti-missing" }, privateKey), repository: "acme/missing" }) }), env);
    expect(missingInstall.status).toBe(401);
    expect(await missingInstall.json()).toMatchObject({ code: "installation_required" });
    const ok = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken(baseClaims, privateKey), repository: "acme/payments", sha: "abc" }) }), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ repository: "acme/payments" });
    const replay = await worker.fetch(new Request("https://control.example/actions/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: signedOidcToken(baseClaims, privateKey), repository: "acme/payments" }) }), env);
    expect(await replay.json()).toMatchObject({ code: "replay" });
    const ingest = await worker.fetch(new Request("https://control.example/assurance/ingest", { method: "POST", headers: { origin: "https://control.example", "content-type": "application/json" }, body: JSON.stringify({ repository: "acme/payments", assurance: { schemaVersion: 1 } }) }), { ...env, SESSION_ENCRYPTION_KEY: "session-encryption-test-key", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret" });
    expect(ingest.status).toBe(401);
  } finally {
    globalThis.fetch = originalFetch;
    resetOidcJwksCache();
  }
});

test("scheduled sweep marks expired work cells abandoned", async () => {
  const database = memoryFactoryDb({
    cells: [{ cell_id: "cell_old", factory_id: "fac_1", work_order_id: "wo_1", kind: "sandbox", repository: "acme/pay", branch: "tinkerbot/wo_1", status: "held", credential_scope: "repo:acme/pay", cleanup_at: "2020-01-01T00:00:00.000Z" }],
  });
  const result = await sweepFactoryOs({ DB: database });
  expect(result.abandonedCells).toBe(1);
  expect(database._state.cells[0]?.status).toBe("abandoned");
  await worker.scheduled({ cron: "0 * * * *" }, { DB: database });
  expect(database._state.cells[0]?.status).toBe("abandoned");
});

test("control-tower work orders expose group, take/return write human decisions, and evolution rejects steward self-approve and auto-merge", async () => {
  const database = memoryFactoryDb({
    factories: [{ factory_id: "fac_1", organization_id: "org_1", name: "payments", status: "active", updated_at: "2030-01-01T00:00:00.000Z", definition_digest: "sha256:abc" }],
    workOrders: [{
      work_order_id: "wo_1", factory_id: "fac_1", organization_id: "org_1", source_type: "github_issue", source_id: "12", repository_id: "acme/payments",
      issue_or_pull_request: "fix login", intent: "fix login", acceptance_criteria: null, policy_version: "default", definition_version: "1", definition_digest: "sha256:abc",
      current_stage: "implementation", status: "failed", actor: "system", created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:00.000Z",
      product_id: "pay", line_id: "bugfix", cell_id: "cell_1", owner: null, risk: "medium", autonomy_mode: "approval_gated", output_kind: "pr", policy_json: null, dependencies_json: null, held_by: null,
    }],
    proposals: [
      { proposal_id: "prop_steward", factory_id: "fac_1", title: "skill", steward_actor: "user_1", auto_merge: 0, status: "draft" },
      { proposal_id: "prop_auto", factory_id: "fac_1", title: "auto", steward_actor: "other", auto_merge: 1, status: "draft" },
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.workos.com")) {
      if (url.includes("organization_memberships")) return new Response(JSON.stringify({ data: [{ id: "om_1", user_id: "user_1", organization_id: "org_1", organization_name: "Atlas", status: "active", role: { slug: "owner" }, user: { id: "user_1", email: "alex@example.com", email_verified: true }, updated_at: "2030-01-01T00:00:00.000Z" }], list_metadata: {} }), { status: 200 });
      return new Response(JSON.stringify({ user: { id: "user_1", email: "alex@example.com", email_verified: true }, organization_id: "org_1", access_token: "access_secret", refresh_token: "refresh_secret", expires_in: 3600 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const env = { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", SESSION_ENCRYPTION_KEY: "session-encryption-test-key", DB: database };
    const start = await worker.fetch(new Request("https://control.example/auth/workos/start"), env);
    const state = cookieFrom(start, "tinkerbot_oauth_state");
    const callback = await worker.fetch(new Request(`https://control.example/auth/workos/callback?code=auth_code&state=${encodeURIComponent(state)}`, { headers: { cookie: oauthCookieHeader(start) } }), env);
    const sessionId = cookieFrom(callback, "tinkerbot_session");
    const cookie = `tinkerbot_session=${encodeURIComponent(sessionId)}`;
    const listed = await worker.fetch(new Request("https://control.example/work-orders", { headers: { cookie } }), env);
    expect(listed.status).toBe(200);
    const body = await listed.json() as { workOrders: Array<{ group?: string; column?: string; status: string }> };
    expect(body.workOrders[0]?.group).toBe("needs_attention");
    expect(body.workOrders[0]?.column).toBeUndefined();
    const graph = await worker.fetch(new Request("https://control.example/work-orders/wo_1/graph", { headers: { cookie } }), env);
    expect(graph.status).toBe(200);
    expect(await graph.json()).toMatchObject({ sourceOfTruth: "append_only_factory_graph", graph: { eventCount: 0 } });
    const csrf = await worker.fetch(new Request("https://control.example/work-orders/wo_1/take", { method: "POST", headers: { origin: "https://attacker.example", cookie, "content-type": "application/json" }, body: "{}" }), env);
    expect(csrf.status).toBe(403);
    const take = await worker.fetch(new Request("https://control.example/work-orders/wo_1/take", { method: "POST", headers: { origin: "https://control.example", cookie, "content-type": "application/json" }, body: "{}" }), env);
    expect(take.status).toBe(200);
    expect(database._state.decisions.some((row) => String(row.decision).includes("take") || String(row.reason ?? "").includes("parity"))).toBe(true);
    const returned = await worker.fetch(new Request("https://control.example/work-orders/wo_1/return", { method: "POST", headers: { origin: "https://control.example", cookie, "content-type": "application/json" }, body: "{}" }), env);
    expect(returned.status).toBe(200);
    const selfApprove = await worker.fetch(new Request("https://control.example/evolution/prop_steward/approve", { method: "POST", headers: { origin: "https://control.example", cookie, "content-type": "application/json" }, body: "{}" }), env);
    expect(selfApprove.status).toBe(409);
    expect(await selfApprove.json()).toMatchObject({ code: "steward_cannot_self_approve" });
    const autoMerge = await worker.fetch(new Request("https://control.example/evolution/prop_auto/approve", { method: "POST", headers: { origin: "https://control.example", cookie, "content-type": "application/json" }, body: "{}" }), env);
    expect(autoMerge.status).toBe(409);
    expect(await autoMerge.json()).toMatchObject({ code: "auto_merge_forbidden" });
    const store = new D1FactoryStore(database);
    expect(await store.approveProposal("prop_auto", "human", "2030-01-01T00:00:00.000Z")).toEqual({ ok: false, reason: "auto_merge_forbidden" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function factorySeed() {
  return memoryFactoryDb({
    factories: [{ factory_id: "fac_1", organization_id: "org_1", name: "payments", status: "active", updated_at: "2030-01-01T00:00:00.000Z", definition_digest: "sha256:abc" }],
  });
}

test("runFactoryTurn fails closed without a database, organization, or factory, and blocks inactive GitHub installations", async () => {
  expect(await runFactoryTurn({}, { deliveryId: "d", sourceType: "github_issue", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "unknown" });
  expect(await runFactoryTurn({ DB: factorySeed() }, { deliveryId: "d", sourceType: "github_issue", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "unknown" });
  const empty = memoryFactoryDb();
  expect(await runFactoryTurn({ DB: empty }, { deliveryId: "d", organizationId: "org_1", sourceType: "github_issue", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "unknown" });
  const inactive = factorySeed();
  inactive._state.installations.set("9", { installation_id: 9, organization_id: "org_1", status: "suspended" });
  expect(await runFactoryTurn({ DB: inactive }, { deliveryId: "d", installationId: 9, sourceType: "github_issue", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "blocked" });
  expect(await runFactoryTurn({ DB: factorySeed() }, { deliveryId: "tenant-mismatch", installationId: 9, organizationId: "org_2", repository: "acme/payments", sourceType: "github_issue", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "blocked" });
  expect(await runFactoryTurn({ DB: factorySeed() }, { deliveryId: "unknown-work-order", organizationId: "org_1", factoryId: "fac_1", workOrderId: "wo_from_another_tenant", sourceType: "manual", sourceId: "1", actor: "bot" })).toMatchObject({ terminal: "unknown", workOrderId: "wo_from_another_tenant" });
});

test("runFactoryTurn records stages, waits for spec approval, and keeps PASS from becoming a silent merge", async () => {
  const database = factorySeed();
  const bucket = new Map<string, string>();
  const env = {
    DB: database,
    SESSION_ENCRYPTION_KEY: "factory-dev-key",
    EVIDENCE_BUCKET: {
      put: async (key: string, value: string) => void bucket.set(key, value),
      get: async (key: string) => (bucket.has(key) ? { text: async () => bucket.get(key)! } : null),
      delete: async (key: string) => void bucket.delete(key),
    },
  };
  const waiting = await runFactoryTurn(env, {
    deliveryId: "issue_1",
    organizationId: "org_1",
    factoryId: "fac_1",
    repository: "acme/payments",
    sourceType: "github_issue",
    sourceId: "12",
    issueOrPullRequest: "add refunds to checkout",
    actor: "factory-agent",
  });
  expect(waiting.wait).toBe("spec_approval");
  expect(waiting.terminal).toBe("specification");
  expect(database._state.workOrders.size).toBe(1);
  const ready = await runFactoryTurn(env, {
    deliveryId: "issue_2",
    organizationId: "org_1",
    factoryId: "fac_1",
    workOrderId: waiting.workOrderId,
    repository: "acme/payments",
    sourceType: "github_issue",
    sourceId: "12",
    issueOrPullRequest: "add refunds to checkout",
    actor: "factory-agent",
    specApproved: true,
    sandboxComplete: true,
    verificationIngested: true,
    verificationVerdict: "PASS",
    pullRequestSha: "abc123",
    sha: "abc123",
  });
  expect(ready.wait).toBe("human_merge");
  expect(ready.terminal).not.toBe("merged");
  expect([...bucket.keys()].some((key) => key.includes("transcript") || key.includes("evidence"))).toBe(true);
  await persistTranscript(env, "org_1", waiting.workOrderId, [{ role: "assistant", agentId: "foreman", content: "wait for tb check", at: "2030-01-01T00:00:00.000Z" }]);
  const sandbox = await runFactoryTurn({
    ...env,
    Sandbox: { exec: async () => ({ output: async () => ({ stdout: "ok", exitCode: 0 }) }) },
  }, {
    deliveryId: "issue_3",
    organizationId: "org_1",
    factoryId: "fac_1",
    repository: "acme/payments",
    sourceType: "github_issue",
    sourceId: "99",
    issueOrPullRequest: "add a checkout feature",
    actor: "factory-agent",
    specApproved: true,
  });
  expect(sandbox.wait).toBe("sandbox");
  const systemDb = memoryFactoryDb({ factories: [{ factory_id: "fac_sys", organization_id: "system", name: "system", status: "active", updated_at: "2030-01-01T00:00:00.000Z" }] });
  const swept = await sweepFactoryOs({ DB: systemDb });
  expect(swept.maintenance).toBeGreaterThan(0);
});

test("runFactoryTurn queues self-hosted harness work without invoking the managed sandbox", async () => {
  const database = factorySeed();
  await new D1FactoryStore(database).putFactory({
    factoryId: "fac_1",
    organizationId: "org_1",
    name: "payments",
    yaml: `schemaVersion: v1alpha2
name: payments
repositories: [acme/payments]
sources: [{ type: github_issue }]
runtime:
  controlPlane: hosted
  runner:
    type: self_hosted
    workerHost: self_hosted:runner-1
  inference:
    mode: byok
    provider: openai
    credentialRef: env:OPENAI_API_KEY
agents:
  - id: implementation
    harness: codex
`,
  });
  const dispatched: unknown[] = [];
  let hostedInferenceCalls = 0;
  const result = await runFactoryTurn({ DB: database, SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret", SELF_HOSTED_WORK: { send: async (payload) => void dispatched.push(payload) }, AI: { run: async () => { hostedInferenceCalls += 1; return { response: "should not run for BYOK" }; } } }, {
    deliveryId: "self-hosted-1",
    organizationId: "org_1",
    factoryId: "fac_1",
    repository: "acme/payments",
    sourceType: "github_issue",
    sourceId: "42",
    issueOrPullRequest: "implement refunds",
    actor: "factory-agent",
    specApproved: true,
  });
  expect(result).toMatchObject({ wait: "self_hosted_harness", terminal: "implementation" });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toMatchObject({ executionBoundary: "self_hosted", harness: "codex", authority: { mayMerge: false, mayRelease: false, mayWriteVerificationVerdict: false }, integrity: { algorithm: "hmac-sha256", signed: true } });
  expect(JSON.stringify(dispatched[0])).not.toContain("OPENAI_API_KEY");
  expect(hostedInferenceCalls).toBe(0);
  const redelivered = await runFactoryTurn({ DB: database, SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret", SELF_HOSTED_WORK: { send: async (payload) => void dispatched.push(payload) } }, {
    deliveryId: "self-hosted-duplicate", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "github_issue", sourceId: "42", workOrderId: result.workOrderId, actor: "factory-agent", specApproved: true,
  });
  expect(redelivered).toMatchObject({ wait: "self_hosted_harness", terminal: "implementation" });
  expect(dispatched).toHaveLength(1);
  const completion = createSelfHostedCompletion({ dispatchId: `selfhost:${result.workOrderId}:${result.runId}`, executionBoundary: "self_hosted", organizationId: "org_1", factoryId: "fac_1", workOrderId: result.workOrderId, runId: result.runId, repository: "acme/payments", definitionDigest: String((dispatched[0] as { definitionDigest: string }).definitionDigest), status: "completed", branch: implementBranchName(result.workOrderId), headSha: "abcdef1234567", secret: "self-hosted-test-secret", completedAt: new Date(Date.now() - 1_000).toISOString() });
  const completed = await worker.fetch(new Request("https://control.example/self-hosted/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion) }), { DB: database, SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret" });
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ accepted: true, workOrderId: result.workOrderId, runId: result.runId });
  const replayedCompletion = await worker.fetch(new Request("https://control.example/self-hosted/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion) }), { DB: database, SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret" });
  expect(await replayedCompletion.json()).toMatchObject({ accepted: true, replayed: true });
  const wrongBranch = createSelfHostedCompletion({ dispatchId: completion.dispatchId, executionBoundary: completion.executionBoundary, organizationId: completion.organizationId, factoryId: completion.factoryId, workOrderId: completion.workOrderId, runId: completion.runId, repository: completion.repository, definitionDigest: completion.definitionDigest, status: "completed", branch: "tinkerbot/another-work-order", headSha: completion.headSha, summary: completion.summary, completedAt: new Date(Date.now() - 500).toISOString(), secret: "self-hosted-test-secret" });
  const wrongBranchResponse = await worker.fetch(new Request("https://control.example/self-hosted/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wrongBranch) }), { DB: database, SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret" });
  expect(wrongBranchResponse.status).toBe(409);
  expect(await wrongBranchResponse.json()).toMatchObject({ code: "branch_scope_mismatch" });
});

test("runFactoryTurn can bridge self-hosted work to an external HTTPS worker endpoint", async () => {
  const database = factorySeed();
  await new D1FactoryStore(database).putFactory({
    factoryId: "fac_1",
    organizationId: "org_1",
    name: "payments",
    yaml: `schemaVersion: v1alpha2
name: payments
repositories: [acme/payments]
runtime:
  controlPlane: hosted
  runner:
    type: self_hosted
    workerHost: self_hosted:runner-1
agents:
  - id: implementation
    harness: codex
`,
  });
  const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) });
    return new Response("accepted", { status: 202 });
  }) as typeof fetch;
  try {
    const result = await runFactoryTurn({ DB: database, SELF_HOSTED_WORK_ENDPOINT: "https://worker.example/tinkerbot/dispatch", SELF_HOSTED_WORK_SECRET: "self-hosted-test-secret" }, {
      deliveryId: "self-hosted-http-1", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "github_issue", sourceId: "43", issueOrPullRequest: "implement refunds", actor: "factory-agent", specApproved: true,
    });
    expect(result.wait).toBe("self_hosted_harness");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://worker.example/tinkerbot/dispatch");
    expect(requests[0]?.headers.get("x-tinkerbot-self-hosted-protocol")).toBe("1");
    expect(requests[0]?.body).toMatchObject({ executionBoundary: "self_hosted", harness: "codex", integrity: { signed: true } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Foreman Durable Object, MCP, queue, and Slack challenge stay on the factory intake path", async () => {
  const database = factorySeed();
  const env = { DB: database, SESSION_ENCRYPTION_KEY: "factory-dev-key", FACTORY_EVENTS: { send: async () => undefined }, AI: { run: async () => ({ response: "triage the change" }) } };
  const foreman = new ForemanDurableObject({ id: { toString: () => "wo_foreman" } }, env);
  const steered = await foreman.fetch(new Request("https://do/steer", { method: "POST", body: JSON.stringify({ workOrderId: "missing", note: "retry", organizationId: "org_1", repository: "acme/payments" }) }));
  expect(steered.status).toBe(200);
  expect(await steered.json()).toMatchObject({ steered: true });
  expect(await (await foreman.fetch(new Request("https://do/status"))).json()).toMatchObject({ group: "in_progress" });
  const initialize = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }), env, "user_1", "org_1");
  expect(await initialize.json()).toMatchObject({ result: { serverInfo: { name: "tinkerbot-factory" } } });
  const listed = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), env, "user_1", "org_1");
  expect(JSON.stringify(await listed.json())).toContain("tools");
  const sent = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_task", arguments: { title: "Fix login", note: "add tests", factory: "fac_1", repository: "acme/payments" } } }) }), env, "user_1", "org_1");
  expect(JSON.stringify(await sent.json())).toContain("workOrderId");
  const got = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_task", arguments: { workOrderId: "missing" } } }) }), env, "user_1", "org_1");
  expect((await got.json() as { result?: unknown }).result).toBeDefined();
  const messaged = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "message_foreman", arguments: { workOrderId: "missing", note: "steer" } } }) }), env, "user_1", "org_1");
  expect(JSON.stringify(await messaged.json())).toContain("accepted");
  const createdFactory = await handleFactoryMcpRequest(new Request("https://control.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_factory", arguments: { name: "payments" } } }) }), env, "user_1", "org_1");
  expect(JSON.stringify(await createdFactory.json())).toContain("factoryId");
  await handleFactoryQueueMessage(env, { deliveryId: "q1", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "manual", sourceId: "m1", actor: "user_1" });
  await handleFactoryQueueMessage(env, { deliveryId: "gl1", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "gitlab_merge_request", sourceId: "12", actor: "gitlab-webhook" });
  const workflow = new FactoryRunWorkflow();
  await workflow.run({ payload: { deliveryId: "q2", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "scheduled", sourceId: "sched_1", actor: "scheduler" } }, env);
  let acked = false;
  await worker.queue({ messages: [{ body: { deliveryId: "q3", organizationId: "org_1", factoryId: "fac_1", repository: "acme/payments", sourceType: "mcp", sourceId: "mcp_1", actor: "mcp" }, ack() { acked = true; } }] }, env);
  expect(acked).toBe(true);
  const slack = await worker.fetch(new Request("https://control.example/integrations/slack/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "abc" }) }), env);
  expect(await slack.json()).toEqual({ challenge: "abc" });
  const linear = await worker.fetch(new Request("https://control.example/integrations/linear/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { id: "LIN-1", title: "Bug" } }) }), env);
  expect(linear.status).toBe(200);
  expect(intakeFromIntegration("slack", { text: "fix it" }).sourceType).toBe("slack");
  expect(intakeFromIntegration("linear", { data: { id: "L1" } }).sourceType).toBe("linear");
  expect(intakeFromIntegration("jira", { issue: { key: "PAY-1" } }).sourceType).toBe("jira");
});

test("factory store methods persist cells, tokens, publications, products, and reject missing proposals", async () => {
  const database = factorySeed();
  const store = new D1FactoryStore(database);
  const now = "2030-01-01T00:00:00.000Z";
  await store.putFactory({ factoryId: "fac_2", organizationId: "org_1", name: "billing", yaml: "version: 1\nname: billing\nrepositories:\n  - acme/billing\nsources:\n  - type: manual\n", now });
  expect((await store.listFactories("org_1")).some((row) => row.factoryId === "fac_2")).toBe(true);
  await store.putRunToken("token_1", "run_1", "acme/payments", "sha", "2030-02-01T00:00:00.000Z", now);
  expect(await store.getRunToken("token_1")).toMatchObject({ repository: "acme/payments" });
  expect(await store.putPublication({ runId: "run_1", commitSha: "sha", fingerprint: "fp", kind: "check", now })).toBe("created");
  expect(await store.putPublication({ runId: "run_1", commitSha: "sha", fingerprint: "fp", kind: "check", now })).toBe("duplicate");
  await store.insertApproval("wo_missing", "user_1", "approved", "session", now);
  expect(await store.hasSpecApproval("wo_missing")).toBe(true);
  expect(await store.hitRateLimit("bucket", 1, 60_000, Date.parse(now))).toBe(false);
  expect(await store.hitRateLimit("bucket", 2, 60_000, Date.parse(now) + 1)).toBe(false);
  expect(await store.hitRateLimit("bucket", 2, 60_000, Date.parse(now) + 2)).toBe(true);
  await store.insertProposal({ proposalId: "prop_ok", factoryId: "fac_1", title: "checklist", evidence: ["8 PRs"], proposedChanges: ["add review"], expectedEffect: "fewer misses", kind: "skill", stewardActor: "steward", now });
  expect(await store.approveProposal("prop_ok", "user_1", now)).toEqual({ ok: true });
  await store.putFactory({ factoryId: "fac_other", organizationId: "org_2", name: "other", now });
  await store.insertProposal({ proposalId: "prop_other", factoryId: "fac_other", title: "other tenant", evidence: [], proposedChanges: [], expectedEffect: "none", kind: "skill", now });
  expect(await store.approveProposal("prop_other", "user_1", now, "org_1")).toEqual({ ok: false, reason: "not_found" });
  await store.insertRun({ runId: "run_1", workOrderId: "wo_1", factoryId: "fac_1", definitionDigest: "sha256:abc", status: "running", now });
  await store.insertStage("run_1", "foreman", "ok", "queued", now);
  expect((await store.listRunStages("run_1")).length).toBeGreaterThan(0);
  await store.upsertProduct({ productId: "pay", organizationId: "org_1", factoryId: "fac_1", name: "payments", riskClass: "high", now });
  await store.upsertSkill({ skillId: "sk", factoryId: "fac_1", name: "review", purpose: "review", owner: "human", version: "1", yaml: "name: review", rollout: "draft", allowedTools: ["read"], permissions: ["contents:read"], now });
  await store.upsertWorkCell({ cellId: "cell_1", factoryId: "fac_1", kind: "sandbox", repository: "acme/payments", branch: "tinkerbot/wo", status: "leased", credentialScope: "repo:acme/payments", cleanupAt: now, now });
  expect((await store.listWorkCells("fac_1")).length).toBeGreaterThan(0);
  await store.insertReleaseCandidate({ releaseId: "rc1", workOrderId: "wo_1", factoryId: "fac_1", commitSha: "sha", receiptIds: ["r"], rollbackRefs: ["docs/rollback"], status: "blocked", blocking: ["unknown-sha"], now });
  await store.insertDeployment({ deploymentId: "dep_1", releaseId: "rc1", environment: "staging", status: "recorded", now });
  await store.insertOutcome({ outcomeId: "out_1", workOrderId: "wo_1", kind: "successful_release", association: "human", now });
  await store.insertScorer({ factoryId: "fac_1", name: "tb-check-gate", criteria: "wait", now });
  await store.insertBenchmark("fac_1", "rework", 1, now);
  await store.insertSelfImprovement({ factoryId: "fac_1", title: "wait for tb check", now });
  expect((await store.listScorers("fac_1")).some((row) => row.upgradesVerdict === false)).toBe(true);
  expect((await store.listSelfImprovement("fac_1")).some((row) => row.autoMerge === false)).toBe(true);
  await store.putFactory({
    factoryId: "fac_3",
    organizationId: "org_1",
    name: "payments-factory",
    yaml: "schemaVersion: v1alpha1\nname: payments-factory\nalias: payments\nrepositories:\n  - owner: acme\n    name: pay\nagentDefaults:\n  model: auto\n",
    files: [{ path: ".tinkerbot/agents/foreman/agent.md", contents: "---\nagentType: FOREMAN\n---\nRoute work. Never merge.\n" }],
    now,
  });
  const view = await store.factoryOperatorView("fac_3", "org_1");
  expect(view?.factory.alias).toBe("payments");
  expect(view?.agents.some((agent) => agent.agentType === "FOREMAN")).toBe(true);
  expect(view?.metrics.caption).toMatch(/included on your plan/);
  await database.prepare("INSERT INTO tinkerbot_factory_definitions (definition_id, factory_id, digest, yaml, files_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind("def_bad", "fac_2", "digest", "version: 1\nname: billing\nrepositories:\n  - acme/billing\nsources:\n  - type: manual\n", "not-json", now).run();
  expect(await store.getLatestDefinition("fac_2")).toMatchObject({ files: [] });
  expect(await store.factoryOperatorView("missing", "org_1")).toBeNull();
  expect(await store.approveProposal("missing", "user_1", now)).toEqual({ ok: false, reason: "not_found" });
  expect(await store.listUsage("org_1")).toEqual([]);
  expect(await store.getRun("missing")).toBeNull();
});

test("authenticated factory HTTP lists products, cells, evolution, and MCP without claiming cluster execute", async () => {
  const database = factorySeed();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("organization_memberships")) return new Response(JSON.stringify({ data: [{ id: "om_1", user_id: "user_1", organization_id: "org_1", organization_name: "Atlas", status: "active", role: { slug: "owner" }, user: { id: "user_1", email: "alex@example.com", email_verified: true }, updated_at: "2030-01-01T00:00:00.000Z" }], list_metadata: {} }), { status: 200 });
    return new Response(JSON.stringify({ user: { id: "user_1", email: "alex@example.com", email_verified: true }, organization_id: "org_1", access_token: "access_secret", refresh_token: "refresh_secret", expires_in: 3600 }), { status: 200 });
  };
  try {
    const env = { ENVIRONMENT: "staging", WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "workos_test_secret", SESSION_ENCRYPTION_KEY: "session-encryption-test-key", DB: database };
    const start = await worker.fetch(new Request("https://control.example/auth/workos/start"), env);
    const state = cookieFrom(start, "tinkerbot_oauth_state");
    const callback = await worker.fetch(new Request(`https://control.example/auth/workos/callback?code=auth_code&state=${encodeURIComponent(state)}`, { headers: { cookie: oauthCookieHeader(start) } }), env);
    const cookie = `tinkerbot_session=${encodeURIComponent(cookieFrom(callback, "tinkerbot_session"))}`;
    const headers = { cookie, origin: "https://control.example" };
    expect((await worker.fetch(new Request("https://control.example/factories", { headers }), env)).status).toBe(200);
    const factoryView = await worker.fetch(new Request("https://control.example/factories/fac_1", { headers }), env);
    expect(factoryView.status).toBe(200);
    expect(await factoryView.json()).toMatchObject({ factory: { factoryId: "fac_1" }, activity: expect.any(Array), metrics: { autonomyShare: null } });
    expect((await worker.fetch(new Request("https://control.example/products", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/cells", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/skills", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/evolution", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/releases", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/outcomes", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/usage", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/integrations/github", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/sso", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/sso", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ connectionId: "conn_1", requireSso: true }) }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/credentials", { headers }), env)).status).toBe(200);
    const credential = await worker.fetch(new Request("https://control.example/credentials", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), env);
    expect(credential.status).toBe(200);
    expect(await credential.json()).toMatchObject({ tokenShownOnce: true });
    expect((await worker.fetch(new Request("https://control.example/change-sets", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/change-sets", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "payments", repositories: [] }) }), env)).status).toBe(201);
    expect((await worker.fetch(new Request("https://control.example/release-assessments", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/audit/export", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/notifications", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/notifications", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "slack", webhookUrl: "https://hooks.slack.com/services/T000/B000/secret" }) }), env)).status).toBe(200);
    const invalidNotification = await worker.fetch(new Request("https://control.example/notifications", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "slack", webhookUrl: "https://127.0.0.1/internal" }) }), env);
    expect(invalidNotification.status).toBe(400);
    expect((await worker.fetch(new Request("https://control.example/roles", { headers }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://control.example/roles", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ slug: "release-lead", capabilities: ["view_audit"] }) }), env)).status).toBe(200);
    const mcp = await worker.fetch(new Request("https://control.example/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }), env);
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(await mcp.json())).not.toContain("cluster execute");
    const oversizedMcp = await worker.fetch(new Request("https://control.example/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_task", arguments: { title: "x".repeat(1_500_001) } } }) }), env);
    expect(oversizedMcp.status).toBe(413);
    const sync = await worker.fetch(new Request("https://control.example/runtime/sync", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "factory-run", origin: "local", runId: "local-run", plan: { planId: "p1", origin: "local", profile: { collaboration: "team", controlPlane: "local", pipeline: "multi_agent", runner: { type: "docker" }, inference: { mode: "managed" }, approval: "human_async", sync: "offline" }, selectedPipeline: "multi_agent", stages: [], skip: [], runner: { type: "docker" }, estimatedDurationSeconds: 1, cost: { catalogVersion: "2026-08-18.seat-v1", plannedStages: [], estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedDurationSeconds: 1, managedCogsCents: 0, byokSpendCents: 0, platformInvoice: "seats_only", confidence: "low", rangeCents: { low: 0, high: 1 } }, escalationEligible: false, createdAt: "now" } }) }), env);
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ accepted: true, origin: "local" });
    const secretRejected = await worker.fetch(new Request("https://control.example/runtime/sync", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "factory-run", token: "sk_live_notallowed" }) }), env);
    expect(secretRejected.status).toBe(400);
    database._state.memberships.set("user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "viewer", status: "active" });
    const viewerPost = await worker.fetch(new Request("https://control.example/factories", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "payments" }) }), env);
    expect(viewerPost.status).toBe(403);
    const viewerChangeSet = await worker.fetch(new Request("https://control.example/change-sets", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "payments", repositories: [] }) }), env);
    expect(viewerChangeSet.status).toBe(403);
    const viewerReleaseAssessment = await worker.fetch(new Request("https://control.example/release-assessments", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), env);
    expect(viewerReleaseAssessment.status).toBe(403);
    const viewerNotification = await worker.fetch(new Request("https://control.example/notifications", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: "slack", webhookUrl: "https://hooks.slack.com/services/T000/B000/secret" }) }), env);
    expect(viewerNotification.status).toBe(403);
    const viewerRole = await worker.fetch(new Request("https://control.example/roles", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ slug: "release-lead", capabilities: ["view_audit"] }) }), env);
    expect(viewerRole.status).toBe(403);
    database._state.memberships.set("user_1:org_1", { organization_id: "org_1", user_id: "user_1", role: "owner", status: "active" });
    database._state.factories.set("fac_x", { factory_id: "fac_x", organization_id: "org_2", name: "other", status: "active" });
    database._state.runs.set("run_x", { run_id: "run_x", work_order_id: "wo_x", factory_id: "fac_x", definition_digest: "sha256:x", status: "running" });
    expect((await worker.fetch(new Request("https://control.example/runs/run_x", { headers }), env)).status).toBe(404);
    database._state.workOrders.set("wo_x", { work_order_id: "wo_x", factory_id: "fac_x", organization_id: "org_2", status: "implementation", current_stage: "implementation" });
    const crossCancel = await worker.fetch(new Request("https://control.example/work-orders/wo_x/cancel", { method: "POST", headers }), env);
    expect(crossCancel.status).toBe(404);
    const crossFactoryMutation = await worker.fetch(new Request("https://control.example/factories/fac_x", { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "attacker-overwrite" }) }), env);
    expect(crossFactoryMutation.status).toBe(404);
    const crossChangeSet = await worker.fetch(new Request("https://control.example/change-sets", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "cross-tenant", workOrderId: "wo_x", repositories: [] }) }), env);
    expect(crossChangeSet.status).toBe(404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
