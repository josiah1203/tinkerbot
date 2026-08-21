import {
  D1JsonMetadataStore,
  D1TenantStore,
  HostedProviderConfig,
  evidenceStoreFromEnv,
} from "../../../packages/hosted-integrations/src";
import { translateLegacyVerdict } from "../../../packages/core/src/verdict";
import { type EntitlementKey } from "../../../packages/control-plane/src";
import { canonicalize } from "../../../packages/factory/src";
import { entitlementDenied, entitlementsForOrganization } from "./billing";
import { routeFactoryVerification } from "./factory-runtime";
import { D1FactoryStore } from "./factory-store";
import { publishVerificationToGitHub } from "./github-integrations";
import { authorizeTenantSession, currentSession, sessionStore, type AuthorizedSession } from "./tenant-auth";
import type { Env, handleFactoryQueueMessage } from "./index";

type CalculatedEntitlements = Awaited<ReturnType<typeof entitlementsForOrganization>>;
type QueueMessage = Parameters<typeof handleFactoryQueueMessage>[1];
type Json = (value: unknown, status?: number, headers?: HeadersInit) => Response;
type JsonBody = (request: Request, maxBytes?: number) => Promise<Record<string, unknown> | null>;

export interface AssuranceRouteSupport {
  json: Json;
  jsonBody: JsonBody;
  originAllowed: (request: Request, env: Env) => boolean;
  applicationUrl: (request: Request, env: Env, path: string) => string;
  calculatedAccess: (env: Env, access: AuthorizedSession) => Promise<CalculatedEntitlements>;
  entitledFailureFrom: (calculated: CalculatedEntitlements, feature: EntitlementKey, mutation?: boolean) => Response | null;
  handleFactoryQueueMessage: (env: Env, message: QueueMessage) => Promise<unknown>;
}

function assuranceRepository(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim();
}

function containsUntrustedSource(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsUntrustedSource(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (["sourcecode", "fulldiff", "patch", "diff", "diffcontent", "secret", "token", "apikey", "password", "credential", "privatekey"].includes(normalizedKey)) return true;
    if (containsUntrustedSource(child, depth + 1)) return true;
  }
  return false;
}

