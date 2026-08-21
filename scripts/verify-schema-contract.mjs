import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function normalized(source) {
  return source.toLowerCase().replace(/\s+/g, " ").trim();
}

function tableBody(source, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`create table(?: if not exists)?\\s+${escaped}\\s*\\((.*?)\\);`, "is"));
  if (!match) throw new Error(`missing table definition: ${table}`);
  return match[1].toLowerCase();
}

function requireColumns(source, label, table, columns) {
  let body;
  try {
    body = tableBody(source, table);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    return;
  }
  for (const column of columns) {
    if (!new RegExp(`\\b${column}\\b`, "i").test(body)) failures.push(`${label}: ${table}.${column} is missing`);
  }
}

function requireSnippet(source, label, snippet) {
  if (!normalized(source).includes(normalized(snippet))) failures.push(`${label}: missing ${snippet}`);
}

function requireIndex(source, label, table, columns, unique = false) {
  const kind = unique ? "create unique index" : "create index";
  requireSnippet(source, label, `${kind} if not exists`);
  const compact = normalized(source);
  const signature = `on ${table} (${columns.join(", ")})`;
  if (!compact.includes(signature)) failures.push(`${label}: missing ${unique ? "unique " : ""}index on ${table} (${columns.join(", ")})`);
}

const d1Graph = read("apps/control-plane-worker/migrations/0017_factory_graph_events.sql");
const d1Commands = read("apps/control-plane-worker/migrations/0015_factory_commands_aftercare.sql");
const d1Spine = read("apps/control-plane-worker/migrations/0020_factory_spine.sql");
const d1Checkpoints = read("apps/control-plane-worker/migrations/0021_factory_projection_checkpoints.sql");
const d1Telemetry = read("apps/control-plane-worker/migrations/0022_factory_command_telemetry.sql");
const d1TelemetryRetention = read("apps/control-plane-worker/migrations/0023_factory_command_telemetry_retention.sql");
const d1OperationalTelemetry = read("apps/control-plane-worker/migrations/0024_factory_operational_telemetry.sql");
const d1 = [d1Graph, d1Commands, d1Spine, d1Checkpoints, d1Telemetry, d1TelemetryRetention, d1OperationalTelemetry].join("\n");
const sqlite = read("packages/local-runtime/src/sqlite-store.ts");

const graphColumns = [
  "event_id", "aggregate_id", "aggregate_type", "organization_id", "factory_id", "event_type",
  "actor_id", "actor_type", "occurred_at", "correlation_id", "causation_id", "schema_version",
  "policy_version", "provenance", "external_references_json", "payload_json",
];
const spineEventColumns = ["aggregate_sequence", "command_id", "idempotency_key", "payload_fingerprint"];
const receiptColumns = ["organization_id", "work_order_id", "idempotency_key", "payload_fingerprint", "command_id", "event_ids_json", "result_json", "created_at"];
const checkpointColumns = ["organization_id", "aggregate_id", "aggregate_type", "last_event_id", "last_aggregate_sequence", "projection_json", "projection_fingerprint", "status", "attempt_count", "last_error", "updated_at"];
const telemetryColumns = ["telemetry_id", "command_id", "organization_id", "factory_id", "work_order_id", "idempotency_key", "payload_fingerprint", "correlation_id", "outcome", "event_count", "projection_event_count", "projection_status", "aggregate_sequence", "duration_ms", "error_code", "created_at"];
const operationalTelemetryColumns = ["signal_id", "schema_version", "signal", "outcome", "correlation_id", "organization_id", "factory_id", "work_order_id", "duration_ms", "retry_count", "error_code", "dimensions_json", "created_at"];

requireColumns(d1Graph, "D1 migration 0017", "tinkerbot_factory_graph_events", graphColumns);
requireColumns(d1Spine, "D1 migration 0020", "tinkerbot_factory_command_receipts", receiptColumns);
requireColumns(d1Checkpoints, "D1 migration 0021", "tinkerbot_factory_projection_checkpoints", checkpointColumns);
requireColumns(d1Telemetry, "D1 migration 0022", "tinkerbot_factory_command_telemetry", telemetryColumns);
requireColumns(d1OperationalTelemetry, "D1 migration 0024", "tinkerbot_factory_operational_telemetry", operationalTelemetryColumns);
for (const column of spineEventColumns) requireSnippet(d1Spine, "D1 migration 0020", `add column ${column}`);
requireColumns(d1Commands, "D1 migration 0015", "tinkerbot_factory_commands", ["command_id", "organization_id", "idempotency_key", "work_order_id", "action", "payload_json", "created_at"]);

requireColumns(sqlite, "SQLite runtime DDL", "tinkerbot_factory_graph_events", [...graphColumns, ...spineEventColumns]);
requireColumns(sqlite, "SQLite runtime DDL", "tinkerbot_factory_command_receipts", receiptColumns);
requireColumns(sqlite, "SQLite runtime DDL", "tinkerbot_factory_projection_checkpoints", checkpointColumns);
requireColumns(sqlite, "SQLite runtime DDL", "tinkerbot_factory_command_telemetry", telemetryColumns);
requireColumns(sqlite, "SQLite runtime DDL", "tinkerbot_factory_commands", ["command_id", "organization_id", "idempotency_key", "work_order_id", "action", "payload_json", "created_at"]);

for (const [label, source] of [["D1", d1], ["SQLite", sqlite]]) {
  requireIndex(source, `${label} graph aggregate`, "tinkerbot_factory_graph_events", ["aggregate_id", "occurred_at"]);
  requireIndex(source, `${label} graph tenant`, "tinkerbot_factory_graph_events", ["organization_id", "factory_id", "occurred_at"]);
  requireIndex(source, `${label} graph sequence`, "tinkerbot_factory_graph_events", ["aggregate_id", "aggregate_sequence"], true);
  requireIndex(source, `${label} command idempotency`, "tinkerbot_factory_commands", ["organization_id", "idempotency_key"], true);
  requireIndex(source, `${label} receipt work order`, "tinkerbot_factory_command_receipts", ["organization_id", "work_order_id", "created_at"]);
  requireIndex(source, `${label} projection retry`, "tinkerbot_factory_projection_checkpoints", ["status", "updated_at"]);
  requireIndex(source, `${label} telemetry organization`, "tinkerbot_factory_command_telemetry", ["organization_id", "created_at"]);
  requireIndex(source, `${label} telemetry work order`, "tinkerbot_factory_command_telemetry", ["work_order_id", "created_at"]);
  requireIndex(source, `${label} telemetry retention`, "tinkerbot_factory_command_telemetry", ["created_at"]);
}
requireIndex(d1, "D1 operational telemetry organization", "tinkerbot_factory_operational_telemetry", ["organization_id", "created_at"]);
requireIndex(d1, "D1 operational telemetry signal", "tinkerbot_factory_operational_telemetry", ["signal", "created_at"]);
requireIndex(d1, "D1 operational telemetry retention", "tinkerbot_factory_operational_telemetry", ["created_at"]);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({ status: "ok", adapters: ["sqlite", "d1"], checked: ["graph_events", "factory_commands", "command_receipts", "projection_checkpoints", "command_telemetry", "operational_telemetry", "telemetry_retention"] }));
