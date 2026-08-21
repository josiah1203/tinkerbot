import {
  D1JsonMetadataStore,
  D1TenantStore,
  D1WebhookLedger,
  type D1DatabaseLike,
  type HostedProviderConfig,
} from "../../../packages/hosted-integrations/src";
import { admitWebhook, mintInstallationToken } from "../../../packages/github/src";
import { admitGitlabWebhook } from "../../../packages/gitlab/src";
import {
  dispatchTinkerGateway,
  githubSecurityIntake,
  githubTinkerMention,
  type FactoryQueueMessage,
} from "../../../packages/factory/src";
import { WorkOSAuthProvider } from "../../../packages/hosted-integrations/src";
import { D1FactoryStore } from "./factory-store";
import { intakeFromIntegration } from "./factory-runtime";
import { persistGitHubWebhook } from "./github-integrations";
import { applyWorkOSEvent } from "./workos-sync";
import { authorizeTenantSession, currentSession, sessionStore } from "./tenant-auth";

export interface IntegrationRouteEnv extends Record<string, unknown> {
  ENVIRONMENT?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITLAB_WEBHOOK_SECRET?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  WORKOS_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  JIRA_WEBHOOK_SECRET?: string;
  INCIDENT_WEBHOOK_SECRET?: string;
  SUPPORT_WEBHOOK_SECRET?: string;
  INTEGRATION_ORGANIZATION_ID?: string;
  SESSION_ENCRYPTION_KEY?: string;
  DB?: D1DatabaseLike;
  FACTORY_EVENTS?: { send(body: unknown): Promise<void> };
}

type QueueDispatchMessage = FactoryQueueMessage & {
  factoryId?: string;
  workOrderId?: string;
  specApproved?: boolean;
  sandboxComplete?: boolean;
  pullRequestSha?: string;
  verificationVerdict?: string;
  verificationIngested?: boolean;
};

export interface IntegrationRouteDependencies {
  json(value: unknown, status?: number): Response;
  readBodyText(request: Request, maxBytes: number): Promise<string>;
  handleFactoryQueueMessage(env: IntegrationRouteEnv, message: QueueDispatchMessage): Promise<unknown>;
}

function configuredOrganization(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : undefined;
}

function hexDigest(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function verifyIntegrationWebhook(request: Request, payload: string, kind: "slack" | "linear" | "jira" | "incident" | "support", secret: string): Promise<boolean> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 16) return false;
  const signatureHeader = kind === "slack" ? request.headers.get("x-slack-signature") : kind === "linear" ? request.headers.get("linear-signature") : request.headers.get("x-webhook-signature") ?? request.headers.get("x-hub-signature-256");
  if (!signatureHeader) return false;
  let signedPayload = payload;
  let expectedPrefix = "";
  if (kind === "slack") {
    const timestamp = Number(request.headers.get("x-slack-request-timestamp"));
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
    signedPayload = `v0:${timestamp}:${payload}`;
    expectedPrefix = "v0=";
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = `${expectedPrefix}${hexDigest(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)))}`;
  const candidate = signatureHeader.trim().split(",")[0]?.trim().replace(/^sha256=/i, "") ?? "";
  return constantTimeTextEqual(candidate, expected.replace(/^v0=/, "")) || constantTimeTextEqual(signatureHeader.trim(), expected);
}

