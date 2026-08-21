import { expect, test } from "vitest";
import {
  parseFactoryRouteError,
  parseFactoryCollectionRouteResponse,
  parseWorkOrderDetailRouteResponse,
  parseWorkOrderGraphRouteResponse,
  parseWorkOrderListRouteResponse,
  parseWorkOrderMutationRouteResponse,
  workOrderListRouteResponse,
  workOrderMutationRouteResponse,
  workOrderRunRouteResponse,
  factoryCollectionRouteResponse,
  workOrderRouteView,
  type WorkOrderView,
} from "../packages/factory/src";

const view: WorkOrderView = {
  id: "wo_1",
  workOrderId: "wo_1",
  title: "Implement refunds",
  factoryId: "fac_1",
  status: "implementation",
  stage: "build",
  actor: { id: "agent-1", name: "agent-1", kind: "agent" },
  risk: "medium",
  updatedAt: "2030-01-01T00:00:00.000Z",
  verificationVerdict: "unknown",
  reviewDecision: "awaiting_human",
  releaseDecision: "not_eligible",
  outcomeStatus: "pending",
  unresolvedUnknownCount: 1,
  group: "in_progress",
  availableActions: [],
};

test("WorkOrder route contracts preserve legacy fields while exposing the normalized view", () => {
  const routeView = workOrderRouteView(view, { legacyGroup: "in_progress", lane: "build" });
  expect(parseWorkOrderListRouteResponse(workOrderListRouteResponse([routeView]))).toMatchObject({ workOrders: [{ workOrderId: "wo_1", group: "in_progress", viewGroup: "in_progress", lane: "build" }] });
  expect(parseWorkOrderDetailRouteResponse({ workOrder: routeView, events: [], stages: [], availableActions: [] })).toMatchObject({ workOrder: { id: "wo_1" } });
});

test("graph route contracts require graph authority and finite economics", () => {
  const routeView = workOrderRouteView(view);
  const response = parseWorkOrderGraphRouteResponse({
    workOrder: routeView,
    graph: { eventCount: 0, verificationVerdict: "UNKNOWN", reviewDecision: "NOT_REVIEWED", releaseDecision: "NOT_RELEASED", outcomeStatus: "UNMEASURED", outcomeMaturity: "IMMATURE" },
    economics: { cogsCents: 0, copqCents: 0, acceptedChanges: 0, unrevertedChanges: 0, outcomePositiveChanges: 0, costPerAcceptedUnrevertedOutcomePositiveChange: null },
    events: [],
    sourceOfTruth: "append_only_factory_graph",
  });
  expect(response.sourceOfTruth).toBe("append_only_factory_graph");
  expect(() => parseWorkOrderGraphRouteResponse({ ...response, sourceOfTruth: "compatibility_columns" })).toThrow(/sourceOfTruth/);
});

test("route errors have stable machine-readable codes", () => {
  expect(parseFactoryRouteError({ error: "Not found", code: "not_found" })).toEqual({ error: "Not found", code: "not_found" });
  expect(() => parseWorkOrderListRouteResponse({ workOrders: [{ id: "missing" }] })).toThrow(/workOrderId/);
  expect(() => parseFactoryRouteError({ error: "bad" })).toThrow(/code/);
});

test("mutation responses may carry a normalized work-order view without forcing one for acknowledgements", () => {
  const routeView = workOrderRouteView(view);
  expect(parseWorkOrderMutationRouteResponse({ accepted: true, replayed: true })).toMatchObject({ accepted: true, replayed: true });
  expect(parseWorkOrderMutationRouteResponse(workOrderMutationRouteResponse({ workOrder: routeView, specApproved: true }))).toMatchObject({ workOrder: { workOrderId: "wo_1" }, specApproved: true });
});

test("run and collection routes use copy-on-write typed envelopes", () => {
  const items = [{ id: "product_1" }];
  const collection = factoryCollectionRouteResponse("products", items);
  expect(parseFactoryCollectionRouteResponse<{ id: string }>(collection, "products")).toEqual(items);
  expect(() => factoryCollectionRouteResponse("bad-key!", items)).toThrow("invalid_factory_collection_key");
  const run = workOrderRunRouteResponse({ run: { run_id: "run_1" }, stages: [{ stage: "implementation", status: "ok" }], events: [] });
  expect(run).toMatchObject({ run: { run_id: "run_1" }, stages: [{ status: "ok" }], events: [] });
});
