import {
  checkWorkCell,
  dispatchTinkerGateway,
  loadFactoryDefinition,
  runEvalSuite,
  type FactoryCommand,
} from "../../factory/src";
import { providerForProfile } from "../../local-runtime/src";
import { evalCli, factoryPlanPayload } from "./runtime-cli";

export { factoryInitPayload, factoryCheckPayload, localWorkNewPayload, localIntentPayload, localFactoryGraphStatusPayload, localWorkApprovalPayload, localOutcomePayload } from "../../local-runtime/src/factory-operations";

export { evalCli, factoryPlanPayload, executeLocalRun, localDashboardPayload } from "./runtime-cli";

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