export async function handleIntegrationRoute(
  request: Request,
  env: IntegrationRouteEnv,
  url: URL,
  config: HostedProviderConfig,
  dependencies: IntegrationRouteDependencies,
): Promise<Response | undefined> {
  const { json, readBodyText, handleFactoryQueueMessage } = dependencies;

  if (url.pathname === "/tinker/commands" && request.method === "POST") {
    const store = sessionStore(env, config);
    if (!store || !env.DB) return json({ error: "The @tinker gateway requires a hosted session.", code: "session_store_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "factory:write");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const body = await readBodyText(request, 1_500_000).then((payload) => {
      try {
        const parsed = JSON.parse(payload) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    });
    if (!body) return json({ error: "A JSON command body is required.", code: "invalid_request" }, 400);
    const sourceSystem = body.sourceSystem === "github" || body.sourceSystem === "slack" || body.sourceSystem === "jira" || body.sourceSystem === "linear" || body.sourceSystem === "manual" ? body.sourceSystem : "manual";
    const result = dispatchTinkerGateway({
      text: typeof body.text === "string" ? body.text : "",
      organizationId: access.membership.organizationId,
      sourceSystem,
      sourceObjectId: typeof body.sourceObjectId === "string" ? body.sourceObjectId : crypto.randomUUID(),
      actorId: access.current.session.user.id,
      authorized: true,
      workOrderId: typeof body.workOrderId === "string" ? body.workOrderId : undefined,
    });
    await new D1FactoryStore(env.DB).insertFactoryCommand(result.command);
    return json({ ...result, projection: "WorkOrder traveler. Not a verification verdict." });
  }

  const genericWebhookKinds = ["slack", "linear", "jira", "incident", "support"] as const;
  const genericWebhookKind = genericWebhookKinds.find((kind) => url.pathname === `/integrations/${kind}/webhook`);
  if (genericWebhookKind && request.method === "POST") {
    const secret = genericWebhookKind === "slack" ? env.SLACK_WEBHOOK_SECRET : genericWebhookKind === "linear" ? env.LINEAR_WEBHOOK_SECRET : genericWebhookKind === "jira" ? env.JIRA_WEBHOOK_SECRET : genericWebhookKind === "incident" ? env.INCIDENT_WEBHOOK_SECRET : env.SUPPORT_WEBHOOK_SECRET;
    const integrationOrganization = configuredOrganization(env.INTEGRATION_ORGANIZATION_ID);
    if (env.ENVIRONMENT === "production" && (!secret || !integrationOrganization)) return json({ error: "Signed integration webhook and tenant binding are not configured.", code: "integration_not_configured" }, 503);
    const payload = await readBodyText(request, 1_500_000);
    if (secret && !await verifyIntegrationWebhook(request, payload, genericWebhookKind, secret)) return json({ error: "Integration webhook signature is invalid.", code: "invalid_integration_signature" }, 401);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "Integration webhook body must be a JSON object.", code: "invalid_request" }, 400);
    }
    if (genericWebhookKind === "slack" && body.type === "url_verification") return json({ challenge: body.challenge });
    const message = intakeFromIntegration(genericWebhookKind, body);
    if (integrationOrganization) message.organizationId = integrationOrganization;
    const suppliedDelivery = request.headers.get("x-request-id") ?? request.headers.get("x-event-id") ?? (typeof body.event_id === "string" ? body.event_id : typeof body.id === "string" ? body.id : message.deliveryId);
    const deliveryId = `${genericWebhookKind}:${suppliedDelivery && /^[A-Za-z0-9:._-]{1,200}$/.test(suppliedDelivery) ? suppliedDelivery : `sha256:${hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)))}`}`;
    const ledger = new D1WebhookLedger(env.DB!, `integration:${genericWebhookKind}`);
    if (ledger.claim && !await ledger.claim(deliveryId)) return json({ received: true, duplicate: true, sourceType: genericWebhookKind, deliveryId });
    try {
      message.deliveryId = deliveryId;
      if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
      else await handleFactoryQueueMessage(env, message);
      await ledger.record(deliveryId);
    } catch (error) {
      if (ledger.release) await ledger.release(deliveryId);
      throw error;
    }
    return json({ received: true, sourceType: genericWebhookKind, deliveryId });
  }

  if (url.pathname === "/integrations/github" && request.method === "GET") {
    if (!env.DB) return json({ error: "GitHub integration metadata requires the D1 store.", code: "github_installation_store_not_configured" }, 501);
    const store = sessionStore(env, config);
    if (!store) return json({ error: "GitHub integration metadata requires a hosted session store.", code: "session_store_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const statement = env.DB.prepare("SELECT installation_id, account_login, status, updated_at FROM tinkerbot_github_installations WHERE organization_id = ?1").bind(access.membership.organizationId);
    const rows = typeof statement.all === "function" ? (await statement.all<{ installation_id: number; account_login?: string; status: string; updated_at: string }>()).results ?? [] : [];
    return json({ authorized: true, installations: rows });
  }

  if (url.pathname === "/integrations/github/install/callback" && request.method === "GET") {
    const store = sessionStore(env, config);
    if (!store || !env.DB) return json({ error: "GitHub installation binding requires the D1 session and tenant stores.", code: "github_installation_store_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(env.DB), "tenant:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return json({ error: "A valid GitHub installation_id is required.", code: "invalid_github_installation" }, 400);
    const existingInstallation = await env.DB.prepare("SELECT organization_id, status FROM tinkerbot_github_installations WHERE installation_id = ?1 LIMIT 1").bind(installationId).first<{ organization_id?: string | null; status?: string }>();
    if (existingInstallation?.organization_id && existingInstallation.organization_id !== access.membership.organizationId) return json({ error: "That GitHub installation is already connected to another organization.", code: "github_installation_owned" }, 409);
    if (env.ENVIRONMENT === "production" && (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)) return json({ error: "GitHub App verification is not configured.", code: "github_app_not_configured" }, 503);
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId });
      } catch {
        return json({ error: "The GitHub installation could not be verified for this App.", code: "github_installation_unverified" }, 403);
      }
    }
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO tinkerbot_github_installations (installation_id, organization_id, status, installed_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3) ON CONFLICT(installation_id) DO UPDATE SET organization_id = excluded.organization_id, updated_at = excluded.updated_at").bind(installationId, access.membership.organizationId, now).run();
    return json({ connected: true, authorized: true, organizationId: access.membership.organizationId, installationId });
  }

  if (url.pathname === "/integrations/github/webhook" && request.method === "POST") {
    if (!env.DB) return json({ error: "GitHub webhook persistence requires the D1 store.", code: "github_webhook_store_not_configured" }, 501);
    const payload = await readBodyText(request, 1_500_000);
    const eventName = request.headers.get("x-github-event") ?? undefined;
    const deliveryId = request.headers.get("x-github-delivery") ?? undefined;
    const admission = admitWebhook({ payload, signature: request.headers.get("x-hub-signature-256") ?? undefined, secret: env.GITHUB_WEBHOOK_SECRET, eventName, deliveryId });
    if (!admission.accepted || !admission.payload || !admission.idempotencyKey) return json({ error: "GitHub webhook was rejected.", code: admission.reason ?? "invalid_github_webhook" }, 401);
    const ledger = new D1WebhookLedger(env.DB, "github");
    if (ledger.claim && !await ledger.claim(admission.idempotencyKey)) return json({ received: true, duplicate: true });
    try {
      const persisted = await persistGitHubWebhook(env.DB, admission.payload, eventName);
      await new D1JsonMetadataStore(env.DB).put(`github:audit:${admission.idempotencyKey}`, admission.audit);
      if (persisted.kind === "pull_request" || persisted.kind === "issue") {
        const sourceType: "github_issue" | "github_pull_request" = persisted.kind === "issue" ? "github_issue" : "github_pull_request";
        const message: QueueDispatchMessage = { deliveryId: admission.idempotencyKey, installationId: persisted.installationId, repository: persisted.repository, sourceType, sourceId: persisted.sourceId ?? admission.idempotencyKey, issueOrPullRequest: persisted.sourceId, sha: persisted.sha, actor: "github-webhook" };
        if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
        else await handleFactoryQueueMessage(env, message);
      }
      const security = githubSecurityIntake(eventName ?? "", admission.payload);
      if (security) {
        const message: QueueDispatchMessage = { deliveryId: admission.idempotencyKey, installationId: persisted.installationId, repository: persisted.repository, sourceType: security.sourceType, sourceId: security.sourceId, issueOrPullRequest: security.title, actor: "github-webhook" };
        if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
        else await handleFactoryQueueMessage(env, message);
      }
      const mention = githubTinkerMention(eventName ?? "", admission.payload as Record<string, unknown>);
      const githubOrganization = persisted.installationId
        ? await env.DB.prepare("SELECT organization_id FROM tinkerbot_github_installations WHERE installation_id = ?1 LIMIT 1").bind(persisted.installationId).first<{ organization_id?: string | null }>()
        : persisted.repository
          ? await env.DB.prepare("SELECT i.organization_id FROM tinkerbot_github_repositories r JOIN tinkerbot_github_installations i ON i.installation_id = r.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(persisted.repository).first<{ organization_id?: string | null }>()
          : null;
      if (mention && githubOrganization?.organization_id) {
        const dispatched = dispatchTinkerGateway({ text: mention, organizationId: githubOrganization.organization_id, sourceSystem: "github", sourceObjectId: admission.idempotencyKey, actorId: "github-webhook", authorized: true });
        await new D1FactoryStore(env.DB).insertFactoryCommand(dispatched.command);
        await new D1JsonMetadataStore(env.DB).put(`tinker:${admission.idempotencyKey}`, dispatched);
      }
      await ledger.record(admission.idempotencyKey);
      return json({ received: true, duplicate: false });
    } catch (error) {
      if (ledger.release) await ledger.release(admission.idempotencyKey);
      throw error;
    }
  }

  if (url.pathname === "/integrations/gitlab/webhook" && request.method === "POST") {
    if (!env.DB) return json({ error: "GitLab webhook persistence requires the D1 store.", code: "gitlab_webhook_store_not_configured" }, 501);
    const integrationOrganization = configuredOrganization(env.INTEGRATION_ORGANIZATION_ID);
    if (env.ENVIRONMENT === "production" && (!env.GITLAB_WEBHOOK_SECRET || !integrationOrganization)) return json({ error: "Signed GitLab webhook and tenant binding are not configured.", code: "integration_not_configured" }, 503);
    const payload = await readBodyText(request, 1_500_000);
    const admission = admitGitlabWebhook({ payload, token: request.headers.get("x-gitlab-token") ?? undefined, secret: env.GITLAB_WEBHOOK_SECRET, eventName: request.headers.get("x-gitlab-event") ?? undefined, deliveryId: request.headers.get("x-gitlab-event-uuid") ?? request.headers.get("x-request-id") ?? undefined });
    if (!admission.accepted || !admission.payload || !admission.idempotencyKey || !admission.sourceType) return json({ error: "GitLab webhook was rejected.", code: admission.reason ?? "invalid_gitlab_webhook" }, 401);
    const ledger = new D1WebhookLedger(env.DB, "gitlab");
    if (ledger.claim && !await ledger.claim(admission.idempotencyKey)) return json({ received: true, duplicate: true });
    try {
      await new D1JsonMetadataStore(env.DB).put(`gitlab:audit:${admission.idempotencyKey}`, { sourceType: admission.sourceType, repository: admission.repository, event: request.headers.get("x-gitlab-event"), merge: false });
      const message: QueueDispatchMessage = { deliveryId: admission.idempotencyKey, organizationId: integrationOrganization, repository: admission.repository, sourceType: admission.sourceType, sourceId: admission.sourceId ?? admission.idempotencyKey, issueOrPullRequest: admission.title, actor: "gitlab-webhook" };
      if (env.FACTORY_EVENTS) await env.FACTORY_EVENTS.send(message);
      else await handleFactoryQueueMessage(env, message);
      await ledger.record(admission.idempotencyKey);
      return json({ received: true, duplicate: false, merge: false, sourceType: admission.sourceType });
    } catch (error) {
      if (ledger.release) await ledger.release(admission.idempotencyKey);
      throw error;
    }
  }

  if (url.pathname === "/integrations/workos/webhook" && request.method === "POST") {
    if (!env.DB) return json({ error: "WorkOS webhook verification is wired, but the D1 webhook ledger is not configured yet.", code: "webhook_ledger_not_configured" }, 501);
    const payload = await readBodyText(request, 2_000_000);
    const provider = new WorkOSAuthProvider({ clientId: config.workos.clientId, apiKey: config.workos.apiKey, webhookSecret: config.workos.webhookSecret });
    const ledger = new D1WebhookLedger(env.DB, "workos");
    const tenants = new D1TenantStore(env.DB);
    const result = await provider.handleWebhook(payload, request.headers.get("workos-signature"), ledger, (event) => applyWorkOSEvent(event, tenants, env));
    return json({ received: true, duplicate: result.duplicate });
  }

  return undefined;
}
