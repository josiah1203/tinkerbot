import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  factoryMcpToolDescriptors,
  factoryTreeDigest,
  handleFactoryMcpTool,
  implementBranchName,
  type ConversationMessage,
  type FactoryEvent,
  type McpToolContext,
} from "../../factory/src";
import { defaultLocalDbPath, SqliteFactoryStore } from "../../local-runtime/src";
import {
  factoryCheckPayload,
  localFactoryGraphStatusPayload,
  localIntentPayload,
  localOutcomePayload,
  localWorkApprovalPayload,
  localWorkNewPayload,
} from "../../cli/src/factory-os";

/** MCP protocol version spoken by the local platform server. */
export const PLATFORM_MCP_PROTOCOL_VERSION = "2025-06-18";
export const PLATFORM_MCP_SERVER_NAME = "tinkerbot-platform";
export const PLATFORM_MCP_SERVER_VERSION = "0.1.0";

export interface PlatformMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export interface PlatformMcpJsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface PlatformMcpJsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PlatformMcpContext extends McpToolContext {
  root: string;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface PlatformMcpStdioStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): PlatformMcpToolDefinition["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/**
 * The local server keeps the original factory MCP tools and adds the graph
 * operations used by the current CLI. This keeps MCP clients on the same
 * command contract as `tb intent`, `tb work`, `tb outcome`, and `tb factory`.
 */
export function platformMcpToolDefinitions(): PlatformMcpToolDefinition[] {
  const legacy = factoryMcpToolDescriptors();
  const byName = new Map(legacy.map((tool) => [tool.name, tool]));
  const definitions: PlatformMcpToolDefinition[] = [
    {
      name: "send_task",
      description: byName.get("send_task")?.description ?? "Create a factory work order.",
      inputSchema: objectSchema({
        title: { type: "string", description: "Short task title or implementation intent." },
        note: { type: "string", description: "Optional additional context." },
        factory: { type: "string" },
        repository: { type: "string" },
      }, ["title"]),
    },
    {
      name: "get_task",
      description: byName.get("get_task")?.description ?? "Read a factory work order.",
      inputSchema: objectSchema({ workOrderId: { type: "string" }, taskId: { type: "string" }, start_working: { type: "boolean" } }, ["workOrderId"]),
    },
    {
      name: "message_foreman",
      description: byName.get("message_foreman")?.description ?? "Send a note to the Foreman.",
      inputSchema: objectSchema({ workOrderId: { type: "string" }, note: { type: "string" } }, ["workOrderId", "note"]),
    },
    {
      name: "get_conversation",
      description: byName.get("get_conversation")?.description ?? "Read the Foreman conversation.",
      inputSchema: objectSchema({ workOrderId: { type: "string" }, taskId: { type: "string" } }, ["workOrderId"]),
    },
    {
      name: "create_factory",
      description: byName.get("create_factory")?.description ?? "Create a .tinkerbot factory tree.",
      inputSchema: objectSchema({
        name: { type: "string" },
        owner: { type: "string" },
        repository: { type: "string" },
        yaml: { type: "string" },
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false } },
      }, ["name"]),
    },
    {
      name: "factory_status",
      description: "List the local factory definition and work orders without requiring a hosted account.",
      inputSchema: objectSchema({}),
    },
    {
      name: "factory_check",
      description: "Compile and safety-check the local .tinkerbot factory definition.",
      inputSchema: objectSchema({}),
    },
    {
      name: "intent_create",
      description: "Persist a canonical intent in the append-only Factory Graph.",
      inputSchema: objectSchema({ text: { type: "string" }, mode: { type: "string", enum: ["micro", "standard", "strategic"] } }, ["text"]),
    },
    {
      name: "work_create",
      description: "Create a local work order from an intent or task description.",
      inputSchema: objectSchema({ intent: { type: "string" } }, ["intent"]),
    },
    {
      name: "work_list",
      description: "List local work orders stored by the platform.",
      inputSchema: objectSchema({}),
    },
    {
      name: "work_approve",
      description: "Record a human approval or rejection for a work order.",
      inputSchema: objectSchema({ workOrderId: { type: "string" }, decision: { type: "string", enum: ["approved", "rejected"] } }, ["workOrderId"]),
    },
    {
      name: "graph_status",
      description: "Reconstruct a work-order or aggregate projection from append-only graph events.",
      inputSchema: objectSchema({ aggregateId: { type: "string" }, workOrderId: { type: "string" } }, ["aggregateId"]),
    },
    {
      name: "outcome_record",
      description: "Record a post-release outcome without changing verification or release verdicts.",
      inputSchema: objectSchema({
        workOrderId: { type: "string" },
        status: { type: "string", enum: ["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"] },
        mature: { type: "boolean" },
        details: { type: "object" },
      }, ["workOrderId", "status"]),
    },
  ];
  return definitions;
}

const TOOL_NAMES = new Set(platformMcpToolDefinitions().map((tool) => tool.name));

function textArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectArgument(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertSafeFactoryPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("factory file path must be relative and NUL-free");
  const normalized = relativePath.replaceAll("\\", "/");
  const candidate = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) throw new Error("factory file path escapes the repository root");
  return candidate;
}

