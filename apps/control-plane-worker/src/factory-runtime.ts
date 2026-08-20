import { createAgentExecutionReceipt } from "../../../packages/assurance/src";
import { createImplementPullRequest, mintInstallationToken } from "../../../packages/github/src";
import {
  createWorkOrder,
  factoryDefinitionDigest,
  executeFactoryRun,
  applyFactoryTree,
  parseFactoryDefinition,
  validateFactoryDefinition,
  signRecord,
  canonicalize,
  createSelfHostedDispatch,
  selfHostedSecretReady,
  classifyWorkOrderGroup,
  conversationTranscript,
  createPullRequestBody,
  exhaustObjectKey,
  handleMcpJsonRpc,
  implementBranchName,
  jiraIntake,
  linearIntake,
  runImplementSandbox,
  sandboxImplementPlan,
  scoreConversation,
  selfImprovementTask,
  slackIntake,
  workersAiGatewayOptions,
  applyWorkOrderRouting,
  acquireWorkCellLease,
  dispatchTinkerGateway,
  draftImprovementProposal,
  factoryAnalystReport,
  isExternalHarness,
  sanitizeUntrustedPromptInput,
  incidentIntake,
  supportIntake,
  githubSecurityIntake,
  scheduledMaintenanceTask,
  createReleaseCandidate,
  recordDeployment,
  evaluateMergeReadiness,
  workersAiInferenceProvider,
  factoryAiFromProvider,
  defaultAftercare,
  classifyAiInvocation,
  INTELLIGENCE_STAGES,
  IN_PROGRESS_STATES,
  type ConversationMessage,
  type FactoryAi,
  type FactoryDefinition,
  type FactoryQueueMessage,
  type FactorySourceType,
  type FactoryEvent,
  type FactoryRunStepResult,
  FACTORY_STAGES,
} from "../../../packages/factory/src";
import { modelForCostClass, type AiCostClass } from "../../../packages/control-plane/src";
import { evidenceStoreFromEnv, HttpEvidenceReplica } from "../../../packages/hosted-integrations/src";
import { D1FactoryStore } from "./factory-store";
import { entitlementsForOrganization } from "./billing";

export interface FactoryEnv {
  ENVIRONMENT?: string;
  DB?: ConstructorParameters<typeof D1FactoryStore>[0];
  AI?: FactoryAi;
  AI_GATEWAY_ID?: string;
  EVIDENCE_BUCKET?: { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>; get(key: string): Promise<{ text(): Promise<string> } | null>; delete(key: string): Promise<void> };
  EVIDENCE_EXPORT_ENDPOINT?: string;
  EVIDENCE_EXPORT_TOKEN?: string;
  SESSION_ENCRYPTION_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  FOREMAN?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: Request): Promise<Response> } };
  FACTORY_RUN?: { create(options: { id: string; params: unknown }): Promise<unknown> };
  CONTROL_PLANE_URL?: string;
  BROWSER?: unknown;
  Sandbox?: unknown;
  /** Optional producer for customer-managed self-hosted workers. It never carries credentials. */
  SELF_HOSTED_WORK?: { send(body: unknown): Promise<void> };
  /** HTTPS bridge for a customer worker outside this Cloudflare account. The body remains HMAC-signed and credential-free. */
  SELF_HOSTED_WORK_ENDPOINT?: string;
  SELF_HOSTED_WORK_SECRET?: string;
}

function estimatedCostMinor(aiClass: AiCostClass, tokens: number): number {
  const perThousand = aiClass === "economy" ? 2 : aiClass === "premium" ? 20 : aiClass === "steward" ? 15 : 8;
  return Math.max(0, Math.ceil((Math.max(0, tokens) / 1000) * perThousand));
}

async function unsignedDigest(payload: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalize(payload));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function gatewayAi(env: FactoryEnv): FactoryAi | undefined {
  if (!env.AI) return undefined;
  return {
    run: async (model, input, options) => env.AI!.run(model, input, options ?? workersAiGatewayOptions({ stage: "factory" })),
  };
}

interface SelfHostedDispatchInput {
  organizationId: string;
  factoryId: string;
  workOrderId: string;
  runId: string;
  repository: string;
  sourceType: FactorySourceType;
  sourceId: string;
  definitionDigest: string;
  prompt?: string;
  definition: FactoryDefinition;
}

/**
 * Hand off implementation to a customer-owned worker without putting a
 * credential, session token, or provider secret on the queue. The worker can
 * fetch the repository itself and must return through the existing verification
 * / OIDC path; this message is only a dispatch claim, never a merge authority.
 */
