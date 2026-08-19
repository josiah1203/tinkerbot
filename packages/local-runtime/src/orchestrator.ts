import crypto from "node:crypto";
import { createWorkOrder, executeFactoryRun, factoryDefinitionDigest, type FactoryDefinition, type FactorySourceType } from "../../factory/src";
import { LOCAL_ORGANIZATION_ID, mergeRuntimeProfile, soloRuntimeOverlay, type RuntimeProfile } from "../../factory/src/runtime";
import { factoryAiFromProvider, type InferenceProvider } from "../../factory/src/inference";
import { SqliteFactoryStore } from "./sqlite-store";
import { stubSandboxPort, type SandboxPort } from "./sandbox";
import { assertNoSecretInPayload } from "./credentials";
import { replayOutbox } from "./outbox";

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
  postSync?: (kind: string, payload: Record<string, unknown>) => Promise<{ ok: boolean }>;
}

export async function runLocalFactory(input: LocalRunInput): Promise<{ workOrderId: string; runId: string; terminal: string; planId?: string; stages: Array<{ stage: string; status: string; summary: string }>; cost?: unknown }> {
  const definition: FactoryDefinition = {
    ...input.definition,
    runtime: mergeRuntimeProfile(input.definition.runtime, input.profileOverlay),
  };
  if (definition.runtime.inference.mode === "byok" && definition.runtime.controlPlane === "hosted") {
    throw new Error("BYOK is local-runner-only.");
  }
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
  await input.store.insertWorkOrder(order);
  const runId = crypto.randomUUID();
  await input.store.insertRun({ runId, workOrderId: order.workOrderId, factoryId, definitionDigest: order.definitionDigest, status: "running", now });
  const inference = input.inference;
  const sandbox = input.sandbox ?? stubSandboxPort();
  const lease = await sandbox.start({ repositoryRoot: input.root, workOrderId: order.workOrderId, image: definition.runtime.runner.image });
  try {
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
      sandboxComplete: true,
      verificationVerdict: input.verificationVerdict ?? "UNKNOWN",
      verificationIngested: input.verificationIngested ?? Boolean(input.verificationVerdict && input.verificationVerdict !== "UNKNOWN"),
    });
    for (const stage of result.stages) {
      await input.store.insertStage(runId, stage.stage, stage.status, stage.summary, now);
      if (inference && stage.summary) {
        const usage = inference.usage({ text: stage.summary });
        usage.stage = stage.stage;
        usage.runnerOrigin = "local";
        if (result.plan) await input.store.putCostActual({ planId: result.plan.planId, runId, usage, now });
      }
    }
    const receipt = {
      repository: order.repositoryId,
      agentIdentity: "local-composite",
      workflowId: runId,
      baseSha: "unknown",
      headSha: "unknown",
      model: definition.runtime.inference.model ?? "local",
      provider: definition.runtime.inference.provider ?? "stub",
      harness: definition.runtime.runner.type,
      definitionHash: order.definitionDigest,
      inputRef: `work-order://${order.workOrderId}`,
      outputRef: `run://${runId}`,
      composite: true,
    };
    assertNoSecretInPayload(receipt);
    await input.store.insertAgentReceipt({ runId, agentId: "composite", receipt, digest: `sha256:${crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`, signed: true, now });
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