function validateHostedAssuranceBundle(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Assurance metadata must be an object." };
  const bundle = value as Record<string, unknown>;
  if (bundle.schemaVersion !== 1 || bundle.schemaId !== "https://tinkerbot.dev/schemas/assurance/v1") return { ok: false, error: "Unsupported assurance schema version." };
  for (const field of ["receipts", "graphs", "lifecycleEvents", "agentReceipts", "changeSets", "releaseManifests", "releaseAssessments", "outcomes", "decisions", "bindings", "calibrationEvents", "unknowns"]) if (!Array.isArray(bundle[field])) return { ok: false, error: `Assurance field ${field} must be an array.` };
  if (containsUntrustedSource(bundle)) return { ok: false, error: "Source, full diffs, secrets, and credentials are not accepted by hosted assurance ingestion." };
  if (JSON.stringify(bundle).length > 1_500_000) return { ok: false, error: "Assurance metadata is too large." };
  return { ok: true, value: bundle };
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

async function sha256Text(value: string): Promise<string> {
  return hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function verifyHostedReceipt(value: unknown, expected: { repository: string; sha?: string }): Promise<{ ok: true; receipt: Record<string, unknown> } | { ok: false; error: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Assurance receipt must be an object." };
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== 1 || receipt.schemaId !== "https://tinkerbot.dev/schemas/assurance/v1" || receipt.kind !== "verification-receipt") return { ok: false, error: "Assurance receipt schema is unsupported." };
  const integrity = receipt.integrity && typeof receipt.integrity === "object" && !Array.isArray(receipt.integrity) ? receipt.integrity as Record<string, unknown> : undefined;
  if (!integrity || integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(integrity.digest)) return { ok: false, error: "Assurance receipt integrity is invalid." };
  const { integrity: _ignored, ...payload } = receipt;
  const digest = `sha256:${hexDigest(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonicalize(payload)))))}`;
  if (!constantTimeTextEqual(integrity.digest, digest)) return { ok: false, error: "Assurance receipt integrity does not match its payload." };
  if (typeof receipt.repository !== "string" || receipt.repository.toLowerCase() !== expected.repository.toLowerCase()) return { ok: false, error: "Assurance receipt repository does not match the run token." };
  if (expected.sha && receipt.headSha !== expected.sha) return { ok: false, error: "Assurance receipt commit does not match the run token." };
  return { ok: true, receipt };
}

function assuranceMetadataKey(organizationId: string, repository: string): string {
  return `assurance:${encodeURIComponent(organizationId)}:${encodeURIComponent(repository)}`;
}

export async function handleAssuranceRoute(
  request: Request,
  env: Env,
  url: URL,
  config: HostedProviderConfig,
  support: AssuranceRouteSupport,
): Promise<Response | undefined> {
  const { json, jsonBody, originAllowed, applicationUrl, calculatedAccess, entitledFailureFrom, handleFactoryQueueMessage } = support;

  if (url.pathname === "/assurance/summary" && request.method === "GET") {
    const store = sessionStore(env, config);
    const database = env.DB;
    if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:read");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const calculated = await calculatedAccess(env, access);
    const denied = entitledFailureFrom(calculated, "assurance_metadata", true);
    if (denied) return denied;
    const repository = assuranceRepository(url.searchParams.get("repository"));
    if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
    const metadata = new D1JsonMetadataStore(database);
    const bundle = await metadata.get<Record<string, unknown>>(assuranceMetadataKey(access.membership.organizationId, repository));
    return json({ authorized: true, organizationId: access.membership.organizationId, repository, state: bundle ? "present" : "empty", sourceUpload: "not_uploaded", assurance: bundle ?? null });
  }

  if (url.pathname === "/assurance/ingest" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin assurance ingestion rejected.", code: "csrf_origin_rejected" }, 403);
    const store = sessionStore(env, config);
    const database = env.DB;
    if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
    const factories = new D1FactoryStore(database);
    const bearer = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{20,200})$/)?.[1];
    const runToken = bearer ? await factories.getRunToken(bearer) : null;
    let organizationId: string | undefined;
    let actorId = "action";
    if (runToken) {
      if (Date.parse(runToken.expiresAt) <= Date.now()) return json({ error: "The run token has expired.", code: "run_token_expired" }, 401);
    } else {
      const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:write");
      if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
      const calculated = await calculatedAccess(env, access);
      const denied = entitledFailureFrom(calculated, "assurance_metadata", true);
      if (denied) return denied;
      organizationId = access.membership.organizationId;
      actorId = access.current.session.user.id;
    }
    const body = await jsonBody(request);
    const repository = assuranceRepository(body?.repository);
    if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
    if (runToken && runToken.repository !== repository) return json({ error: "Run token repository mismatch.", code: "invalid_repository" }, 403);
    const metadata = new D1JsonMetadataStore(database);
    const tokenUseKey = runToken && bearer ? `assurance:run-token:${await sha256Text(bearer)}` : undefined;
    const tokenPayloadDigest = tokenUseKey ? await sha256Text(JSON.stringify(canonicalize({ repository, assurance: body?.assurance ?? body?.bundle }))) : undefined;
    const priorTokenUse = tokenUseKey ? await metadata.get<{ payloadDigest?: string }>(tokenUseKey) : null;
    if (priorTokenUse && priorTokenUse.payloadDigest !== tokenPayloadDigest) return json({ error: "The OIDC run token was already used for different assurance metadata.", code: "run_token_reused" }, 409);
    if (runToken) {
      const installation = await database.prepare("SELECT organization_id FROM tinkerbot_github_repositories r JOIN tinkerbot_github_installations i ON i.installation_id = r.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(repository).first<{ organization_id: string }>();
      const run = await factories.getRun(runToken.runId);
      const order = run?.work_order_id ? await factories.getWorkOrder(run.work_order_id) : null;
      if (order && (order.repositoryId.toLowerCase() !== repository.toLowerCase() || (installation?.organization_id && order.organizationId !== installation.organization_id))) return json({ error: "The run token is not scoped to this repository and installation.", code: "run_scope_mismatch" }, 403);
      organizationId = order?.organizationId ?? installation?.organization_id;
      if (organizationId) {
        const calculated = await entitlementsForOrganization(database, organizationId);
        const denied = entitlementDenied(calculated, "verification", true);
        if (denied) return json(denied, 403);
      }
    }
    const checked = validateHostedAssuranceBundle(body?.assurance ?? body?.bundle);
    if (!checked.ok) return json({ error: checked.error, code: "invalid_assurance_metadata" }, 400);
    let boundReceipt: Record<string, unknown> | undefined;
    const submittedReceipts = Array.isArray(checked.value.receipts) ? checked.value.receipts : [];
    if (runToken && submittedReceipts.length > 0) {
      for (const candidate of submittedReceipts) {
        const verifiedReceipt = await verifyHostedReceipt(candidate, { repository, sha: runToken.sha });
        if (!verifiedReceipt.ok) return json({ error: verifiedReceipt.error, code: "invalid_assurance_receipt" }, 400);
        boundReceipt = verifiedReceipt.receipt;
      }
      if (!boundReceipt) return json({ error: "A repository-bound assurance receipt is required.", code: "invalid_assurance_receipt" }, 400);
    }
    // Claim a run token before any metadata, evidence, Check Run, or workflow
    // side effect. D1JsonMetadataStore implements this as INSERT OR IGNORE,
    // so only one request can win the token-use race.
    if (tokenUseKey && tokenPayloadDigest && !priorTokenUse) {
      const claimed = await metadata.putIfAbsent?.(tokenUseKey, { payloadDigest: tokenPayloadDigest, runId: runToken?.runId, repository, expiresAt: runToken?.expiresAt });
      if (claimed !== true) {
        const racedTokenUse = await metadata.get<{ payloadDigest?: string }>(tokenUseKey);
        if (!racedTokenUse) return json({ error: "The assurance run-token claim could not be established.", code: "run_token_claim_unavailable" }, 503);
        if (racedTokenUse.payloadDigest !== tokenPayloadDigest) return json({ error: "The OIDC run token was already used for different assurance metadata.", code: "run_token_reused" }, 409);
        return json({ ingested: true, authorized: true, replayed: true, organizationId: organizationId ?? "oidc", repository, sourceUpload: "not_uploaded" });
      }
    }
    const org = organizationId ?? "oidc";
    const key = assuranceMetadataKey(org, repository);
    if (priorTokenUse) return json({ ingested: true, authorized: true, replayed: true, organizationId: org, repository, sourceUpload: "not_uploaded" });
    await metadata.put(key, { ...checked.value, repository, organizationId: org, ingestedAt: new Date().toISOString(), sourceUpload: "not_uploaded", runId: runToken?.runId });
    await metadata.put(`assurance:audit:${org}:${crypto.randomUUID()}`, { action: "assurance_ingest", repository, actorId, at: new Date().toISOString() });
    if (env.EVIDENCE_BUCKET) {
      await evidenceStoreFromEnv({ bucket: env.EVIDENCE_BUCKET, exportEndpoint: env.EVIDENCE_EXPORT_ENDPOINT, exportToken: env.EVIDENCE_EXPORT_TOKEN })?.put(`${org}/${repository.replace("/", "_")}/${runToken?.runId ?? crypto.randomUUID()}.json`, { ...checked.value, repository, organizationId: org });
    }
    await publishVerificationToGitHub(env, {
      repository,
      sha: runToken?.sha ?? (typeof (checked.value as { receipts?: Array<{ headSha?: string }> }).receipts?.[0]?.headSha === "string" ? (checked.value as { receipts: Array<{ headSha: string }> }).receipts[0].headSha : undefined),
      runId: runToken?.runId,
      bundle: checked.value,
      dashboardUrl: applicationUrl(request, env, "/app"),
    });
    const verdict = translateLegacyVerdict(typeof boundReceipt?.verdict === "string"
      ? boundReceipt.verdict
      : typeof (checked.value as { receipts?: Array<{ verdict?: string }> }).receipts?.[0]?.verdict === "string"
        ? (checked.value as { receipts: Array<{ verdict: string }> }).receipts[0].verdict
        : "UNKNOWN");
    if (runToken?.runId && env.DB) {
      const run = await factories.getRun(runToken.runId);
      if (run?.work_order_id) {
        const order = await factories.getWorkOrder(run.work_order_id);
        if (order) {
          const changeSetId = runToken.sha ?? order.workOrderId;
          const changeSetDigest = runToken.sha ? `sha256:${runToken.sha}` : order.definitionDigest;
          await routeFactoryVerification(env, { workOrderId: order.workOrderId, organizationId: order.organizationId, actorId: "deterministic-verifier", changeSetId, changeSetDigest, verificationRunId: runToken.runId, verdict, now: new Date().toISOString() });
          await handleFactoryQueueMessage(env, { deliveryId: `oidc:${runToken.runId}`, organizationId: order.organizationId, factoryId: order.factoryId, repository, sourceType: order.sourceType, sourceId: order.sourceId, workOrderId: order.workOrderId, actor: "oidc-ingest", sha: runToken.sha, verificationVerdict: verdict, verificationIngested: true, specApproved: true, sandboxComplete: true });
        }
      }
    }
    if (tokenUseKey && tokenPayloadDigest) await metadata.put(tokenUseKey, { payloadDigest: tokenPayloadDigest, runId: runToken?.runId, repository, expiresAt: runToken?.expiresAt });
    return json({ ingested: true, authorized: true, organizationId: org, repository, sourceUpload: "not_uploaded" });
  }

  if (url.pathname === "/assurance/delete" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "Cross-origin assurance deletion rejected.", code: "csrf_origin_rejected" }, 403);
    const store = sessionStore(env, config);
    const database = env.DB;
    if (!store || !database) return json({ error: "Hosted assurance requires the D1 session and metadata stores.", code: "assurance_store_not_configured" }, 501);
    const access = await authorizeTenantSession(await currentSession(request, store, env), new D1TenantStore(database), "assurance:delete");
    if (!access.ok) return json({ error: access.error, code: access.code }, access.status);
    const body = await jsonBody(request);
    const repository = assuranceRepository(body?.repository);
    if (!repository) return json({ error: "A repository reference is required.", code: "invalid_repository" }, 400);
    const metadata = new D1JsonMetadataStore(database);
    await metadata.delete(assuranceMetadataKey(access.membership.organizationId, repository));
    await metadata.put(`assurance:audit:${access.membership.organizationId}:${crypto.randomUUID()}`, { action: "assurance_delete", repository, actorId: access.current.session.user.id, at: new Date().toISOString() });
    return json({ deleted: true, authorized: true, organizationId: access.membership.organizationId, repository });
  }

  return undefined;
}
