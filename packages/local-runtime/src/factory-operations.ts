import fs from "node:fs";
import path from "node:path";
import {
  calculateFactoryEconomics,
  compileFactoryPlan,
  createApprovalRecordedEvent,
  createMicroIntent,
  createWorkOrder,
  emptyWaiver,
  factoryId,
  factoryPlanSafe,
  initFactoryTree,
  linkAcceptanceCriterion,
  loadFactoryDefinition,
  mapLineId,
  pinWorkOrderPlan,
  projectFactoryEvents,
  STARTER_FACTORY_PACKS,
  validateIntent,
  type OutcomeStatus,
} from "../../factory/src";
import { defaultLocalDbPath, SqliteFactoryStore } from "./sqlite-store";

export function factoryInitPayload(root: string, name?: string): Record<string, unknown> {
  const existing = path.join(root, ".tinkerbot", "factory.yaml");
  if (fs.existsSync(existing)) throw new Error("A factory definition already exists. Edit it in git, then run tb factory check.");
  const started = initFactoryTree(root, name);
  for (const file of started.files) {
    const dest = path.join(root, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.contents);
  }
  return { created: true, path: ".tinkerbot", inspect: started.inspect, files: started.files.map((file) => file.path), next: "tb factory check && tb work new", requiresAi: false, packs: STARTER_FACTORY_PACKS.map((pack) => pack.id) };
}

export function factoryCheckPayload(root: string): Record<string, unknown> {
  const loaded = loadFactoryDefinition(root);
  const plan = compileFactoryPlan(loaded.definition, loaded.digest);
  const safe = factoryPlanSafe(plan);
  return { valid: loaded.digest.length > 0, compiled: true, safe, plan, path: loaded.path, upgradesVerdict: false };
}

/** Local, accountless admission through the same durable spine as the CLI. */
export function localWorkNewPayload(root: string, intent?: string): Record<string, unknown> {
  const loaded = loadFactoryDefinition(root);
  const plan = compileFactoryPlan(loaded.definition, loaded.digest);
  const text = intent?.trim() || "manual change";
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const order = pinWorkOrderPlan(createWorkOrder({
    factoryId: "local-factory",
    organizationId: "local",
    sourceType: "manual",
    sourceId: `local:${Date.now()}`,
    repositoryId: loaded.definition.repositories[0] ?? "local/local",
    policyVersion: plan.policyVersion,
    definitionVersion: plan.factoryVersion,
    definitionDigest: plan.digest,
    actor: "local-human",
    origin: "local",
    intent: text,
    lineId: mapLineId(text),
    requiredChecks: ["test-integrity", "change-impact"],
    waiver: emptyWaiver(),
    acceptanceCriteriaChain: text ? [linkAcceptanceCriterion(text, "repository")] : [],
  }), plan);
  store.admitWorkOrderSync(order);
  return { created: true, workOrderId: order.workOrderId, lineId: order.lineId, verificationVerdict: order.verificationVerdict, reviewAssessment: order.reviewAssessment, releaseDecision: order.releaseDecision, requiresAi: false, pinnedPlan: plan.digest };
}

/** Local, accountless intake. Hosted sync may later mirror this canonical intent event. */
export function localIntentPayload(root: string, text?: string, mode: "micro" | "standard" | "strategic" = "micro"): Record<string, unknown> {
  const title = text?.trim();
  if (!title) throw new Error("intent requires a description");
  const objectiveId = mode === "micro" ? undefined : factoryId("objective");
  const intent = {
    ...createMicroIntent(title),
    mode,
    ...(objectiveId ? {
      objectiveId,
      acceptanceCriteria: [`${title} is complete`],
      nonGoals: ["No unrelated repository changes"],
      risk: mode === "strategic" ? "high" as const : "medium" as const,
      expectedOutcome: `The change achieves the requested result: ${title}`,
      ...(mode === "strategic" ? {
        baselineMetric: "baseline to be recorded before release",
        targetMetric: "measurable improvement against baseline",
        measurementWindow: "14d",
        decisionOwner: "local-human",
        killCriteria: ["No measurable improvement after the measurement window"],
      } : {}),
    } : {}),
  };
  const missing = validateIntent(intent);
  if (missing.length) throw new Error(`invalid ${mode} intent: ${missing.join(", ")}`);
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  if (objectiveId) store.appendFactoryEventSync({ eventId: `evt_${objectiveId}`, type: "objective.created", aggregateId: objectiveId, aggregateType: "objective", organizationId: "local", factoryId: "local-factory", actorId: "local-human", actorType: "human", occurredAt: new Date().toISOString(), correlationId: intent.intentId, schemaVersion: 1, provenance: "HUMAN_VERIFIED", payload: { objectiveId, title } });
  store.appendFactoryEventSync({ eventId: `evt_${intent.intentId}`, type: "intent.created", aggregateId: intent.intentId, aggregateType: "intent", organizationId: "local", factoryId: "local-factory", actorId: "local-human", actorType: "human", occurredAt: new Date().toISOString(), correlationId: intent.intentId, schemaVersion: 1, provenance: "HUMAN_VERIFIED", payload: { intent } });
  return { created: true, intent, mode, next: "tb work new \"<implementation task>\"", requiresHostedAccount: false, persisted: true };
}