async function dispatchSelfHostedWork(env: FactoryEnv, input: SelfHostedDispatchInput): Promise<{ ok: true; dispatchId: string } | { ok: false; dispatchId: string; reason: string }> {
  const dispatchId = `selfhost:${input.workOrderId}:${input.runId}`;
  if (!env.SELF_HOSTED_WORK && !env.SELF_HOSTED_WORK_ENDPOINT) return { ok: false, dispatchId, reason: "self_hosted_queue_not_configured" };
  // Do not reuse the session-encryption key in production. Development and
  // tests retain the fallback so the adapter stays easy to exercise, but a
  // deployed customer-worker boundary gets an independently rotatable HMAC
  // trust domain.
  const signingSecret = env.SELF_HOSTED_WORK_SECRET ?? (env.ENVIRONMENT === "production" ? undefined : env.SESSION_ENCRYPTION_KEY);
  if (!signingSecret || (env.ENVIRONMENT === "production" && !selfHostedSecretReady(signingSecret))) return { ok: false, dispatchId, reason: "self_hosted_signing_secret_not_configured" };
  const implementation = input.definition.agents.find((agent) => agent.agentType === "IMPLEMENT" || agent.id === "implement" || agent.id === "implementation");
  const externalHarness = implementation && isExternalHarness(implementation.harness) ? input.definition.harnesses[implementation.harness] : undefined;
  try {
    const envelope = createSelfHostedDispatch({
      dispatchId,
      executionBoundary: "self_hosted",
      organizationId: input.organizationId,
      factoryId: input.factoryId,
      workOrderId: input.workOrderId,
      runId: input.runId,
      repository: input.repository,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      definitionDigest: input.definitionDigest,
      harness: externalHarness?.id ?? implementation?.harness ?? "default",
      workerHost: input.definition.runtime.workerHost,
      model: implementation?.model,
      prompt: sanitizeUntrustedPromptInput(input.prompt ?? "Implement the approved change.", 16_000),
      secret: signingSecret,
    });
    if (env.SELF_HOSTED_WORK) {
      await env.SELF_HOSTED_WORK.send(envelope);
    } else {
      const endpoint = new URL(env.SELF_HOSTED_WORK_ENDPOINT!);
      const localEndpoint = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
      if (endpoint.protocol !== "https:" && !localEndpoint) throw new Error("Self-hosted worker endpoint must use HTTPS (HTTP is allowed only for localhost development).");
      if (endpoint.username || endpoint.password) throw new Error("Self-hosted worker endpoint must not embed credentials.");
      const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-tinkerbot-self-hosted-protocol": "1" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Self-hosted worker endpoint returned HTTP ${response.status}.`);
    }
    return { ok: true, dispatchId };
  } catch {
    return { ok: false, dispatchId, reason: "self_hosted_queue_send_failed" };
  }
}

export async function persistTranscript(env: FactoryEnv, organizationId: string, workOrderId: string, messages: ConversationMessage[]): Promise<void> {
  if (!env.EVIDENCE_BUCKET || !env.DB) return;
  const key = exhaustObjectKey(organizationId, workOrderId, "transcript");
  const payload = conversationTranscript(messages);
  await env.EVIDENCE_BUCKET.put(key, JSON.stringify(payload), { httpMetadata: { contentType: "application/json" } });
  if (env.EVIDENCE_EXPORT_ENDPOINT) {
    try { await new HttpEvidenceReplica(env.EVIDENCE_EXPORT_ENDPOINT, env.EVIDENCE_EXPORT_TOKEN).put(key, payload); } catch { /* export cannot set a verdict */ }
  }
  await new D1FactoryStore(env.DB).putConversation({ workOrderId, agentId: "foreman", r2Key: key, now: new Date().toISOString() });
}

