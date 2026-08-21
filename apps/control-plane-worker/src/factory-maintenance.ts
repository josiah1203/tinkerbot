import { scheduledMaintenanceTask } from "../../../packages/factory/src";
import { D1FactoryStore } from "./factory-store";
import { routeFactoryQueueMessage, type FactoryEnv } from "./factory-runtime";

/**
 * Scheduled Factory OS maintenance is kept outside the runtime coordinator.
 * It only expires cells and emits queue-shaped maintenance work; lifecycle
 * authority remains in the Foreman/Factory command path.
 */
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
    // Scheduled maintenance is another queue-shaped delivery. Route it
    // through the same coordinator as external queue/workflow messages so a
    // cron tick cannot race an operator/MCP delivery for the same aggregate.
    await routeFactoryQueueMessage(env, {
      deliveryId: task.sourceId,
      factoryId: factory.factoryId,
      organizationId: record?.organizationId ?? "system",
      sourceType: "scheduled",
      sourceId: task.sourceId,
      issueOrPullRequest: `${task.title}\n${task.body}`,
      actor: task.actor,
      repository: "unknown/unknown",
    });
    maintenance += 1;
  }
  return { abandonedCells: expired.length, maintenance };
}
