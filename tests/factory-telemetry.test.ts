import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFactoryOperationalSignal, createWorkOrder, isFactoryOperationalSignal, parseFactoryTelemetryRetentionDays } from "../packages/factory/src";
import { SqliteFactoryStore } from "../packages/local-runtime/src";
import { D1FactoryStore } from "../apps/control-plane-worker/src/factory-store";
import type { D1DatabaseLike } from "../packages/hosted-integrations/src";

test("operational signals are typed, bounded, and payload-free", () => {
  const signal = createFactoryOperationalSignal({
    signal: "queue_delivery",
    outcome: "completed",
    correlationId: "wo_telemetry:delivery_1",
    createdAt: "2030-01-01T00:00:00.000Z",
    dimensions: { checked: 1, retryable: false },
  });

  expect(isFactoryOperationalSignal(signal)).toBe(true);
  expect(parseFactoryTelemetryRetentionDays("30")).toBe(30);
  expect(parseFactoryTelemetryRetentionDays(0)).toBeNull();
  expect(parseFactoryTelemetryRetentionDays(3_651)).toBeNull();
  expect(() => createFactoryOperationalSignal({ ...signal, dimensions: { prompt: "not allowed" } })).toThrow("factory_operational_signal_dimensions_invalid");
  expect(() => createFactoryOperationalSignal({ ...signal, dimensions: { value: Number.POSITIVE_INFINITY } })).toThrow("factory_operational_signal_dimensions_invalid");
  expect(() => createFactoryOperationalSignal({ ...signal, signal: "unknown" as never })).toThrow();
  expect(isFactoryOperationalSignal({ ...signal, signal: "unknown" })).toBe(false);
  expect(isFactoryOperationalSignal({ ...signal, dimensions: { prompt: "not allowed" } })).toBe(false);
});

test("SQLite persists command telemetry and retention cleanup leaves lifecycle state intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-telemetry-"));
  const store = new SqliteFactoryStore(path.join(dir, "local.db"));
  const order = createWorkOrder({
    factoryId: "fac_telemetry",
    organizationId: "org_telemetry",
    sourceType: "manual",
    sourceId: "telemetry",
    repositoryId: "acme/telemetry",
    policyVersion: "v1",
    definitionVersion: "v1",
    definitionDigest: "sha256:definition",
    actor: "human",
    workOrderId: "wo_telemetry",
  });

  await store.admitWorkOrder(order);
  expect(store.commandTelemetryCount()).toBeGreaterThan(0);
  expect(await store.listFactoryEvents(order.workOrderId)).toHaveLength(1);
  expect(await store.getFactoryCommandReceipt(order.organizationId, order.workOrderId, `admission:${order.workOrderId}`)).not.toBeNull();

  const removed = store.pruneCommandTelemetry(1, "2030-02-02T00:00:00.000Z");
  expect(removed).toBeGreaterThan(0);
  expect(store.commandTelemetryCount()).toBe(0);
  expect(await store.listFactoryEvents(order.workOrderId)).toHaveLength(1);
  expect(await store.getWorkOrder(order.workOrderId)).toMatchObject({ workOrderId: order.workOrderId, status: order.status });
  expect(await store.getFactoryCommandReceipt(order.organizationId, order.workOrderId, `admission:${order.workOrderId}`)).not.toBeNull();
  expect(() => store.pruneCommandTelemetry(0)).toThrow("factory_telemetry_retention_invalid");
});

test("D1 persists bounded operational signals and cleans only telemetry ledgers", async () => {
  const queries: string[] = [];
  let insertArgs: unknown[] = [];
  const database = {
    prepare(query: string) {
      queries.push(query);
      return {
        bind(...args: unknown[]) {
          if (query.startsWith("INSERT INTO tinkerbot_factory_operational_telemetry")) insertArgs = args;
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      };
    },
  } as unknown as D1DatabaseLike;
  const store = new D1FactoryStore(database);
  const signal = createFactoryOperationalSignal({
    signal: "self_hosted_completion",
    outcome: "completed",
    correlationId: "wo_telemetry:dispatch_1",
    organizationId: "org_telemetry",
    workOrderId: "wo_telemetry",
    createdAt: "2030-01-01T00:00:00.000Z",
    dimensions: { provider: "github_actions", exitCode: 0 },
  });

  await store.persistOperationalSignal(signal);
  const deleted = await store.pruneTelemetry(30, "2030-02-02T00:00:00.000Z");
  expect(deleted).toEqual({ commandDeleted: 1, operationalDeleted: 1 });
  expect(queries[0]).toContain("tinkerbot_factory_operational_telemetry");
  expect(queries.some((query) => query.includes("DELETE FROM tinkerbot_factory_operational_telemetry"))).toBe(true);
  expect(JSON.parse(String(insertArgs[11]))).toEqual({ provider: "github_actions", exitCode: 0 });
  expect(JSON.stringify(insertArgs)).not.toContain("payload");
});
