import crypto from "node:crypto";
import { createWorkOrder, executeFactoryRun, factoryDefinitionDigest, isExternalHarness, isFactoryCommandBoundaryEventType, signRecord, type FactoryDefinition, type FactoryEvent, type FactorySourceType } from "../../factory/src";
import { LOCAL_ORGANIZATION_ID, mergeRuntimeProfile, soloRuntimeOverlay, type RuntimeProfile } from "../../factory/src/runtime";
import { factoryAiFromProvider, type InferenceProvider } from "../../factory/src/inference";
import { SqliteFactoryStore } from "./sqlite-store";
import { stubSandboxPort, type SandboxPort } from "./sandbox";
import { assertNoSecretInPayload, resolveCredentialRef } from "./credentials";
import { replayOutbox } from "./outbox";
import { runExternalHarness } from "./harness";

export interface LocalRunInput {
  definition: FactoryDefinition;
  root: string;
  store: SqliteFactoryStore;
  sourceType?: FactorySourceType;
  untrustedText?: string;
  profileOverlay?: Partial<RuntimeProfile>;
  inference?: InferenceProvider;
  sandbox?: SandboxPort;
  actor?: string;
  verificationVerdict?: string;
  verificationIngested?: boolean;
  specApproved?: boolean;
  /** Set only when an implementation worker actually completed and produced its branch/PR. */
  sandboxComplete?: boolean;
  postSync?: (kind: string, payload: Record<string, unknown>) => Promise<{ ok: boolean }>;
  /** External harnesses are customer code execution and must be explicitly opted in. */
  allowExternalHarness?: boolean;
  /** Optional env:/keychain:// reference for a local receipt HMAC key. */
  receiptSigningKeyRef?: string;
}

