import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  assertFactoryEventAuthority,
  assertFactoryEventOrdering,
  containsRawCredentials,
  isFactoryCommandBoundaryEventType,
  projectFactoryEvents,
  type FactoryCommandReceipt,
  type FactoryEvent,
  type FactoryProjection,
  type WorkOrder,
} from "../../../packages/factory/src";

function workOrderInsertStatement(database: D1DatabaseLike, order: WorkOrder, ignore = false) {
  const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
  return database.prepare(`${verb} INTO tinkerbot_work_orders (work_order_id, factory_id, organization_id, source_type, source_id, repository_id, issue_or_pull_request, intent, acceptance_criteria, policy_version, definition_version, definition_digest, current_stage, status, actor, created_at, updated_at, product_id, line_id, cell_id, owner, risk, autonomy_mode, output_kind, policy_json, dependencies_json, held_by, verification_verdict, review_assessment, release_decision, waiver_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)`).bind(
    order.workOrderId, order.factoryId, order.organizationId, order.sourceType, order.sourceId, order.repositoryId, order.issueOrPullRequest ?? null, order.intent ?? null, order.acceptanceCriteria ?? null, order.policyVersion, order.definitionVersion, order.definitionDigest, order.currentStage, order.status, order.actor, order.createdAt, order.updatedAt, order.productId ?? null, order.lineId ?? null, order.cellId ?? null, order.owner ?? null, order.risk ?? null, order.autonomyMode ?? null, order.outputKind ?? null, order.policyJson ?? null, order.dependenciesJson ?? null, order.heldBy ?? null, order.verificationVerdict ?? "UNKNOWN", order.reviewAssessment ?? "NEEDS_HUMAN_REVIEW", order.releaseDecision ?? "BLOCKED", order.waiver ? JSON.stringify(order.waiver) : null,
  );
}

export interface FactoryGraphStoreDependencies {
  refreshLifecycleProjection(workOrderId: string, organizationId: string, updatedAt?: string): Promise<FactoryProjection>;
}

