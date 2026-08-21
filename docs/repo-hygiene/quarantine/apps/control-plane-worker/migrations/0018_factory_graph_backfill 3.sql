-- Backfill canonical Factory Graph events from legacy work-order and approval rows.
-- All inserts are idempotent so this migration is safe to retry in staging/production.
INSERT OR IGNORE INTO tinkerbot_factory_graph_events (
  event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type,
  actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version,
  policy_version, provenance, external_references_json, payload_json
)
SELECT
  'evt_' || work_order_id,
  work_order_id,
  'work_order',
  organization_id,
  factory_id,
  'work_order.created',
  actor,
  CASE WHEN source_type = 'manual' THEN 'human' ELSE 'integration' END,
  created_at,
  work_order_id,
  NULL,
  1,
  policy_version,
  'ATTESTED',
  NULL,
  json_object('workOrderId', work_order_id, 'intent', intent, 'sourceType', source_type, 'sourceId', source_id)
FROM tinkerbot_work_orders;

INSERT OR IGNORE INTO tinkerbot_factory_graph_events (
  event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type,
  actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version,
  policy_version, provenance, external_references_json, payload_json
)
SELECT
  'legacy_' || e.work_order_id || '_' || e.from_state || '_' || e.to_state || '_' || e.cause_id,
  e.work_order_id,
  'work_order',
  w.organization_id,
  w.factory_id,
  CASE e.to_state
    WHEN 'triage' THEN 'task.queued'
    WHEN 'specification' THEN 'spec.created'
    WHEN 'implementation' THEN 'task.started'
    WHEN 'review' THEN 'review.requested'
    WHEN 'verification' THEN 'verification.started'
    WHEN 'approval' THEN 'review.completed'
    WHEN 'ready' THEN 'release.requested'
    WHEN 'merged' THEN 'integration_candidate.assembled'
    WHEN 'released' THEN 'release.completed'
    WHEN 'blocked' THEN 'task.blocked'
    WHEN 'failed' THEN 'task.reworked'
    ELSE NULL
  END,
  e.actor,
  'system',
  e.created_at,
  e.cause_id,
  e.cause_id,
  1,
  w.policy_version,
  'ATTESTED',
  NULL,
  json_object('fromState', e.from_state, 'toState', e.to_state, 'legacyEventId', e.event_id)
FROM tinkerbot_work_order_events e
JOIN tinkerbot_work_orders w ON w.work_order_id = e.work_order_id
WHERE e.to_state IN ('triage', 'specification', 'implementation', 'review', 'verification', 'approval', 'ready', 'merged', 'released', 'blocked', 'failed');

INSERT OR IGNORE INTO tinkerbot_factory_graph_events (
  event_id, aggregate_id, aggregate_type, organization_id, factory_id, event_type,
  actor_id, actor_type, occurred_at, correlation_id, causation_id, schema_version,
  policy_version, provenance, external_references_json, payload_json
)
SELECT
  'approval_' || a.work_order_id || '_' || a.decision || '_' || a.approval_id,
  a.work_order_id,
  'work_order',
  w.organization_id,
  w.factory_id,
  'approval.recorded',
  a.actor,
  'human',
  a.created_at,
  a.work_order_id,
  NULL,
  1,
  w.policy_version,
  'HUMAN_VERIFIED',
  NULL,
  json_object('decision', a.decision, 'workOrderId', a.work_order_id, 'approvalId', a.approval_id)
FROM tinkerbot_approvals a
JOIN tinkerbot_work_orders w ON w.work_order_id = a.work_order_id
WHERE lower(a.actor) NOT LIKE '%agent%'
  AND lower(a.actor) NOT LIKE '%bot%'
  AND lower(a.actor) NOT LIKE '%foreman%';
