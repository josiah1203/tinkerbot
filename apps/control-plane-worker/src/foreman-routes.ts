import { D1FactoryStore } from "./factory-store";
import { runFactoryTurn, type FactoryEnv } from "./factory-runtime";
import { boundedJsonObject } from "./factory-request";
import { classifyWorkOrderGroup, isWorkOrderState, type FactoryEvent } from "../../../packages/factory/src";

export async function runForemanWorkDecision(env: FactoryEnv, input: { workOrderId: string; organizationId: string; actor: string; type: "review" | "release"; decision: "approved" | "rejected" | "changes_requested" | "hold"; now: string }): Promise<{ workOrder: Awaited<ReturnType<D1FactoryStore["getWorkOrderView"]>>; availableActions: unknown[] }> {
  if (!env.DB) throw new Error("foreman_database_not_configured");
  const factories = new D1FactoryStore(env.DB);
  const order = await factories.getWorkOrderForOrganization(input.workOrderId, input.organizationId);
  if (!order) throw new Error("work_order_not_found");
  if (input.type === "release" && input.decision !== "approved" && input.decision !== "hold") throw new Error("invalid_release_decision");
  await factories.recordTypedDecision({ workOrderId: order.workOrderId, organizationId: input.organizationId, actor: input.actor, type: input.type, decision: input.decision, now: input.now });
  if (input.type === "release" && input.decision === "approved") {
    const transition = order.status === "ready" ? await factories.applyTransition(order.workOrderId, "merged", `release-merge:${crypto.randomUUID()}`, input.actor) : { ok: true as const, order };
    if (!transition.ok) throw new Error(`release_candidate_${transition.code}`);
    const released = transition.order.status === "merged" ? await factories.applyTransition(order.workOrderId, "released", `release:${crypto.randomUUID()}`, input.actor) : transition;
    if (!released.ok) throw new Error(`release_transition_${released.code}`);
  }
  const workOrder = await factories.getWorkOrderView(order.workOrderId, input.organizationId);
  return { workOrder, availableActions: workOrder?.availableActions ?? [] };
}

/**
 * Durable Object boundary for serialized WorkOrder coordination. All
 * lifecycle mutations still delegate to the Factory command/runtime
 * authorities; this module owns only the internal request admission surface.
 */