export async function runLocalFactory(input: LocalRunInput): Promise<{ workOrderId: string; runId: string; terminal: string; planId?: string; stages: Array<{ stage: string; status: string; summary: string }>; cost?: unknown }> {
  const definition: FactoryDefinition = {
    ...input.definition,
    runtime: mergeRuntimeProfile(input.definition.runtime, input.profileOverlay),
  };
  if (definition.runtime.inference.mode === "byok" && definition.runtime.controlPlane === "hosted"
    && !(definition.runtime.runner.type === "self_hosted" && definition.runtime.workerHost?.startsWith("self_hosted"))) {
    throw new Error("BYOK on a hosted control plane requires a self_hosted runner with workerHost=self_hosted[:worker-id].");
  }
  const configuredImplementation = definition.agents.find((agent) => agent.agentType === "IMPLEMENT" || agent.id === "implement" || agent.id === "implementation");
  const configuredExternalHarness = configuredImplementation && isExternalHarness(configuredImplementation.harness) ? definition.harnesses[configuredImplementation.harness] : undefined;
  if (configuredExternalHarness && !input.allowExternalHarness) throw new Error(`External harness '${configuredExternalHarness.id}' requires allowExternalHarness=true; customer code execution is opt-in.`);
  const now = new Date().toISOString();
  const factoryId = "local-factory";
  const order = createWorkOrder({
    factoryId,
    organizationId: LOCAL_ORGANIZATION_ID,
    sourceType: input.sourceType ?? "manual",
    sourceId: `local:${crypto.randomUUID()}`,
    repositoryId: definition.repositories[0] ?? "local/local",
    policyVersion: "default",
    definitionVersion: "local",
    definitionDigest: factoryDefinitionDigest(definition),
    actor: input.actor ?? "local-human",
    origin: "local",
    now,
  });
  await input.store.admitWorkOrder(order);
  const runId = crypto.randomUUID();
  await input.store.insertRun({ runId, workOrderId: order.workOrderId, factoryId, definitionDigest: order.definitionDigest, status: "running", now });
  const appendRunGraphEvent = async (type: FactoryEvent["type"], payload: Record<string, unknown>, actorId: string, actorType: FactoryEvent["actorType"] = "system"): Promise<void> => {
    const event: FactoryEvent = {
      eventId: `${runId}:${type}`, type, aggregateId: order.workOrderId, aggregateType: "work_order", organizationId: order.organizationId, factoryId,
      actorId, actorType, occurredAt: new Date().toISOString(), correlationId: runId, schemaVersion: 1, policyVersion: order.policyVersion, provenance: actorType === "human" ? "HUMAN_VERIFIED" : "ATTESTED", payload,
    };
    if (isFactoryCommandBoundaryEventType(type)) {
      await input.store.dispatchFactoryCommand({ organizationId: order.organizationId, factoryId, workOrderId: order.workOrderId, actorId, actorType, idempotencyKey: `run:${runId}:${type}`, payload, now: event.occurredAt, buildEvents: () => [event] });
      return;
    }
    await input.store.appendFactoryEvent(event);
  };
  await appendRunGraphEvent("worker.session_started", { sessionId: runId, workerId: "local-composite", workOrderId: order.workOrderId }, "local-composite", "agent");
  const inference = input.inference;
  const sandbox = input.sandbox ?? stubSandboxPort();
  const lease = await sandbox.start({ repositoryRoot: input.root, workOrderId: order.workOrderId, image: definition.runtime.runner.image });
  try {
    const implementationAgent = definition.agents.find((agent) => agent.agentType === "IMPLEMENT" || agent.id === "implement" || agent.id === "implementation");
    const externalHarness = implementationAgent && isExternalHarness(implementationAgent.harness) ? definition.harnesses[implementationAgent.harness] : undefined;
    let harnessSummary: string | undefined;
    let externalHarnessCompleted = false;
    if (externalHarness) {
      if (sandbox.kind === "stub") {
        const failureSummary = `Harness ${externalHarness.id} requires an isolated Docker or explicitly opted-in process runner; the stub sandbox cannot execute customer code.`;
        await input.store.insertStage(runId, "implementation", "blocked", failureSummary, now);
        await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: `harness-${externalHarness.id}`, terminal: "failed", harness: externalHarness.id }, `harness-${externalHarness.id}`, "agent");
        await input.store.applyTransition(order.workOrderId, "failed", `harness-sandbox:${externalHarness.id}:${runId}`, "local-harness");
        return { workOrderId: order.workOrderId, runId, terminal: "failed", stages: [{ stage: "implementation", status: "blocked", summary: failureSummary }] };
      }
      let harnessResult;
      try {
        harnessResult = await runExternalHarness({
          harness: externalHarness,
          worktree: lease.worktree,
          executionWorktree: sandbox.kind === "docker" ? "/work" : lease.worktree,
          repository: order.repositoryId,
          workOrderId: order.workOrderId,
          prompt: input.untrustedText ?? "Implement the requested change.",
          model: implementationAgent?.model,
          networkIsolation: sandbox.kind !== "process",
          exec: (argv, options) => sandbox.exec(lease.worktree, argv, options),
        });
      } catch {
        const failureSummary = `Harness ${externalHarness.id} could not start. No implementation or verification evidence was recorded.`;
        await input.store.insertStage(runId, "implementation", "blocked", failureSummary, now);
        await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: `harness-${externalHarness.id}`, terminal: "failed", harness: externalHarness.id }, `harness-${externalHarness.id}`, "agent");
        await input.store.applyTransition(order.workOrderId, "failed", `harness-start:${externalHarness.id}:${runId}`, "local-harness");
        return { workOrderId: order.workOrderId, runId, terminal: "failed", stages: [{ stage: "implementation", status: "blocked", summary: failureSummary }] };
      }
      harnessSummary = `Harness ${harnessResult.harnessId} exit=${harnessResult.exitCode}: ${harnessResult.summary}`;
      if (harnessResult.status !== "ok") {
        await input.store.insertStage(runId, "implementation", "blocked", harnessSummary, now);
        await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: `harness-${harnessResult.harnessId}`, terminal: "failed", requestDigest: harnessResult.requestDigest }, `harness-${harnessResult.harnessId}`, "agent");
        await input.store.applyTransition(order.workOrderId, "failed", `harness:${harnessResult.harnessId}:${runId}`, "local-harness");
        return { workOrderId: order.workOrderId, runId, terminal: "failed", stages: [{ stage: "implementation", status: "blocked", summary: harnessSummary }] };
      }
      externalHarnessCompleted = true;
    }
    const result = await executeFactoryRun({
      definition,
      sourceType: order.sourceType,
      untrustedText: input.untrustedText ?? "local run",
      ai: inference ? factoryAiFromProvider(inference) : undefined,
      inference,
      store: input.store,
      workOrderId: order.workOrderId,
      factoryId,
      specApproved: input.specApproved ?? definition.runtime.approval === "inline_self_review",
      actorKind: "human",
      sandboxComplete: input.sandboxComplete ?? externalHarnessCompleted,
      verificationVerdict: input.verificationVerdict ?? "UNKNOWN",
      verificationIngested: input.verificationIngested ?? Boolean(input.verificationVerdict && input.verificationVerdict !== "UNKNOWN"),
      organizationId: order.organizationId,
      changeSetId: order.workOrderId,
      changeSetDigest: order.definitionDigest,
      verificationRunId: runId,
    });
    if (harnessSummary) {
      const implementationStage = result.stages.find((stage) => stage.stage === "implementation");
      if (implementationStage) implementationStage.summary = `${harnessSummary} Tinkerbot did not treat external harness output as verification evidence.`.slice(0, 8_000);
    }
    for (const stage of result.stages) {
      await input.store.insertStage(runId, stage.stage, stage.status, stage.summary, now);
      if (inference && stage.summary) {
        const usage = inference.usage({ text: stage.summary });
        usage.stage = stage.stage;
        usage.runnerOrigin = "local";
        if (result.plan) await input.store.putCostActual({ planId: result.plan.planId, runId, usage, now });
      }
    }
    if (result.wait === "sandbox") {
      await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: "local-composite", terminal: "implementation", executionPending: true }, "local-composite", "agent");
      await input.store.applyTransition(order.workOrderId, "implementation", `local-sandbox-pending:${runId}`, "local-composite");
      return { workOrderId: order.workOrderId, runId, terminal: "implementation", planId: result.plan?.planId, stages: result.stages, cost: result.plan?.cost };
    }
    const receipt = {
      repository: order.repositoryId,
      agentIdentity: "local-composite",
      workflowId: runId,
      baseSha: "unknown",
      headSha: "unknown",
      model: definition.runtime.inference.model ?? "local",
      provider: definition.runtime.inference.provider ?? "stub",
      harness: implementationAgent?.harness ?? definition.runtime.runner.type,
      definitionHash: order.definitionDigest,
      inputRef: `work-order://${order.workOrderId}`,
      outputRef: `run://${runId}`,
      composite: true,
    };
    assertNoSecretInPayload(receipt);
    const signingKey = input.receiptSigningKeyRef ? resolveCredentialRef(input.receiptSigningKeyRef) : undefined;
    const signed = signingKey ? signRecord(receipt, signingKey, "local-factory-v1", now) : undefined;
    const receiptDigest = signed?.digest ?? `sha256:${crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
    const persistedReceipt = signed ? { ...receipt, integrity: { algorithm: signed.algorithm, digest: signed.digest, signed: true, signedAt: signed.signedAt, keyId: signed.keyId } } : { ...receipt, integrity: { algorithm: "sha256", digest: receiptDigest, signed: false } };
    await input.store.insertAgentReceipt({ runId, agentId: "composite", receipt: persistedReceipt, digest: receiptDigest, signed: Boolean(signed), now });
    await appendRunGraphEvent("worker.claim_emitted", { sessionId: runId, workerId: "local-composite", claimStatus: "ATTESTED", receiptDigest, signed: Boolean(signed) }, "local-composite", "agent");
    await appendRunGraphEvent("change.proposed", { workOrderId: order.workOrderId, sessionId: runId, changeRef: `run://${runId}`, changeSetId: order.workOrderId, changeSetDigest: order.definitionDigest, receiptDigest }, "local-composite", "agent");
    await appendRunGraphEvent("evidence.receipt_created", { sessionId: runId, receiptDigest, signed: Boolean(signed) }, "local-composite", "agent");
    await appendRunGraphEvent("worker.session_completed", { sessionId: runId, workerId: "local-composite", terminal: result.terminal }, "local-composite", "agent");
    if (definition.runtime.sync !== "offline") {
      await input.store.enqueueOutbox({
        eventId: crypto.randomUUID(),
        kind: "factory-run",
        payloadJson: JSON.stringify({
          origin: "local",
          runId,
          workOrderId: order.workOrderId,
          terminal: result.terminal,
          plan: result.plan,
          cost: result.plan?.cost,
          stages: result.stages,
        }),
        createdAt: now,
      });
      if (input.postSync && (definition.runtime.sync === "hosted" || definition.runtime.sync === "manual")) {
        await replayOutbox(input.store, input.postSync, now);
      }
    }
    await input.store.applyTransition(order.workOrderId, result.terminal, `local:${runId}`, "local-human");
    return { workOrderId: order.workOrderId, runId, terminal: result.terminal, planId: result.plan?.planId, stages: result.stages, cost: result.plan?.cost };
  } finally {
    await lease.cleanup();
  }
}
