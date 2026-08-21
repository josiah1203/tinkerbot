import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  WORK_ORDER_TRANSITION_CONTRACT,
  createWorkOrder,
  MemoryFactoryStore,
  transitionWorkOrder,
  type WorkOrderState,
} from "../packages/factory/src";

test("the companion transition table matches the executable contract and every edge is fail-closed", async () => {
  const document = fs.readFileSync(path.resolve(process.cwd(), "docs/adr/0010-factory-lifecycle-transition-table.md"), "utf8");
  const snapshot = document.match(/<!-- factory-transition-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- factory-transition-contract:end -->/);
  expect(snapshot, "missing executable transition contract snapshot").not.toBeNull();
  expect(JSON.parse(snapshot![1]!)).toEqual(WORK_ORDER_TRANSITION_CONTRACT);

  const states = Object.keys(WORK_ORDER_TRANSITION_CONTRACT) as WorkOrderState[];
  for (const fromState of states) {
    for (const toState of states) {
      const store = new MemoryFactoryStore();
      const order = createWorkOrder({
        factoryId: "factory-transition-test",
        organizationId: "org-transition-test",
        sourceType: "manual",
        sourceId: `transition:${fromState}:${toState}`,
        repositoryId: "example/repo",
        policyVersion: "policy-v1",
        definitionVersion: "definition-v1",
        definitionDigest: "sha256:transition-test",
        actor: "foreman",
        workOrderId: `wo-transition-${fromState}-${toState}`,
      });
      order.status = fromState;
      await store.insertWorkOrder(order);
      const result = transitionWorkOrder(order, toState, `edge:${fromState}:${toState}`, "foreman", "2030-01-01T00:00:00.000Z");
      let commandResult: Awaited<ReturnType<typeof store.applyTransition>> | undefined;
      let commandError: string | undefined;
      try {
        commandResult = await store.applyTransition(order.workOrderId, toState, `edge:${fromState}:${toState}`, "foreman", "2030-01-01T00:00:00.000Z");
      } catch (error) {
        commandError = error instanceof Error ? error.message : String(error);
      }
      const legal = (WORK_ORDER_TRANSITION_CONTRACT[fromState] as readonly string[]).includes(toState);
      if (fromState === toState) expect(result).toMatchObject({ error: "idempotent" });
      else if (legal) expect(result).toMatchObject({ order: { status: toState } });
      else expect(result).toMatchObject({ error: "invalid_transition" });
      if (fromState === toState) expect(commandResult).toMatchObject({ ok: false, code: "idempotent" });
      else if (fromState === "merged" && toState === "released") expect(commandError).toBe("release_execution_requires_release_decision");
      else if (legal) expect(commandResult).toMatchObject({ ok: true, order: { status: toState } });
      else expect(commandResult).toMatchObject({ ok: false, code: "invalid_transition" });
    }
  }
});