export class D1FactoryGraphStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly dependencies: FactoryGraphStoreDependencies,
  ) {}

  private async persistFactoryEvent(event: FactoryEvent, options: { commandBoundary?: boolean } = {}): Promise<boolean> {
    if (!options.commandBoundary && isFactoryCommandBoundaryEventType(event.type)) throw new Error("factory_command_boundary_required");
    assertFactoryEventAuthority(event);
    if (["release.decided", "release.executed", "release.rolled_back"].includes(event.type)) assertFactoryEventOrdering(event, await this.listFactoryEvents(event.aggregateId, event.organizationId));
    if (containsRawCredentials({ payload: event.payload, externalReferences: event.externalReferences })) throw new Error("Factory graph events must not contain raw credentials.");
    const result = await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version, policy_version, provenance, external_references_json, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)").bind(
      event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.schemaVersion, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
    ).run() as { meta?: { changes?: number } };
    if (result.meta?.changes !== 0 && (event.aggregateSequence !== undefined || event.commandId || event.idempotencyKey || event.payloadFingerprint)) {
      await this.database.prepare("UPDATE tinkerbot_factory_graph_events SET aggregate_sequence = ?1, command_id = ?2, idempotency_key = ?3, payload_fingerprint = ?4 WHERE event_id = ?5").bind(event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.eventId).run();
    }
    if (result.meta?.changes !== 0) await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?1, ?2, ?3, ?4, NULL)").bind(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt).run();
    return result.meta?.changes !== 0;
  }

  async appendFactoryEvents(events: readonly FactoryEvent[], options: { commandBoundary?: boolean; admission?: WorkOrder } = {}): Promise<void> {
    if (!events.length) return;
    const priorByAggregate = new Map<string, FactoryEvent[]>();
    for (const event of events) {
      const prior = priorByAggregate.get(event.aggregateId) ?? await this.listFactoryEvents(event.aggregateId, event.organizationId);
      if (!options.commandBoundary && isFactoryCommandBoundaryEventType(event.type)) throw new Error("factory_command_boundary_required");
      assertFactoryEventAuthority(event);
      if (containsRawCredentials({ payload: event.payload, externalReferences: event.externalReferences })) throw new Error("Factory graph events must not contain raw credentials.");
      assertFactoryEventOrdering(event, prior);
      priorByAggregate.set(event.aggregateId, [...prior, event]);
    }
    if (!this.database.batch) {
      for (const event of events) await this.persistFactoryEvent(event, { commandBoundary: true });
    } else {
      const statements = events.flatMap((event) => [
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)").bind(
          event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.schemaVersion, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
        ),
        this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?1, ?2, ?3, ?4, NULL)").bind(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt),
      ]);
      await this.database.batch(statements);
    }
    for (const aggregateId of new Set(events.map((event) => event.aggregateId))) {
      const organizationId = events.find((event) => event.aggregateId === aggregateId)?.organizationId;
      if (organizationId) await this.dependencies.refreshLifecycleProjection(aggregateId, organizationId);
    }
  }

  /** Persist the command receipt and graph events as one D1 batch when available. */
  async appendFactoryCommand(events: readonly FactoryEvent[], receipt: FactoryCommandReceipt, options: { admission?: WorkOrder } = {}): Promise<void> {
    if (!events.length) throw new Error("factory_command_produced_no_events");
    if (options.admission && events[0]?.type !== "work_order.created") throw new Error("factory_admission_requires_creation_event");
    for (const event of events) {
      assertFactoryEventAuthority(event);
      if (containsRawCredentials({ payload: event.payload, externalReferences: event.externalReferences })) throw new Error("Factory graph events must not contain raw credentials.");
    }
    if (!this.database.batch) {
      if (options.admission) await workOrderInsertStatement(this.database, options.admission, true).run();
      await this.appendFactoryEvents(events, { commandBoundary: true });
      await this.putFactoryCommandReceipt(receipt);
      return;
    }
    const admissionStatement = options.admission ? workOrderInsertStatement(this.database, options.admission, true) : undefined;
    const receiptStatement = this.database.prepare("INSERT INTO tinkerbot_factory_command_receipts (organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(
      receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey, receipt.payloadFingerprint, receipt.commandId, JSON.stringify(receipt.eventIds), receipt.resultJson ?? null, receipt.createdAt,
    );
    const eventStatements = events.flatMap((event) => [
      this.database.prepare("INSERT INTO tinkerbot_factory_graph_events (event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type, actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version, aggregate_sequence, command_id, idempotency_key, payload_fingerprint, policy_version, provenance, external_references_json, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)").bind(
        event.eventId, event.aggregateId, event.aggregateType, event.organizationId, event.factoryId, event.type, event.actorId, event.actorType, event.occurredAt, event.correlationId, event.causationId ?? null, event.schemaVersion, event.aggregateSequence ?? null, event.commandId ?? null, event.idempotencyKey ?? null, event.payloadFingerprint ?? null, event.policyVersion ?? null, event.provenance, event.externalReferences ? JSON.stringify(event.externalReferences) : null, JSON.stringify(event.payload),
      ),
      this.database.prepare("INSERT OR IGNORE INTO tinkerbot_sync_outbox (event_id, kind, payload_json, created_at, synced_at) VALUES (?1, ?2, ?3, ?4, NULL)").bind(event.eventId, "factory-graph-event", JSON.stringify({ event }), event.occurredAt),
    ]);
    await this.database.batch([...(admissionStatement ? [admissionStatement] : []), receiptStatement, ...eventStatements]);
    for (const aggregateId of new Set(events.map((event) => event.aggregateId))) {
      const organizationId = events.find((event) => event.aggregateId === aggregateId)?.organizationId;
      if (organizationId) await this.dependencies.refreshLifecycleProjection(aggregateId, organizationId);
    }
  }

  async getFactoryCommandReceipt(organizationId: string, workOrderId: string, idempotencyKey: string): Promise<FactoryCommandReceipt | null> {
    const row = await this.database.prepare("SELECT organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at FROM tinkerbot_factory_command_receipts WHERE organization_id = ?1 AND work_order_id = ?2 AND idempotency_key = ?3").bind(organizationId, workOrderId, idempotencyKey).first<Record<string, unknown>>();
    if (!row) return null;
    let eventIds: string[] = [];
    try { const parsed = JSON.parse(String(row.event_ids_json)); if (Array.isArray(parsed)) eventIds = parsed.filter((item): item is string => typeof item === "string"); } catch { /* malformed receipt is treated as absent and will be rebuilt from events */ }
    return { organizationId: String(row.organization_id), workOrderId: String(row.work_order_id), idempotencyKey: String(row.idempotency_key), payloadFingerprint: String(row.payload_fingerprint), commandId: String(row.command_id), eventIds, resultJson: row.result_json ? String(row.result_json) : undefined, createdAt: String(row.created_at) };
  }

  async putFactoryCommandReceipt(receipt: FactoryCommandReceipt): Promise<void> {
    const existing = await this.getFactoryCommandReceipt(receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey);
    if (existing && existing.payloadFingerprint !== receipt.payloadFingerprint) throw new Error("idempotency_conflict");
    await this.database.prepare("INSERT OR IGNORE INTO tinkerbot_factory_command_receipts (organization_id, work_order_id, idempotency_key, payload_fingerprint, command_id, event_ids_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(receipt.organizationId, receipt.workOrderId, receipt.idempotencyKey, receipt.payloadFingerprint, receipt.commandId, JSON.stringify(receipt.eventIds), receipt.resultJson ?? null, receipt.createdAt).run();
  }

  async appendFactoryEvent(event: FactoryEvent, options: { commandBoundary?: boolean; admission?: WorkOrder } = {}): Promise<void> {
    const inserted = await this.persistFactoryEvent(event, options);
    if (inserted && event.aggregateType === "work_order") await this.dependencies.refreshLifecycleProjection(event.aggregateId, event.organizationId);
  }

  async appendFactoryEventOnce(event: FactoryEvent): Promise<boolean> {
    const inserted = await this.persistFactoryEvent(event);
    if (inserted && event.aggregateType === "work_order") await this.dependencies.refreshLifecycleProjection(event.aggregateId, event.organizationId);
    return inserted;
  }

  async listFactoryEvents(aggregateId: string, organizationId?: string): Promise<FactoryEvent[]> {
    const statement = organizationId
      ? this.database.prepare("SELECT * FROM tinkerbot_factory_graph_events WHERE aggregate_id = ?1 AND organization_id = ?2 ORDER BY COALESCE(aggregate_sequence, 9223372036854775807), occurred_at, event_id").bind(aggregateId, organizationId)
      : this.database.prepare("SELECT * FROM tinkerbot_factory_graph_events WHERE aggregate_id = ?1 ORDER BY COALESCE(aggregate_sequence, 9223372036854775807), occurred_at, event_id").bind(aggregateId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ eventId: String(row.event_id), aggregateId: String(row.aggregate_id), aggregateType: String(row.aggregate_type), organizationId: String(row.organization_id), factoryId: String(row.factory_id), type: String(row.event_type) as FactoryEvent["type"], actorId: String(row.actor_id), actorType: String(row.actor_type) as FactoryEvent["actorType"], occurredAt: String(row.occurred_at), correlationId: String(row.correlation_id), causationId: row.causation_id ? String(row.causation_id) : undefined, aggregateSequence: row.aggregate_sequence === null || row.aggregate_sequence === undefined ? undefined : Number(row.aggregate_sequence), commandId: row.command_id ? String(row.command_id) : undefined, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined, payloadFingerprint: row.payload_fingerprint ? String(row.payload_fingerprint) : undefined, schemaVersion: Number(row.schema_version ?? 1) as 1, policyVersion: row.policy_version ? String(row.policy_version) : undefined, provenance: String(row.provenance) as FactoryEvent["provenance"], externalReferences: row.external_references_json ? JSON.parse(String(row.external_references_json)) : undefined, payload: JSON.parse(String(row.payload_json)) })).sort((left, right) => (left.aggregateSequence !== undefined && right.aggregateSequence !== undefined && left.aggregateSequence !== right.aggregateSequence ? left.aggregateSequence - right.aggregateSequence : left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId)));
  }

  async reconstructFactoryGraph(aggregateId: string, organizationId: string): Promise<FactoryProjection> {
    return projectFactoryEvents(await this.listFactoryEvents(aggregateId, organizationId));
  }
}
