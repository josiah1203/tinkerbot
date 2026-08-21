import { expect, test } from "vitest";
import { FactoryLifecycle, MemoryFactoryStore } from "../packages/factory/src";

test("lifecycle commands write canonical intent and release events", async () => {
  const store = new MemoryFactoryStore();
  const lifecycle = new FactoryLifecycle(store);
  const context = { organizationId: "org", factoryId: "fac", actorId: "owner", actorType: "human" as const, policyVersion: "v1" };
  const intent = await lifecycle.createIntent(context, "Fix timezone");
  await lifecycle.record({ ...context, actorId: "release-authority" }, "release.requested", "wo_release", "work_order", { requested: true, workOrderId: "wo_release", requestId: "release-request-1" });
  expect(await store.listFactoryEvents("wo_release")).toMatchObject([{ type: "release.requested" }]);
});