export async function runFactoryTurn(env: FactoryEnv, message: FactoryQueueMessage & { factoryId?: string; specApproved?: boolean; sandboxComplete?: boolean; pullRequestSha?: string; verificationVerdict?: string; verificationIngested?: boolean; workOrderId?: string }): Promise<{ workOrderId: string; runId: string; wait?: string; terminal: string }> {
  if (!env.DB) return { workOrderId: message.sourceId, runId: "none", terminal: "unknown" };
  const factories = new D1FactoryStore(env.DB);
  const installation = message.installationId ? await env.DB.prepare("SELECT organization_id, status FROM tinkerbot_github_installations WHERE installation_id = ?1").bind(message.installationId).first<{ organization_id?: string | null; status?: string }>() : null;
  if (installation && installation.status && installation.status !== "active") return { workOrderId: message.sourceId, runId: "none", terminal: "blocked" };
  if (installation?.organization_id && message.organizationId && installation.organization_id !== message.organizationId) return { workOrderId: message.sourceId, runId: "none", terminal: "blocked" };
  if (message.installationId && message.repository) {
    const repositoryBinding = await env.DB.prepare("SELECT installation_id FROM tinkerbot_github_repositories WHERE lower(full_name) = lower(?1) AND installation_id = ?2 LIMIT 1").bind(message.repository, message.installationId).first<{ installation_id?: number | string }>();
    if (!repositoryBinding) return { workOrderId: message.sourceId, runId: "none", terminal: "blocked" };
  }
  const organizationId = message.organizationId ?? installation?.organization_id;
  if (!organizationId) return { workOrderId: message.sourceId, runId: "none", terminal: "unknown" };
  const listed = await factories.listFactories(organizationId);
  const existingOrder = message.workOrderId ? await factories.getWorkOrderForOrganization(message.workOrderId, organizationId) : null;
  if (message.workOrderId && !existingOrder) return { workOrderId: message.workOrderId, runId: "none", terminal: "unknown" };
  const factory = listed.find((item) => item.factoryId === (existingOrder?.factoryId ?? message.factoryId)) ?? (existingOrder ? undefined : listed[0]);
  if (!factory) return { workOrderId: message.sourceId, runId: "none", terminal: "unknown" };
  const record = await factories.getFactory(factory.factoryId);
  const now = new Date().toISOString();
  // Never substitute a developer-owned repository when an integration or
  // operator omitted the repository. A missing binding may still produce an
  // intake record, but implementation must stop before any runner is opened.
  const repository = message.repository && message.repository !== "unknown/unknown" ? message.repository : "unknown/unknown";
  let order = existingOrder;
  if (!order) {
    order = createWorkOrder({ factoryId: factory.factoryId, organizationId, sourceType: message.sourceType as FactorySourceType, sourceId: message.sourceId, repositoryId: repository, issueOrPullRequest: message.issueOrPullRequest, policyVersion: "default", definitionVersion: record?.definitionDigest ?? "unknown", definitionDigest: record?.definitionDigest ?? "unknown", actor: message.actor, now });
    await factories.insertWorkOrder(order);
  }
  const persistedOrder = order;
  const existingRun = await factories.getRunByWorkOrder(persistedOrder.workOrderId);
  const runId = existingRun?.run_id ?? crypto.randomUUID();
  if (!existingRun) await factories.insertRun({ runId, workOrderId: persistedOrder.workOrderId, factoryId: factory.factoryId, definitionDigest: persistedOrder.definitionDigest, status: "running", now });
  // Queue delivery is at-least-once. Once a self-hosted handoff has been
  // durably marked as waiting, a redelivery must not invoke the customer CLI
  // a second time. The signed completion path deliberately opts back in with
  // sandboxComplete=true.
  if (existingRun?.status === "waiting:self_hosted_harness" && !message.sandboxComplete) {
    return { workOrderId: persistedOrder.workOrderId, runId, wait: "self_hosted_harness", terminal: "implementation" };
  }
  const updateRunStatus = async (status: string): Promise<void> => { await factories.updateRun(runId, status, new Date().toISOString()); };
  const appendRunGraphEvent = async (type: FactoryEvent["type"], payload: Record<string, unknown>, actorId: string, actorType: FactoryEvent["actorType"] = "system"): Promise<void> => {
    await factories.appendFactoryEvent({
      eventId: `${runId}:${type}`, type, aggregateId: persistedOrder.workOrderId, aggregateType: "work_order", organizationId, factoryId: factory.factoryId,
      actorId, actorType, occurredAt: new Date().toISOString(), correlationId: runId, schemaVersion: 1, policyVersion: persistedOrder.policyVersion, provenance: actorType === "human" ? "HUMAN_VERIFIED" : "ATTESTED", payload,
    });
  };
  await appendRunGraphEvent("worker.session_started", { sessionId: runId, workerId: "factory-foreman", workOrderId: persistedOrder.workOrderId }, "factory-foreman", "agent");
  const calculated = await entitlementsForOrganization(env.DB, organizationId);
  let definition: FactoryDefinition;
  try {
    const latest = await factories.getLatestDefinition(factory.factoryId);
    if (latest) {
      definition = parseFactoryDefinition(latest.yaml);
      if (latest.files.length) definition = applyFactoryTree(definition, latest.files);
    } else {
      definition = parseFactoryDefinition({ version: 1, name: factory.name, repositories: [repository], sources: [{ type: message.sourceType }, { type: "mcp" }, { type: "incident" }, { type: "scheduled" }] });
    }
    if (!definition.sources.some((source) => source.type === message.sourceType)) {
      definition = { ...definition, sources: [...definition.sources, { type: message.sourceType, enabled: true }] };
    }
    const definitionErrors = validateFactoryDefinition(definition, { requireForeman: definition.schemaVersion === "v1alpha1" || definition.agents.some((agent) => agent.agentType === "FOREMAN") });
    if (definitionErrors.length) {
      await appendRunGraphEvent("task.blocked", { reason: "invalid_factory_definition", errors: definitionErrors.slice(0, 20) }, "factory-policy", "system");
      await factories.applyTransition(order.workOrderId, "blocked", `definition:${message.deliveryId}`, "factory-policy");
      await updateRunStatus("blocked");
      return { workOrderId: order.workOrderId, runId, wait: "factory_definition", terminal: "blocked" };
    }
  } catch {
    await appendRunGraphEvent("task.blocked", { reason: "invalid_factory_definition" }, "factory-policy", "system");
    await factories.applyTransition(order.workOrderId, "blocked", `definition-parse:${message.deliveryId}`, "factory-policy");
    await updateRunStatus("blocked");
    return { workOrderId: order.workOrderId, runId, wait: "factory_definition", terminal: "blocked" };
  }
  const effectiveDefinitionDigest = factoryDefinitionDigest(definition);
  if (existingRun?.definition_digest !== effectiveDefinitionDigest) await factories.updateRunDefinition(runId, effectiveDefinitionDigest, now);
  if (persistedOrder.definitionDigest !== effectiveDefinitionDigest) await factories.updateWorkOrderDefinition(persistedOrder.workOrderId, effectiveDefinitionDigest, now);
  // A queue delivery can be retried after the worker has already persisted
  // stage rows. Rehydrate only an active run so approvals and self-hosted
  // completions resume the same durable state; terminal retries remain free to
  // create fresh work instead of silently treating a failed stage as complete.
  const resumableRun = Boolean(existingRun && (existingRun.status === "running" || existingRun.status.startsWith("waiting:")));
  const persistedStages = resumableRun ? await factories.listRunStages(runId) : [];
  const allowedStageStatuses = new Set(["ok", "skipped", "unknown", "blocked"]);
  const priorStages: FactoryRunStepResult[] = [];
  for (const row of persistedStages) {
    if (!FACTORY_STAGES.includes(row.stage as typeof FACTORY_STAGES[number]) || !allowedStageStatuses.has(row.status) || priorStages.some((stage) => stage.stage === row.stage)) continue;
    priorStages.push({ stage: row.stage as FactoryRunStepResult["stage"], status: row.status as FactoryRunStepResult["status"], summary: typeof row.summary === "string" ? row.summary : "" });
  }
  const priorStageIds = new Set(priorStages.map((stage) => stage.stage));
  const priorPlan = priorStages.length ? await factories.getExecutionPlanForWorkOrder(order.workOrderId) : null;
  const managed = definition.runtime.inference.mode === "managed";
  const implementationAgent = definition.agents.find((agent) => agent.agentType === "IMPLEMENT" || agent.id === "implement" || agent.id === "implementation");
  const externalImplementation = implementationAgent && isExternalHarness(implementationAgent.harness) ? definition.harnesses[implementationAgent.harness] : undefined;
  const requiresSelfHostedExecution = definition.runtime.runner.type === "self_hosted" || Boolean(externalImplementation);
  if (managed) definition = { ...definition, agents: definition.agents.map((agent) => ({ ...agent, model: modelForCostClass(calculated.aiClass, agent.id) })) };
  order = applyWorkOrderRouting(order, definition);
  await factories.patchWorkOrder(order.workOrderId, { productId: order.productId, lineId: order.lineId, autonomyMode: order.autonomyMode, outputKind: order.outputKind, risk: order.risk, now });
  const specApproved = message.specApproved ?? await factories.hasSpecApproval(order.workOrderId);
  // A hosted Worker may only invoke the managed provider. BYOK and local
  // inference belong to the customer-owned self-hosted boundary; falling back
  // to Workers AI here would silently bill/use the wrong provider and violate
  // the runtime profile declared in factory.yaml.
  const hostedAi = managed ? gatewayAi(env) : undefined;
  const inference = managed && hostedAi ? workersAiInferenceProvider(hostedAi, "hosted") : undefined;
  const result = await executeFactoryRun({
    definition,
    sourceType: message.sourceType as FactorySourceType,
    untrustedText: message.issueOrPullRequest,
    ai: inference ? factoryAiFromProvider(inference) : hostedAi,
    inference,
    verificationVerdict: message.verificationVerdict ?? "UNKNOWN",
    specApproved,
    sandboxComplete: message.sandboxComplete,
    pullRequestSha: message.pullRequestSha,
    verificationIngested: message.verificationIngested,
    workOrderId: order.workOrderId,
    factoryId: factory.factoryId,
    organizationId,
    store: factories,
    priorStages,
    priorPlan: priorPlan ?? undefined,
  });
  for (const stage of result.stages) {
    if (priorStageIds.has(stage.stage)) {
      if (message.sandboxComplete && stage.stage === "implementation") await factories.updateStage(runId, stage.stage, stage.status, stage.summary, now);
      continue;
    }
    const inserted = await factories.insertStage(runId, stage.stage, stage.status, stage.summary, now);
    if (inserted === false) continue;
    if (INTELLIGENCE_STAGES.has(stage.stage) || stage.stage === "security") {
      // A self-hosted/BYOK run can still return deterministic stage summaries
      // so the workflow remains inspectable, but the hosted Worker did not
      // invoke an AI provider for those stages.  Do not manufacture a
      // Workers AI receipt, usage event, or managed cost actual: doing so
      // would misattribute customer work and make a BYOK run look billable.
      if (!managed && !inference) continue;
      const classified = classifyAiInvocation({ stage: stage.stage, providerId: "workers-ai", mode: "managed" });
      const receipt = createAgentExecutionReceipt({
        repository,
        baseSha: message.sha ?? "unknown",
        headSha: message.sha ?? "unknown",
        agentIdentity: `factory-${stage.stage}`,
        workflowId: runId,
        declaredTask: stage.stage,
        sourceUpload: "not_uploaded",
        model: definition.agents.find((agent) => agent.id === stage.stage)?.model ?? modelForCostClass(calculated.aiClass, stage.stage),
        provider: "workers-ai",
        harness: "default",
        definitionHash: effectiveDefinitionDigest,
        inputRef: `work-order://${order.workOrderId}`,
        outputRef: `run-stage://${runId}/${stage.stage}`,
        verificationResult: message.verificationVerdict === "PASS" || message.verificationVerdict === "FAIL" ? message.verificationVerdict : "UNKNOWN",
      });
      const signed = env.SESSION_ENCRYPTION_KEY ? signRecord(receipt, env.SESSION_ENCRYPTION_KEY, "factory-v1", now) : undefined;
      const receiptDigest = signed?.digest ?? await unsignedDigest(receipt);
      const receiptSigned = Boolean(signed);
      await factories.insertAgentReceipt({ runId, agentId: stage.stage, receipt, digest: receiptDigest, signed: receiptSigned, now });
      await appendRunGraphEvent("worker.claim_emitted", { sessionId: runId, workerId: `factory-${stage.stage}`, claimStatus: "ATTESTED", receiptDigest, signed: receiptSigned, stage: stage.stage }, `factory-${stage.stage}`, "agent");
      await appendRunGraphEvent("evidence.receipt_created", { sessionId: runId, receiptDigest, signed: receiptSigned, stage: stage.stage }, `factory-${stage.stage}`, "agent");
      if (stage.stage === "implementation") await appendRunGraphEvent("change.proposed", { sessionId: runId, changeRef: `run-stage://${runId}/${stage.stage}`, receiptDigest }, `factory-${stage.stage}`, "agent");
      const tokens = Math.ceil(stage.summary.length / 4);
      const costCents = estimatedCostMinor(calculated.aiClass, tokens);
      await factories.insertUsage({ organizationId, factoryId: factory.factoryId, runId, kind: `agent:${stage.stage}`, tokens, costCents, now });
      await factories.insertAiCostEvent({ organizationId, factoryId: factory.factoryId, workOrderId: order.workOrderId, runId, stageId: stage.stage, agentId: stage.stage, modelId: definition.agents.find((agent) => agent.id === stage.stage)?.model ?? modelForCostClass(calculated.aiClass, stage.stage), tokens, costMinor: costCents, now, provider: classified.providerOwnership === "tinkerbot" ? "workers-ai" : "customer" });
      if (result.plan) {
        const usage = inference?.usage({ text: stage.summary }) ?? {
          provider: "workers-ai",
          model: definition.agents.find((agent) => agent.id === stage.stage)?.model ?? modelForCostClass(calculated.aiClass, stage.stage),
          inputTokens: tokens,
          outputTokens: 0,
          cachedTokens: 0,
          retries: 0,
          latencyMs: 0,
          managed: true,
          stage: stage.stage,
          catalogVersion: result.plan.cost.catalogVersion,
          runnerOrigin: "hosted" as const,
        };
        usage.stage = stage.stage;
        usage.runnerOrigin = "hosted";
        await factories.putCostActual({ planId: result.plan.planId, runId, usage, now });
      }
    }
  }
  await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: "factory-foreman", terminal: result.terminal }, "factory-foreman", "agent");
  const messages: ConversationMessage[] = result.stages.map((stage) => ({ role: "assistant", agentId: stage.stage, content: stage.summary, at: now }));
  await persistTranscript(env, organizationId, order.workOrderId, messages);
  if (result.wait === "sandbox") {
    if (repository === "unknown/unknown") {
      await appendRunGraphEvent("task.blocked", { reason: "repository_required" }, "factory-policy", "system");
      await factories.applyTransition(order.workOrderId, "blocked", `repository:${message.deliveryId}`, "factory-policy");
      await updateRunStatus("blocked");
      return { workOrderId: order.workOrderId, runId, wait: "sandbox", terminal: "blocked" };
    }
    if (requiresSelfHostedExecution) {
      const handoff = await dispatchSelfHostedWork(env, {
        organizationId,
        factoryId: factory.factoryId,
        workOrderId: order.workOrderId,
        runId,
        repository,
        sourceType: message.sourceType as FactorySourceType,
        sourceId: message.sourceId,
        definitionDigest: effectiveDefinitionDigest,
        prompt: message.issueOrPullRequest,
        definition,
      });
      if (handoff.ok) {
        await appendRunGraphEvent("task.queued", { executionBoundary: "self_hosted", dispatchId: handoff.dispatchId, harness: externalImplementation?.id ?? implementationAgent?.harness ?? "default" }, "factory-policy", "system");
        await factories.applyTransition(order.workOrderId, "implementation", `self-hosted:${handoff.dispatchId}`, "factory-policy");
        await updateRunStatus("waiting:self_hosted_harness");
        return { workOrderId: order.workOrderId, runId, wait: "self_hosted_harness", terminal: "implementation" };
      }
      await appendRunGraphEvent("task.blocked", { executionBoundary: "self_hosted", reason: handoff.reason, dispatchId: handoff.dispatchId }, "factory-policy", "system");
      await factories.applyTransition(order.workOrderId, "blocked", `self-hosted:${handoff.dispatchId}`, "factory-policy");
      await updateRunStatus("blocked");
      return { workOrderId: order.workOrderId, runId, wait: "self_hosted_harness", terminal: "blocked" };
    }
    const cells = (await factories.listWorkCells(factory.factoryId)).map((row) => ({
      cellId: String(row.cell_id),
      factoryId: String(row.factory_id),
      workOrderId: row.work_order_id ?? undefined,
      kind: (row.kind ?? "sandbox") as "sandbox",
      repository: String(row.repository),
      branch: String(row.branch),
      status: (row.status ?? "free") as "leased",
      leasedBy: row.leased_by ?? undefined,
      heldBy: row.held_by ?? undefined,
      credentialScope: String(row.credential_scope ?? ""),
      cleanupAt: String(row.cleanup_at ?? now),
      createdAt: String(row.created_at ?? now),
    }));
    const inProgress = (await factories.listWorkOrders(organizationId)).filter((item) => IN_PROGRESS_STATES.includes(item.status)).length;
    const lease = acquireWorkCellLease({ cells, factoryId: factory.factoryId, workOrderId: order.workOrderId, repository, branch: implementBranchName(order.workOrderId), actor: "factory-agent", now, wipLimit: definition.wipLimit, inProgressCount: inProgress });
    if (!lease.ok) {
      await factories.applyTransition(order.workOrderId, "blocked", `cell:${lease.reason}:${message.deliveryId}`, "factory-workflow");
      await updateRunStatus("blocked");
      return { workOrderId: order.workOrderId, runId, wait: result.wait, terminal: "blocked" };
    }
    await factories.upsertWorkCell({ ...lease.cell, now, productionAccess: lease.cell.productionAccess, observability: lease.cell.observability, allowedTools: lease.cell.allowedTools });
    await factories.patchWorkOrder(order.workOrderId, { cellId: lease.cell.cellId, now });
    const sandbox = await dispatchSandboxIfBound(env, { workOrderId: order.workOrderId, repository, intent: message.issueOrPullRequest, installationId: message.installationId, organizationId, runId });
    if (sandbox.complete) {
      return runFactoryTurn(env, { ...message, workOrderId: order.workOrderId, factoryId: factory.factoryId, specApproved: true, sandboxComplete: true, pullRequestSha: sandbox.sha });
    }
  }
  if (result.wait === "human_merge" && message.verificationVerdict === "PASS") {
    const readiness = evaluateMergeReadiness({ verdict: message.verificationVerdict, approvals: specApproved ? 1 : 0, requiredApprovals: 1, evidenceFresh: true, unknowns: [], restricted: result.autonomyMode === "restricted" });
    if (readiness.ready) {
      const candidate = createReleaseCandidate({ releaseId: `rc_${order.workOrderId.slice(0, 8)}`, commitSha: message.pullRequestSha ?? message.sha ?? "unknown", receiptIds: [`receipt:${runId}`], rollbackRefs: ["docs/rollback"] });
      await factories.insertReleaseCandidate({ releaseId: candidate.releaseId, workOrderId: order.workOrderId, factoryId: factory.factoryId, commitSha: candidate.commitSha, receiptIds: candidate.receiptIds, rollbackRefs: candidate.rollbackRefs, status: candidate.status, blocking: candidate.blocking, now });
      await factories.insertAftercare(defaultAftercare(candidate.releaseId, order.owner ?? "unassigned"));
    }
  }
  if (env.EVIDENCE_BUCKET) {
    const evidence = evidenceStoreFromEnv({ bucket: env.EVIDENCE_BUCKET, exportEndpoint: env.EVIDENCE_EXPORT_ENDPOINT, exportToken: env.EVIDENCE_EXPORT_TOKEN });
    await evidence?.put(`${organizationId}/${runId}.json`, { runId, workOrderId: order.workOrderId, stages: result.stages, terminal: result.terminal, wait: result.wait, zdr: true, training: false, exportCannotSetVerdict: true });
    await factories.insertEvidence({ runId, kind: "factory-run", objectKey: `evidence/${organizationId}/${runId}.json`, digest: effectiveDefinitionDigest, signed: false, now });
  }
  await factories.applyTransition(order.workOrderId, result.terminal, message.deliveryId, "factory-workflow");
  await updateRunStatus(result.wait ? `waiting:${result.wait}` : result.terminal);
  if (result.terminal === "failed" || result.wait === "human_merge") {
    const scored = scoreConversation({ messages }, "did the agent wait for tb check before merge?");
    if (!scored.passed) {
      const task = selfImprovementTask({ factoryId: factory.factoryId, scorer: "tb-check-gate", failureReason: scored.reason, workOrderId: order.workOrderId });
      await factories.insertSelfImprovement({ factoryId: factory.factoryId, title: task.title, workOrderId: order.workOrderId, now });
      const analyst = factoryAnalystReport({ failures: [{ stage: "verification", reason: scored.reason }], rework: 1, costCents: 0 });
      const proposal = draftImprovementProposal({ factoryId: factory.factoryId, patterns: analyst.patterns.length ? analyst.patterns : [task.title] });
      await factories.insertProposal({ proposalId: `${proposal.proposalId}-${runId.slice(0, 6)}`, factoryId: factory.factoryId, title: proposal.title, evidence: proposal.evidence, proposedChanges: proposal.proposedChanges, expectedEffect: proposal.expectedEffect, kind: proposal.kind, stewardActor: "release-steward", now });
    }
  }
  return { workOrderId: order.workOrderId, runId, wait: result.wait, terminal: result.terminal };
}