export function localFactoryGraphStatusPayload(root: string, aggregateId?: string): Record<string, unknown> {
  if (!aggregateId) throw new Error("factory status requires a work-order or aggregate identifier");
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const events = store.readFactoryEvents(aggregateId);
  return { aggregateId, events, state: projectFactoryEvents(events), economics: calculateFactoryEconomics(events), sourceOfTruth: "append_only_factory_graph" };
}

export function localWorkApprovalPayload(root: string, workOrderId?: string, decision: "approved" | "rejected" = "approved"): Record<string, unknown> {
  if (!workOrderId) throw new Error("work approve requires a work-order identifier");
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const order = store.orders.get(workOrderId);
  if (!order) throw new Error("work order not found");
  const now = new Date().toISOString();
  const payload = { changeSetId: workOrderId, changeSetDigest: order.definitionDigest, scope: "SPEC" as const, outcome: decision === "approved" ? "GRANTED" as const : "DENIED" as const, approverId: "local-human", rationale: decision, workOrderId };
  const eventId = `approval_${workOrderId}_${decision}_local-human`;
  const event = createApprovalRecordedEvent({ eventId, aggregateId: workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId: order.factoryId, actorId: "local-human", actorType: "human", occurredAt: now, correlationId: workOrderId, policyVersion: order.policyVersion, provenance: "HUMAN_VERIFIED", workOrderId, changeSetId: payload.changeSetId, changeSetDigest: payload.changeSetDigest, scope: payload.scope, outcome: payload.outcome, approverId: payload.approverId, rationale: payload.rationale });
  store.dispatchFactoryCommandSync({
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    workOrderId,
    actorId: "local-human",
    actorType: "human",
    idempotencyKey: `cli:${eventId}`,
    payload,
    now,
    buildEvents: () => [event],
  });
  const events = store.readFactoryEvents(workOrderId);
  return { workOrderId, decision, state: projectFactoryEvents(events), events, sourceOfTruth: "append_only_factory_graph" };
}

export function localOutcomePayload(root: string, workOrderId: string | undefined, status: OutcomeStatus, mature: boolean, details: Record<string, unknown> = {}): Record<string, unknown> {
  if (!workOrderId) throw new Error("outcome record requires --work-order");
  if (!["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"].includes(status)) throw new Error("outcome status must be POSITIVE, NEUTRAL, NEGATIVE, or UNKNOWN");
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const order = store.orders.get(workOrderId);
  if (!order) throw new Error("work order not found");
  const now = new Date().toISOString();
  store.appendFactoryEventSync({
    eventId: `outcome_${workOrderId}_${now}`, type: "outcome.observed", aggregateId: workOrderId, aggregateType: "work_order",
    organizationId: order.organizationId, factoryId: order.factoryId, actorId: "local-human", actorType: "human", occurredAt: now,
    correlationId: workOrderId, schemaVersion: 1, policyVersion: order.policyVersion, provenance: "HUMAN_VERIFIED", payload: { ...details, status, mature },
  });
  if (mature) store.appendFactoryEventSync({
    eventId: `outcome_matured_${workOrderId}_${now}`, type: "outcome.matured", aggregateId: workOrderId, aggregateType: "work_order",
    organizationId: order.organizationId, factoryId: order.factoryId, actorId: "local-human", actorType: "human", occurredAt: now,
    correlationId: workOrderId, schemaVersion: 1, policyVersion: order.policyVersion, provenance: "HUMAN_VERIFIED", payload: { closed: true },
  });
  const events = store.readFactoryEvents(workOrderId);
  return { workOrderId, outcome: { status, mature }, state: projectFactoryEvents(events), economics: calculateFactoryEconomics(events), events, sourceOfTruth: "append_only_factory_graph" };
}