function localFactoryStatus(root: string): Record<string, unknown> {
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  let definition: Record<string, unknown> | undefined;
  try {
    const check = factoryCheckPayload(root);
    definition = { path: check.path, safe: check.safe, compiled: check.compiled };
  } catch (error) {
    definition = { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    root,
    definition,
    workOrders: [...store.orders.values()].map((order) => ({
      workOrderId: order.workOrderId,
      intent: order.intent,
      status: order.status,
      currentStage: order.currentStage,
      repositoryId: order.repositoryId,
      updatedAt: order.updatedAt,
    })),
    sourceOfTruth: "append_only_factory_graph",
  };
}

function localWorkList(root: string): Record<string, unknown> {
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  return { root, workOrders: [...store.orders.values()], sourceOfTruth: "local_sqlite_and_factory_graph" };
}

function localConversationMessage(map: Map<string, ConversationMessage[]>, workOrderId: string, message: ConversationMessage): void {
  const messages = map.get(workOrderId) ?? [];
  messages.push(message);
  map.set(workOrderId, messages);
}

function localMcpEvent(root: string, workOrderId: string, payload: Record<string, unknown>, actorId: string): void {
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const order = store.orders.get(workOrderId);
  if (!order) throw new Error("work order not found");
  const now = new Date().toISOString();
  const event: FactoryEvent = {
    eventId: `mcp_${crypto.randomUUID()}`,
    type: "external_command.received",
    aggregateId: workOrderId,
    aggregateType: "work_order",
    organizationId: order.organizationId,
    factoryId: order.factoryId,
    actorId,
    actorType: "integration",
    occurredAt: now,
    correlationId: workOrderId,
    schemaVersion: 1,
    policyVersion: order.policyVersion,
    provenance: "REPORTED",
    payload,
  };
  store.appendFactoryEventSync(event);
}

function createLocalFactory(root: string, input: { name: string; yaml: string; files: Array<{ path: string; contents: string }> }): { factoryId: string; digest: string; files: string[] } {
  const existing = path.join(root, ".tinkerbot", "factory.yaml");
  if (fs.existsSync(existing)) throw new Error("A factory definition already exists; edit it in git instead of replacing it through MCP.");
  const files = [...input.files];
  if (!files.some((file) => file.path === ".tinkerbot/factory.yaml")) files.unshift({ path: ".tinkerbot/factory.yaml", contents: input.yaml });
  const destinations = files.map((file) => assertSafeFactoryPath(root, file.path));
  for (const [index, file] of files.entries()) {
    const destination = destinations[index]!;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.contents, { encoding: "utf8", mode: 0o600 });
  }
  const digest = factoryTreeDigest(files);
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const now = new Date().toISOString();
  store.appendFactoryEventSync({
    eventId: `factory_${digest.replace(/[^a-f0-9]/gi, "").slice(0, 32)}`,
    type: "factory.created",
    aggregateId: "local-factory",
    aggregateType: "factory",
    organizationId: "local",
    factoryId: "local-factory",
    actorId: "mcp-client",
    actorType: "integration",
    occurredAt: now,
    correlationId: digest,
    schemaVersion: 1,
    provenance: "REPORTED",
    payload: { name: input.name, digest, files: files.map((file) => file.path) },
  });
  return { factoryId: "local-factory", digest, files: files.map((file) => file.path) };
}