/**
 * Route every queue-shaped delivery through the Foreman aggregate when the
 * Durable Object binding is available. Keeping this adapter beside the
 * runner lets cron maintenance use the exact same serialization boundary as
 * Queue and Workflow deliveries without importing the Worker entrypoint.
 */
export async function routeFactoryQueueMessage(env: FactoryEnv, message: FactoryQueueMessage & { factoryId?: string; specApproved?: boolean; sandboxComplete?: boolean; pullRequestSha?: string; verificationVerdict?: string; verificationIngested?: boolean; workOrderId?: string }): Promise<Awaited<ReturnType<typeof runFactoryTurn>>> {
  if (env.FOREMAN) {
    const scope = message.organizationId ?? (message.installationId ? `installation:${message.installationId}` : "unscoped");
    const aggregate = message.workOrderId ?? message.sourceId;
    const id = env.FOREMAN.idFromName(`${scope}:${aggregate}`);
    const response = await env.FOREMAN.get(id).fetch(new Request("https://tinkerbot.internal/foreman/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tinkerbot-internal": "foreman-v1" },
      body: JSON.stringify(message),
    }));
    if (!response.ok) throw new Error(`Foreman coordination failed with HTTP ${response.status}.`);
    const result = await response.json() as unknown;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Foreman coordination returned an invalid result.");
    return result as Awaited<ReturnType<typeof runFactoryTurn>>;
  }
  return runFactoryTurn(env, message);
}

