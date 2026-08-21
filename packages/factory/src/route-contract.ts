import type { FactoryEvent, FactoryProjection } from "./graph";
import type { ActionCapability, WorkOrderGroupView, WorkOrderStageView, WorkOrderView } from "./control-plane-view";

/** Compatibility group values emitted by the first hosted dashboard API. */
export type LegacyWorkOrderGroup = "needs_attention" | "in_progress" | "waiting_for_approval" | "completed";

/** The wire representation is deliberately a superset of the normalized view.
 * `group` and `lane` are retained for older dashboard clients; `viewGroup` is
 * the canonical graph-derived value consumed by new clients. */
export type WorkOrderRouteView = Omit<WorkOrderView, "group"> & {
  group: WorkOrderGroupView | LegacyWorkOrderGroup;
  viewGroup?: WorkOrderGroupView;
  lane?: WorkOrderStageView;
};

export interface WorkOrderListRouteResponse {
  workOrders: WorkOrderRouteView[];
}

export interface WorkOrderDetailRouteResponse {
  workOrder: WorkOrderRouteView;
  run?: Record<string, unknown> | null;
  stages?: Array<Record<string, unknown>>;
  events?: FactoryEvent[];
  availableActions?: ActionCapability[];
  graph?: FactoryProjection;
}

export interface WorkOrderGraphRouteResponse {
  workOrder: WorkOrderRouteView;
  graph: FactoryProjection;
  economics: {
    cogsCents: number;
    copqCents: number;
    acceptedChanges: number;
    unrevertedChanges: number;
    outcomePositiveChanges: number;
    costPerAcceptedUnrevertedOutcomePositiveChange: number | null;
  };
  events: FactoryEvent[];
  sourceOfTruth: "append_only_factory_graph";
}

export interface WorkOrderRunRouteResponse {
  run: Record<string, string>;
  stages: Array<{ stage: string; status: string; summary?: string }>;
  events: FactoryEvent[];
}

export interface WorkOrderMutationRouteResponse {
  workOrder?: WorkOrderRouteView;
  accepted?: boolean;
  replayed?: boolean;
  steered?: boolean;
  specApproved?: boolean;
  held?: boolean;
  terminal?: string;
  wait?: string;
  runId?: string;
  code?: string;
  [key: string]: unknown;
}

export interface FactoryRouteError {
  error: string;
  code: string;
  requestId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

const normalizedGroups = new Set<WorkOrderGroupView>(["blocked", "awaiting_review", "in_progress", "ready", "released", "unknown"]);
const legacyGroups = new Set<LegacyWorkOrderGroup>(["needs_attention", "in_progress", "waiting_for_approval", "completed"]);
const stages = new Set<WorkOrderStageView>(["intake", "spec", "build", "test", "verify", "release"]);
const verdicts = new Set(["pass", "blocked", "fail", "unknown", "not_run"]);
const reviews = new Set(["not_required", "awaiting_human", "approved", "rejected", "changes_requested"]);
const releases = new Set(["not_eligible", "awaiting_authorization", "approved", "hold", "released", "rolled_back", "cancelled"]);
const outcomes = new Set(["pending", "accepted", "reworked", "failed", "rejected", "unknown"]);

export function workOrderRouteView(view: WorkOrderView, options: { legacyGroup?: LegacyWorkOrderGroup; lane?: WorkOrderStageView } = {}): WorkOrderRouteView {
  return { ...view, group: options.legacyGroup ?? view.group, viewGroup: view.group, lane: options.lane ?? view.stage };
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, context: string): string {
  if (typeof value[key] !== "string" || !String(value[key]).trim()) throw new Error(`${context}.${key} must be a non-empty string.`);
  return String(value[key]);
}

function enumField<T extends string>(value: Record<string, unknown>, key: string, allowed: ReadonlySet<T>, context: string): T {
  const candidate = stringField(value, key, context) as T;
  if (!allowed.has(candidate)) throw new Error(`${context}.${key} is not in the route contract.`);
  return candidate;
}

export function workOrderListRouteResponse(workOrders: readonly WorkOrderRouteView[]): WorkOrderListRouteResponse {
  return { workOrders: [...workOrders] };
}

export function workOrderDetailRouteResponse(input: Omit<WorkOrderDetailRouteResponse, "workOrder"> & { workOrder: WorkOrderRouteView }): WorkOrderDetailRouteResponse {
  return { ...input };
}

export function workOrderGraphRouteResponse(input: WorkOrderGraphRouteResponse): WorkOrderGraphRouteResponse {
  return { ...input, events: [...input.events] };
}

export function workOrderRunRouteResponse(input: WorkOrderRunRouteResponse): WorkOrderRunRouteResponse {
  return { ...input, stages: [...input.stages], events: [...input.events] };
}

/** Shared envelope for non-lifecycle dashboard collections. The key remains
 * backward-compatible with existing clients while the construction path is
 * typed and copy-on-write. */
export function factoryCollectionRouteResponse<T extends object>(key: string, items: readonly T[]): Record<string, T[]> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error("invalid_factory_collection_key");
  return { [key]: [...items] };
}