/** Build a local, accountless implementation of the platform MCP tools. */
export function createLocalPlatformMcpContext(root = process.cwd()): PlatformMcpContext {
  const resolvedRoot = path.resolve(root);
  const conversations = new Map<string, ConversationMessage[]>();
  const context: PlatformMcpContext = {
    root: resolvedRoot,
    organizationId: "local",
    actor: "mcp-client",
    async sendTask(input) {
      const payload = localWorkNewPayload(resolvedRoot, [input.title, input.note].filter(Boolean).join("\n\n"));
      const workOrderId = String(payload.workOrderId);
      localConversationMessage(conversations, workOrderId, { role: "user", agentId: "mcp-client", content: input.title, at: new Date().toISOString() });
      return { workOrderId };
    },
    async getTask(workOrderId) {
      const store = new SqliteFactoryStore(defaultLocalDbPath(resolvedRoot));
      const workOrder = store.orders.get(workOrderId);
      return {
        workOrder,
        conversation: conversations.get(workOrderId) ?? [],
        git: workOrder ? { branch: implementBranchName(workOrderId), commands: ["git fetch origin", `git worktree add ../${implementBranchName(workOrderId)} origin/${implementBranchName(workOrderId)}`] } : undefined,
      };
    },
    async messageForeman(workOrderId, note) {
      localMcpEvent(resolvedRoot, workOrderId, { action: "message_foreman", note, source: "mcp" }, "mcp-client");
      localConversationMessage(conversations, workOrderId, { role: "user", agentId: "mcp-client", content: note, at: new Date().toISOString() });
      return { accepted: true };
    },
    async createFactory(input) {
      return createLocalFactory(resolvedRoot, input);
    },
    async call(name, args) {
      if (!TOOL_NAMES.has(name)) throw new Error(`Unknown MCP tool: ${name}`);
      if (["send_task", "get_task", "message_foreman", "get_conversation", "create_factory"].includes(name)) {
        if (name === "create_factory") {
          const factoryName = textArgument(args, "name");
          if (!factoryName || factoryName.length > 120 || /[\u0000-\u001f\u007f]/.test(factoryName)) throw new Error("create_factory name must be 1-120 printable characters");
          args = { ...args, name: factoryName };
        }
        const result = await handleFactoryMcpTool(name, args, context);
        if (!result.ok) throw new Error(result.error);
        if (name === "get_conversation") {
          const workOrderId = textArgument(args, "workOrderId") ?? textArgument(args, "taskId") ?? "";
          return { ...result.result as Record<string, unknown>, transcript: conversations.get(workOrderId) ?? [] };
        }
        return result.result;
      }
      if (name === "factory_status") return localFactoryStatus(resolvedRoot);
      if (name === "factory_check") return factoryCheckPayload(resolvedRoot);
      if (name === "intent_create") {
        const text = textArgument(args, "text");
        const mode = textArgument(args, "mode") as "micro" | "standard" | "strategic" | undefined;
        return localIntentPayload(resolvedRoot, text, mode === "standard" || mode === "strategic" ? mode : "micro");
      }
      if (name === "work_create") return localWorkNewPayload(resolvedRoot, textArgument(args, "intent"));
      if (name === "work_list") return localWorkList(resolvedRoot);
      if (name === "work_approve") {
        return localWorkApprovalPayload(resolvedRoot, textArgument(args, "workOrderId"), textArgument(args, "decision") === "rejected" ? "rejected" : "approved");
      }
      if (name === "graph_status") return localFactoryGraphStatusPayload(resolvedRoot, textArgument(args, "aggregateId") ?? textArgument(args, "workOrderId"));
      if (name === "outcome_record") {
        const status = textArgument(args, "status")?.toUpperCase() as "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN" | undefined;
        if (!status || !["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"].includes(status)) throw new Error("outcome status must be POSITIVE, NEUTRAL, NEGATIVE, or UNKNOWN");
        return localOutcomePayload(resolvedRoot, textArgument(args, "workOrderId"), status, args.mature === true, objectArgument(args, "details"));
      }
      // The guard above makes this unreachable unless the definition and
      // dispatcher drift; keeping a hard failure is safer than a silent no-op.
      throw new Error(`Unsupported MCP tool: ${name}`);
    },
  };
  return context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function response(id: unknown, result: unknown): PlatformMcpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function protocolError(id: unknown, code: number, message: string, data?: unknown): PlatformMcpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Handle one MCP JSON-RPC message. Notifications intentionally return no response. */
export async function handlePlatformMcpRequest(body: unknown, context: PlatformMcpContext): Promise<PlatformMcpJsonRpcResponse | undefined> {
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return protocolError(isRecord(body) && "id" in body ? body.id : null, -32600, "Invalid Request");
  const id = "id" in body ? body.id : undefined;
  if (id === undefined && body.method.startsWith("notifications/")) return undefined;
  if (body.method === "initialize") return response(id ?? null, {
    protocolVersion: PLATFORM_MCP_PROTOCOL_VERSION,
    serverInfo: { name: PLATFORM_MCP_SERVER_NAME, version: PLATFORM_MCP_SERVER_VERSION },
    capabilities: { tools: { listChanged: false } },
  });
  if (body.method === "notifications/initialized") return undefined;
  if (body.method === "ping") return response(id ?? null, {});
  if (body.method === "tools/list") return response(id ?? null, { tools: platformMcpToolDefinitions() });
  if (body.method !== "tools/call") return protocolError(id ?? null, -32601, `Method not found: ${body.method}`);
  if (!isRecord(body.params) || typeof body.params.name !== "string") return protocolError(id ?? null, -32602, "tools/call requires params.name");
  const name = body.params.name;
  const args = isRecord(body.params.arguments) ? body.params.arguments : {};
  try {
    const result = await context.call(name, args);
    return response(id ?? null, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response(id ?? null, { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] });
  }
}

export async function runPlatformMcpStdio(context: PlatformMcpContext, streams: PlatformMcpStdioStreams = { input: process.stdin, output: process.stdout, error: process.stderr }): Promise<void> {
  const input = readline.createInterface({ input: streams.input, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      streams.output.write(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    try {
      const result = await handlePlatformMcpRequest(body, context);
      if (result) streams.output.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      streams.error?.write(`platform MCP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

export const PLATFORM_MCP_HELP = `Tinkerbot platform MCP (stdio)

Usage:
  tinkerbot-mcp [--root PATH]

The server speaks MCP JSON-RPC over stdin/stdout and stores local state in
.tinkerbot/state.sqlite (or TINKERBOT_LOCAL_DB). It exposes the legacy factory
tools plus factory_status, factory_check, intent_create, work_create,
work_list, work_approve, graph_status, and outcome_record.

No stdout logging is emitted so the process can be used directly by an MCP
client. Human approvals and deterministic verification remain authoritative.
`;