async function dispatchSandboxIfBound(env: FactoryEnv, input: { workOrderId: string; repository: string; intent?: string; installationId?: number; organizationId: string; runId: string }): Promise<{ complete: boolean; sha?: string }> {
  const plan = sandboxImplementPlan({ repository: input.repository, workOrderId: input.workOrderId, intent: input.intent });
  if (!env.Sandbox || typeof env.Sandbox !== "object") return { complete: false };
  try {
    const token = env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && input.installationId
      ? await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: input.installationId })
      : undefined;
    const sandbox = env.Sandbox as { exec?(argv: string[], options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<{ output(): Promise<{ stdout: string; exitCode: number }> }> };
    if (typeof sandbox.exec !== "function") return { complete: false };
    const result = await runImplementSandbox({
      exec: async (argv, options) => {
        const handle = await sandbox.exec!(Array.from(argv), { cwd: options?.cwd, env: token ? { GIT_ASKPASS: "echo", GITHUB_TOKEN: token, ...options?.env } : options?.env, timeout: options?.timeout });
        const output = await handle.output();
        return { stdout: output.stdout, exitCode: output.exitCode };
      },
    }, plan, token ? { GITHUB_TOKEN: token } : {});
    if (result.status !== "ok" || !token) return { complete: false };
    const number = await createImplementPullRequest({ token, repository: input.repository }, {
      title: `tinkerbot: ${input.workOrderId.slice(0, 8)}`,
      head: plan.branch,
      body: createPullRequestBody({ workOrderId: input.workOrderId, dashboardUrl: `${env.CONTROL_PLANE_URL ?? ""}/app/work/${input.workOrderId}` }),
    });
    if (env.EVIDENCE_BUCKET) await env.EVIDENCE_BUCKET.put(exhaustObjectKey(input.organizationId, input.workOrderId, "sandbox-log"), JSON.stringify({ logs: result.logs, pull: number, branch: result.branch }), { httpMetadata: { contentType: "application/json" } });
    return { complete: result.status === "ok", sha: undefined };
  } catch {
    return { complete: false };
  }
}