export function parseFactoryCollectionRouteResponse<T extends object>(value: unknown, key: string): T[] {
  const body = record(value, `${key} response`);
  if (!Array.isArray(body[key])) throw new Error(`${key} response.${key} must be an array.`);
  return body[key] as T[];
}

export function workOrderMutationRouteResponse(input: WorkOrderMutationRouteResponse): WorkOrderMutationRouteResponse {
  return input.workOrder ? { ...input, workOrder: { ...input.workOrder } } : { ...input };
}

export function parseWorkOrderRouteView(value: unknown, context = "workOrder"): WorkOrderRouteView {
  const item = record(value, context);
  stringField(item, "id", context);
  stringField(item, "workOrderId", context);
  stringField(item, "factoryId", context);
  stringField(item, "title", context);
  enumField(item, "stage", stages, context);
  enumField(item, "verificationVerdict", verdicts, context);
  enumField(item, "reviewDecision", reviews, context);
  enumField(item, "releaseDecision", releases, context);
  enumField(item, "outcomeStatus", outcomes, context);
  stringField(item, "updatedAt", context);
  const group = stringField(item, "group", context);
  if (!normalizedGroups.has(group as WorkOrderGroupView) && !legacyGroups.has(group as LegacyWorkOrderGroup)) throw new Error(`${context}.group is not in the route contract.`);
  if (item.viewGroup !== undefined) enumField(item, "viewGroup", normalizedGroups, context);
  if (item.lane !== undefined) enumField(item, "lane", stages, context);
  return item as unknown as WorkOrderRouteView;
}

export function parseWorkOrderListRouteResponse(value: unknown): WorkOrderListRouteResponse {
  const body = record(value, "workOrders response");
  if (!Array.isArray(body.workOrders)) throw new Error("workOrders response.workOrders must be an array.");
  return { workOrders: body.workOrders.map((item, index) => parseWorkOrderRouteView(item, `workOrders[${index}]`)) };
}

export function parseWorkOrderDetailRouteResponse(value: unknown): WorkOrderDetailRouteResponse {
  const body = record(value, "work-order detail response");
  return { ...body, workOrder: parseWorkOrderRouteView(body.workOrder, "workOrder") } as WorkOrderDetailRouteResponse;
}

export function parseWorkOrderGraphRouteResponse(value: unknown): WorkOrderGraphRouteResponse {
  const body = record(value, "work-order graph response");
  const graph = record(body.graph, "graph");
  const economics = record(body.economics, "economics");
  if (!Array.isArray(body.events)) throw new Error("graph response.events must be an array.");
  if (body.sourceOfTruth !== "append_only_factory_graph") throw new Error("graph response.sourceOfTruth must identify the append-only Factory Graph.");
  for (const key of ["cogsCents", "copqCents", "acceptedChanges", "unrevertedChanges", "outcomePositiveChanges"] as const) {
    if (typeof economics[key] !== "number" || !Number.isFinite(economics[key])) throw new Error(`economics.${key} must be finite.`);
  }
  if (economics.costPerAcceptedUnrevertedOutcomePositiveChange !== null && typeof economics.costPerAcceptedUnrevertedOutcomePositiveChange !== "number") throw new Error("economics.costPerAcceptedUnrevertedOutcomePositiveChange must be a number or null.");
  if (typeof graph.eventCount !== "number" || !Number.isInteger(graph.eventCount) || graph.eventCount < 0) throw new Error("graph.eventCount must be a non-negative integer.");
  return { ...body, workOrder: parseWorkOrderRouteView(body.workOrder, "workOrder"), graph: graph as unknown as FactoryProjection, economics: economics as WorkOrderGraphRouteResponse["economics"], events: body.events as FactoryEvent[], sourceOfTruth: "append_only_factory_graph" };
}

export function parseWorkOrderMutationRouteResponse(value: unknown): WorkOrderMutationRouteResponse {
  const body = record(value, "work-order mutation response");
  return body.workOrder === undefined ? body as WorkOrderMutationRouteResponse : { ...body, workOrder: parseWorkOrderRouteView(body.workOrder, "workOrder") } as WorkOrderMutationRouteResponse;
}

export function parseFactoryRouteError(value: unknown): FactoryRouteError {
  const body = record(value, "route error");
  return { ...body, error: stringField(body, "error", "route error"), code: stringField(body, "code", "route error") };
}

export function isFactoryRouteError(value: unknown): value is FactoryRouteError {
  try {
    parseFactoryRouteError(value);
    return true;
  } catch {
    return false;
  }
}
