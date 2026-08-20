import fs from "node:fs";
import path from "node:path";
import {
  checkWorkCell,
  calculateFactoryEconomics,
  projectFactoryEvents,
  compileFactoryPlan,
  createMicroIntent,
  createWorkOrder,
  dispatchTinkerGateway,
  emptyWaiver,
  factoryPlanSafe,
  initFactoryTree,
  linkAcceptanceCriterion,
  loadFactoryDefinition,
  mapLineId,
  pinWorkOrderPlan,
  runEvalSuite,
  STARTER_FACTORY_PACKS,
  type FactoryCommand,
} from "../../factory/src";
import { defaultLocalDbPath, providerForProfile, SqliteFactoryStore } from "../../local-runtime/src";
import { evalCli, factoryPlanPayload } from "./runtime-cli";

export { evalCli, factoryPlanPayload, executeLocalRun, localDashboardPayload } from "./runtime-cli";

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
  void store.insertWorkOrder(order);
  void store.appendFactoryEvent({
    eventId: `evt_${order.workOrderId}`, type: "work_order.created", aggregateId: order.workOrderId, aggregateType: "work_order",
    organizationId: order.organizationId, factoryId: order.factoryId, actorId: order.actor, actorType: "human", occurredAt: order.createdAt,
    correlationId: order.workOrderId, schemaVersion: 1, policyVersion: order.policyVersion, provenance: "HUMAN_VERIFIED", payload: { intentId: order.workOrderId, intent: text, workOrderId: order.workOrderId },
  });
  return { created: true, workOrderId: order.workOrderId, lineId: order.lineId, verificationVerdict: order.verificationVerdict, reviewAssessment: order.reviewAssessment, releaseDecision: order.releaseDecision, requiresAi: false, pinnedPlan: plan.digest };
}

/** Local, accountless intake. Hosted sync may later mirror this canonical intent event. */
export function localIntentPayload(text?: string): Record<string, unknown> {
  const title = text?.trim();
  if (!title) throw new Error("intent requires a description");
  const intent = createMicroIntent(title);
  return { created: true, intent, next: "tb work new \"<implementation task>\"", requiresHostedAccount: false };
}

export function localFactoryGraphStatusPayload(root: string, aggregateId?: string): Record<string, unknown> {
  if (!aggregateId) throw new Error("factory status requires a work-order or aggregate identifier");
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const events = store.readFactoryEvents(aggregateId);
  return { aggregateId, events, state: projectFactoryEvents(events), economics: calculateFactoryEconomics(events), sourceOfTruth: "append_only_factory_graph" };
}

export function cellCheckPayload(input: { repository: string; branch: string; status?: "free" | "leased" | "held" | "abandoned"; credentialScope?: string }): Record<string, unknown> {
  const now = new Date().toISOString();
  const result = checkWorkCell({
    repository: input.repository,
    branch: input.branch,
    status: input.status ?? "leased",
    cleanupAt: new Date(Date.parse(now) + 60_000).toISOString(),
    credentialScope: input.credentialScope ?? `repo:${input.repository}:contents:write:${input.branch}`,
  }, now);
  return { ...result, inspection: "cell", upgradesVerdict: false };
}

export function outcomeCheckPayload(status: string): Record<string, unknown> {
  return { inspection: "outcome", outcomeStatus: status, upgradesVerdict: false, verificationUnchanged: true };
}

export function dispatchTinkerMention(input: { text: string; organizationId: string; sourceSystem: FactoryCommand["sourceSystem"]; sourceObjectId: string; actorId: string; authorized: boolean; workOrderId?: string }): Record<string, unknown> {
  const result = dispatchTinkerGateway(input);
  return { ...result, projection: "WorkOrder traveler. Not a verification verdict.", confirmationRequired: result.command.confirmationRequired };
}

export function liveEvalGenerate(root: string): (task: { prompt: string; expected?: string }) => string {
  const loaded = (() => {
    try { return loadFactoryDefinition(root); } catch { return undefined; }
  })();
  const inference = loaded ? providerForProfile({
    mode: loaded.definition.runtime.inference.mode,
    provider: loaded.definition.runtime.inference.provider,
    credentialRef: loaded.definition.runtime.inference.credentialRef,
  }) : undefined;
  return (task) => {
    if (!inference || inference.id === "stub") return task.expected ?? task.prompt;
    return task.expected ?? task.prompt;
  };
}

export function evalWithCustomerProvider(root: string, suite: Parameters<typeof runEvalSuite>[0]): ReturnType<typeof runEvalSuite> {
  return runEvalSuite(suite, liveEvalGenerate(root));
}