export class Sandbox {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: "Attach the Cloudflare Sandbox implementation in this account." }), { status: 501, headers: { "content-type": "application/json" } });
  }
}

type BoundedJsonResult = { value: Record<string, unknown> } | { tooLarge: true };

async function boundedJsonObject(request: Request, maxBytes = 1_500_000): Promise<BoundedJsonResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { tooLarge: true };
  if (!request.body) return { value: {} };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* bounded request is already rejected */ }
        return { tooLarge: true };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { value: parsed as Record<string, unknown> } : { value: {} };
  } catch {
    return { value: {} };
  }
}

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

export async function handleFactoryMcpRequest(request: Request, env: FactoryEnv, actor: string, organizationId: string): Promise<Response> {
  const parsed = await boundedJsonObject(request);
  if ("tooLarge" in parsed) return Response.json({ error: "MCP request body is too large.", code: "payload_too_large" }, { status: 413 });
  const body = parsed.value;
  const factories = env.DB ? new D1FactoryStore(env.DB) : undefined;
  const rpc = await handleMcpJsonRpc(body, {
    organizationId,
    actor,
    sendTask: async (input) => {
      const listed = factories ? await factories.listFactories(organizationId) : [];
      const factoryId = input.factoryId ?? listed[0]?.factoryId;
      const repositoryId = input.repositoryId ?? "unknown/unknown";
      const result = await routeFactoryQueueMessage(env, {
        deliveryId: `mcp:${crypto.randomUUID()}`,
        organizationId,
        factoryId,
        repository: repositoryId,
        sourceType: "mcp",
        sourceId: `mcp:${crypto.randomUUID()}`,
        issueOrPullRequest: `${input.title}\n${input.note}`,
        actor,
      });
      return { workOrderId: result.workOrderId };
    },
    getTask: async (workOrderId) => {
      // MCP sessions are tenant-scoped. Never return a work order (or even a
      // usable git reference) solely because the caller knows its ID.
      const workOrder = factories ? await factories.getWorkOrderForOrganization(workOrderId, organizationId) : undefined;
      return {
        workOrder: workOrder ?? undefined,
        git: workOrder ? { branch: implementBranchName(workOrderId), commands: [`git fetch origin ${implementBranchName(workOrderId)}`] } : undefined,
      };
    },
    messageForeman: async (workOrderId, note) => {
      const order = factories ? await factories.getWorkOrderForOrganization(workOrderId, organizationId) : null;
      if (!order) return { accepted: false as const, reason: "work_order_not_found" };
      await routeFactoryQueueMessage(env, { deliveryId: `mcp-steer:${crypto.randomUUID()}`, organizationId, repository: order?.repositoryId, sourceType: "mcp", sourceId: workOrderId, workOrderId, issueOrPullRequest: note, actor });
      return { accepted: true as const };
    },
    createFactory: async (input) => {
      const factoryId = crypto.randomUUID();
      if (factories) await factories.putFactory({ factoryId, organizationId, name: input.name, yaml: input.yaml, files: input.files });
      return { factoryId };
    },
  });
  return Response.json(rpc);
}

