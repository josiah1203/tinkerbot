import {
  implementBranchName,
  selfHostedSecretReady,
  verifySelfHostedCompletion,
  type FactoryEvent,
  type FactoryQueueMessage,
} from "../../../packages/factory/src";
import { routeFactoryGraphCommand, routeFactoryTransition, type FactoryTurnResult } from "./factory-runtime";
import { D1FactoryStore } from "./factory-store";
import type { Env } from "./index";

type HostedFactoryQueueMessage = FactoryQueueMessage & {
  factoryId?: string;
  workOrderId?: string;
  specApproved?: boolean;
  sandboxComplete?: boolean;
  pullRequestSha?: string;
  verificationVerdict?: string;
  verificationIngested?: boolean;
};

type JsonBody = (request: Request, maxBytes?: number) => Promise<Record<string, unknown> | null>;
type JsonResponse = (value: unknown, status?: number, headers?: HeadersInit) => Response;

export interface SelfHostedRouteSupport {
  json: JsonResponse;
  jsonBody: JsonBody;
  handleFactoryQueueMessage: (env: Env, message: HostedFactoryQueueMessage) => Promise<FactoryTurnResult>;
}

export async function handleSelfHostedCompletion(
  request: Request,
  env: Env,
  url: URL,
  factories: D1FactoryStore,
  support: SelfHostedRouteSupport,
): Promise<Response | undefined> {
  if (url.pathname === "/self-hosted/complete" && request.method === "POST") {
    const secret = env.SELF_HOSTED_WORK_SECRET ?? (env.ENVIRONMENT === "production" ? undefined : env.SESSION_ENCRYPTION_KEY);
    if (!secret || (env.ENVIRONMENT === "production" && !selfHostedSecretReady(secret))) return support.json({ error: "Self-hosted completion is not configured.", code: "self_hosted_not_configured" }, 503);
    const body = await support.jsonBody(request);
    const checked = verifySelfHostedCompletion(body, secret);
    if (!checked.ok) return support.json({ error: "Self-hosted completion was rejected.", code: checked.reason }, 401);
    const completion = checked.payload;
    if (completion.dispatchId !== `selfhost:${completion.workOrderId}:${completion.runId}`) return support.json({ error: "Dispatch identity does not match the work order and run.", code: "dispatch_mismatch" }, 403);
    const order = await factories.getWorkOrder(completion.workOrderId);
    if (!order || order.organizationId !== completion.organizationId || order.factoryId !== completion.factoryId || order.repositoryId.toLowerCase() !== completion.repository.toLowerCase()) return support.json({ error: "Self-hosted completion does not match the persisted work order.", code: "completion_scope_mismatch" }, 403);
    const run = await factories.getRun(completion.runId);
    if (!run || run.work_order_id !== order.workOrderId || run.factory_id !== order.factoryId) return support.json({ error: "Self-hosted completion references an unknown run.", code: "run_not_found" }, 404);
    if (run.definition_digest !== completion.definitionDigest) return support.json({ error: "Self-hosted completion was produced from a different factory definition.", code: "definition_digest_mismatch" }, 409);
    // The local worker's leased cell has one deterministic branch per work
    // order. A signed customer worker is still untrusted, so do not accept a
    // valid-looking tinkerbot/* ref that belongs to another work order.
    if (completion.branch && completion.branch !== implementBranchName(order.workOrderId)) return support.json({ error: "Self-hosted completion reported the wrong work-order branch.", code: "branch_scope_mismatch" }, 409);
    // An event is the durable idempotency claim. If a prior request claimed
    // the dispatch but crashed before advancing the run, retry the resume while
    // the run is still live; only terminal/non-waiting runs are pure replays.
    const priorEvents = await factories.listFactoryEvents(order.workOrderId, order.organizationId);
    const priorCompletionEvent = priorEvents.find((event) => ["task.completed", "task.blocked"].includes(event.type) && (event.payload as Record<string, unknown>).dispatchId === completion.dispatchId);
    if (priorCompletionEvent && ((completion.status === "completed") !== (priorCompletionEvent.type === "task.completed"))) return support.json({ error: "Self-hosted completion conflicts with an earlier terminal report.", code: "completion_status_conflict" }, 409);
    const priorCompletion = Boolean(priorCompletionEvent);
    if (priorCompletion && run.status !== "running" && run.status !== "waiting:self_hosted_harness") return support.json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
    if (run.status !== "running" && run.status !== "waiting:self_hosted_harness") return support.json({ error: "Self-hosted completion references a run that is no longer awaiting implementation.", code: "run_not_waiting" }, 409);
    if (!["implementation", "review", "verification", "unknown"].includes(order.status)) return support.json({ error: "Self-hosted completion arrived outside the implementation boundary.", code: "invalid_work_order_state" }, 409);
    const now = new Date().toISOString();
    if (completion.status === "failed") {
      const payload = { dispatchId: completion.dispatchId, status: completion.status, summary: completion.summary ?? "Self-hosted worker reported failure." };
      const event: FactoryEvent = {
        eventId: `selfhost-failed:${completion.dispatchId}`,
        type: "task.blocked",
        aggregateId: order.workOrderId,
        aggregateType: "work_order",
        organizationId: order.organizationId,
        factoryId: order.factoryId,
        actorId: "self-hosted-worker",
        actorType: "agent",
        occurredAt: now,
        correlationId: completion.runId,
        schemaVersion: 1,
        policyVersion: order.policyVersion,
        provenance: "ATTESTED",
        payload: { dispatchId: completion.dispatchId, reason: completion.summary ?? "Self-hosted worker reported failure." },
      };
      const command = await routeFactoryGraphCommand(env, {
        organizationId: order.organizationId,
        factoryId: order.factoryId,
        workOrderId: order.workOrderId,
        actorId: "self-hosted-worker",
        actorType: "agent",
        idempotencyKey: `self-hosted:${completion.dispatchId}:failed`,
        payload,
        now,
        event,
      });
      if (command.replayed || priorCompletion) return support.json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
      const failed = await routeFactoryTransition(env, { organizationId: order.organizationId, workOrderId: order.workOrderId, toState: "failed", causeId: `self-hosted-complete:${completion.dispatchId}`, actor: "self-hosted-worker", now });
      if (!failed.ok && failed.code !== "idempotent") return support.json({ error: "The failed completion could not advance the work order.", code: failed.code }, 409);
      await factories.updateRun(completion.runId, "failed", now);
      return support.json({ accepted: true, terminal: "failed", workOrderId: order.workOrderId, runId: completion.runId });
    }
    const payload = { dispatchId: completion.dispatchId, status: completion.status, branch: completion.branch, headSha: completion.headSha, pullRequestNumber: completion.pullRequestNumber, summary: completion.summary };
    const event: FactoryEvent = {
      eventId: `selfhost-completed:${completion.dispatchId}`,
      type: "task.completed",
      aggregateId: order.workOrderId,
      aggregateType: "work_order",
      organizationId: order.organizationId,
      factoryId: order.factoryId,
      actorId: "self-hosted-worker",
      actorType: "agent",
      occurredAt: now,
      correlationId: completion.runId,
      schemaVersion: 1,
      policyVersion: order.policyVersion,
      provenance: "ATTESTED",
      payload: { dispatchId: completion.dispatchId, branch: completion.branch, headSha: completion.headSha, pullRequestNumber: completion.pullRequestNumber, summary: completion.summary },
    };
    const command = await routeFactoryGraphCommand(env, {
      organizationId: order.organizationId,
      factoryId: order.factoryId,
      workOrderId: order.workOrderId,
      actorId: "self-hosted-worker",
      actorType: "agent",
      idempotencyKey: `self-hosted:${completion.dispatchId}:completed`,
      payload,
      now,
      event,
    });
    if (command.replayed || priorCompletion) return support.json({ accepted: true, replayed: true, workOrderId: order.workOrderId, runId: completion.runId });
    const resumed = await support.handleFactoryQueueMessage(env, { deliveryId: `self-hosted-complete:${completion.dispatchId}`, organizationId: order.organizationId, factoryId: order.factoryId, repository: completion.repository, sourceType: order.sourceType, sourceId: order.sourceId, workOrderId: order.workOrderId, actor: "self-hosted-worker", sandboxComplete: true, pullRequestSha: completion.headSha, specApproved: true });
    return support.json({ accepted: true, workOrderId: resumed?.workOrderId ?? order.workOrderId, runId: resumed?.runId ?? completion.runId, terminal: resumed?.terminal ?? "unknown", wait: resumed?.wait });
  }
}