export class ForemanDurableObject {
  constructor(private readonly state: { id: { toString(): string } }, private readonly env: FactoryEnv) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed = request.method === "POST" ? await boundedJsonObject(request) : { value: {} };
    if ("tooLarge" in parsed) return Response.json({ error: "Request body is too large.", code: "payload_too_large" }, { status: 413 });
    const body = parsed.value;
    // Queue/workflow deliveries enter through the Foreman object so one work
    // order has a serialized coordinator even when Cloudflare retries or
    // parallel producers deliver messages at the same time. Keep the legacy
    // steer shape below for local/operator callers that only send a note.
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && typeof body.deliveryId === "string"
      && typeof body.sourceType === "string"
      && typeof body.sourceId === "string"
      && typeof body.actor === "string") {
      const result = await runFactoryTurn(this.env, body as unknown as Parameters<typeof runFactoryTurn>[1]);
      return Response.json(result);
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "work_decision"
      && typeof body.workOrderId === "string"
      && typeof body.organizationId === "string"
      && typeof body.actor === "string"
      && (body.type === "review" || body.type === "release")
      && (body.decision === "approved" || body.decision === "rejected" || body.decision === "changes_requested" || body.decision === "hold")) {
      const result = await runForemanWorkDecision(this.env, { workOrderId: body.workOrderId, organizationId: body.organizationId, actor: body.actor, type: body.type, decision: body.decision, now: typeof body.now === "string" ? body.now : new Date().toISOString() });
      return Response.json(result);
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "graph_command"
      && typeof body.organizationId === "string"
      && typeof body.factoryId === "string"
      && typeof body.workOrderId === "string"
      && typeof body.actorId === "string"
      && (body.actorType === "human" || body.actorType === "agent" || body.actorType === "system" || body.actorType === "integration")
      && typeof body.idempotencyKey === "string"
      && body.payload !== null
      && typeof body.payload === "object"
      && !Array.isArray(body.payload)
      && body.event !== null
      && typeof body.event === "object"
      && !Array.isArray(body.event)) {
      if (!this.env.DB) return Response.json({ error: "Foreman database is not configured.", code: "foreman_database_not_configured" }, { status: 503 });
      const factories = new D1FactoryStore(this.env.DB);
      const result = await factories.dispatchFactoryCommand({
        organizationId: body.organizationId,
        factoryId: body.factoryId,
        workOrderId: body.workOrderId,
        actorId: body.actorId,
        actorType: body.actorType,
        idempotencyKey: body.idempotencyKey,
        payload: body.payload as Record<string, unknown>,
        now: typeof body.now === "string" ? body.now : new Date().toISOString(),
        buildEvents: () => [body.event as FactoryEvent],
      });
      return Response.json(result);
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "transition"
      && typeof body.organizationId === "string"
      && typeof body.workOrderId === "string"
      && typeof body.toState === "string"
      && isWorkOrderState(body.toState)
      && typeof body.causeId === "string"
      && typeof body.actor === "string") {
      if (!this.env.DB) return Response.json({ error: "Foreman database is not configured.", code: "foreman_database_not_configured" }, { status: 503 });
      const result = await new D1FactoryStore(this.env.DB).applyTransition(body.workOrderId, body.toState, body.causeId, body.actor, typeof body.now === "string" ? body.now : undefined);
      return Response.json(result, { status: result.ok ? 200 : result.code === "not_found" ? 404 : 409 });
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "spec_approval"
      && typeof body.workOrderId === "string"
      && typeof body.organizationId === "string"
      && typeof body.actor === "string"
      && (body.decision === "approved" || body.decision === "rejected")
      && typeof body.signature === "string") {
      if (!this.env.DB) return Response.json({ error: "Foreman database is not configured.", code: "foreman_database_not_configured" }, { status: 503 });
      await new D1FactoryStore(this.env.DB).insertApproval(body.workOrderId, body.actor, body.decision, body.signature, typeof body.now === "string" ? body.now : new Date().toISOString());
      return Response.json({ accepted: true });
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "cell_hold"
      && typeof body.workOrderId === "string"
      && typeof body.organizationId === "string"
      && typeof body.actor === "string"
      && (body.action === "take" || body.action === "return")) {
      if (!this.env.DB) return Response.json({ error: "Foreman database is not configured.", code: "foreman_database_not_configured" }, { status: 503 });
      const workOrder = await new D1FactoryStore(this.env.DB).setWorkOrderCellHold({ workOrderId: body.workOrderId, organizationId: body.organizationId, actor: body.actor, action: body.action, now: typeof body.now === "string" ? body.now : new Date().toISOString() });
      if (!workOrder) return Response.json({ error: "Work order not found.", code: "not_found" }, { status: 404 });
      return Response.json({ ok: true, workOrder, held: body.action === "take" });
    }
    if (request.method === "POST"
      && request.headers.get("x-tinkerbot-internal") === "foreman-v1"
      && body.command === "record_verification"
      && typeof body.workOrderId === "string"
      && typeof body.organizationId === "string"
      && typeof body.verificationRunId === "string"
      && (body.verdict === "PASS" || body.verdict === "FAIL" || body.verdict === "UNKNOWN")) {
      if (!this.env.DB) return Response.json({ error: "Foreman database is not configured.", code: "foreman_database_not_configured" }, { status: 503 });
      const result = await new D1FactoryStore(this.env.DB).recordVerification({
        workOrderId: body.workOrderId,
        organizationId: body.organizationId,
        actorId: typeof body.actorId === "string" ? body.actorId : undefined,
        changeSetId: typeof body.changeSetId === "string" ? body.changeSetId : undefined,
        changeSetDigest: typeof body.changeSetDigest === "string" ? body.changeSetDigest : undefined,
        verificationRunId: body.verificationRunId,
        verdict: body.verdict,
        now: typeof body.now === "string" ? body.now : new Date().toISOString(),
      });
      return Response.json({ projection: result });
    }
    if (url.pathname.endsWith("/steer") || request.method === "POST") {
      const workOrderId = typeof body.workOrderId === "string" ? body.workOrderId : this.state.id.toString();
      const note = typeof body.note === "string" ? body.note : "";
      const repository = typeof body.repository === "string" ? body.repository : undefined;
      const result = await runFactoryTurn(this.env, {
        deliveryId: `steer:${crypto.randomUUID()}`,
        sourceType: "manual",
        sourceId: workOrderId,
        actor: "steer",
        workOrderId,
        repository,
        issueOrPullRequest: note,
        organizationId: typeof body.organizationId === "string" ? body.organizationId : undefined,
      });
      return Response.json({ steered: true, ...result });
    }
    return Response.json({ workOrderId: this.state.id.toString(), group: classifyWorkOrderGroup("intake") });
  }
}