export function intakeFromIntegration(kind: "slack" | "linear" | "jira" | "incident" | "support", payload: Record<string, unknown>): FactoryQueueMessage {
  if (kind === "slack") {
    const message = slackIntake(payload);
    const text = String(message.issueOrPullRequest ?? "");
    if (/@tinker(?:bot)?\b/i.test(text)) {
      dispatchTinkerGateway({
        text,
        organizationId: message.organizationId ?? "unknown",
        sourceSystem: "slack",
        sourceObjectId: message.sourceId,
        actorId: message.actor,
        authorized: true,
      });
    }
    return message;
  }
  if (kind === "linear") return linearIntake(payload);
  if (kind === "incident") {
    const incident = incidentIntake(payload);
    return { deliveryId: `incident:${incident.sourceId}`, sourceType: "incident", sourceId: incident.sourceId, issueOrPullRequest: `${incident.title}\n${incident.body}`, actor: incident.actor };
  }
  if (kind === "support") {
    const support = supportIntake(payload);
    return { deliveryId: `support:${support.sourceId}`, sourceType: "support", sourceId: support.sourceId, issueOrPullRequest: `${support.title}\n${support.body}`, actor: support.actor };
  }
  return jiraIntake(payload);
}

export async function sweepFactoryOs(env: FactoryEnv): Promise<{ abandonedCells: number; maintenance: number }> {
  if (!env.DB) return { abandonedCells: 0, maintenance: 0 };
  const factories = new D1FactoryStore(env.DB);
  const now = new Date().toISOString();
  const expired = await factories.listExpiredCells(now);
  for (const cell of expired) {
    await factories.upsertWorkCell({
      cellId: String(cell.cell_id),
      factoryId: String(cell.factory_id),
      workOrderId: cell.work_order_id ?? undefined,
      kind: String(cell.kind ?? "sandbox"),
      repository: String(cell.repository),
      branch: String(cell.branch),
      status: "abandoned",
      credentialScope: String(cell.credential_scope ?? ""),
      cleanupAt: now,
      now,
    });
  }
  let maintenance = 0;
  const listed = await factories.listFactories("system").catch(() => []);
  for (const factory of listed) {
    const task = scheduledMaintenanceTask(factory.factoryId, now);
    const record = await factories.getFactory(factory.factoryId);
    await handleFactoryQueueMessageLike(env, factory.factoryId, record?.organizationId ?? "system", task);
    maintenance += 1;
  }
  return { abandonedCells: expired.length, maintenance };
}

async function handleFactoryQueueMessageLike(env: FactoryEnv, factoryId: string, organizationId: string, task: ReturnType<typeof scheduledMaintenanceTask>): Promise<void> {
  // Scheduled maintenance is another queue-shaped delivery. Route it through
  // the same Foreman adapter as external queue/workflow messages so a cron
  // tick cannot race an operator/MCP delivery for the same factory aggregate.
  await routeFactoryQueueMessage(env, {
    deliveryId: task.sourceId,
    factoryId,
    organizationId,
    sourceType: "scheduled",
    sourceId: task.sourceId,
    issueOrPullRequest: `${task.title}\n${task.body}`,
    actor: task.actor,
    repository: "unknown/unknown",
  });
}

export { classifyWorkOrderGroup, githubSecurityIntake, recordDeployment, createReleaseCandidate };
