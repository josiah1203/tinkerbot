import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { initFactoryTree } from "../packages/factory/src";
import {
  createLocalPlatformMcpContext,
  handlePlatformMcpRequest,
  platformMcpToolDefinitions,
  runPlatformMcpStdio,
} from "../packages/platform-mcp/src";

function temporaryFactoryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-platform-mcp-"));
  for (const file of initFactoryTree(root, "MCP test factory").files) {
    const destination = path.join(root, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.contents, "utf8");
  }
  return root;
}

describe("platform MCP", () => {
  it("exposes MCP initialization and the current factory tool surface", async () => {
    const root = temporaryFactoryRoot();
    const context = createLocalPlatformMcpContext(root);
    const initialized = await handlePlatformMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, context);
    expect(initialized?.result).toMatchObject({ serverInfo: { name: "tinkerbot-platform" }, capabilities: { tools: { listChanged: false } } });

    const listed = await handlePlatformMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context);
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["factory_status", "factory_check", "intent_create", "work_create", "work_approve", "graph_status", "outcome_record"]));
    expect(names).toEqual(platformMcpToolDefinitions().map((tool) => tool.name));
  });

  it("routes intent, work, approval, and graph operations through the local Factory Graph", async () => {
    const root = temporaryFactoryRoot();
    const context = createLocalPlatformMcpContext(root);
    const intent = await context.call("intent_create", { text: "Add an MCP smoke test", mode: "micro" });
    expect(intent).toMatchObject({ created: true, persisted: true });
    const created = await context.call("work_create", { intent: "Add an MCP smoke test" }) as { workOrderId: string };
    expect(created.workOrderId.length).toBeGreaterThan(10);
    const graph = await context.call("graph_status", { aggregateId: created.workOrderId }) as { events: unknown[]; sourceOfTruth: string };
    expect(graph.events.length).toBeGreaterThan(0);
    expect(graph.sourceOfTruth).toBe("append_only_factory_graph");
    const approval = await context.call("work_approve", { workOrderId: created.workOrderId, decision: "approved" }) as { decision: string };
    expect(approval.decision).toBe("approved");
    const status = await context.call("factory_status", {}) as { workOrders: Array<{ workOrderId: string }> };
    expect(status.workOrders.some((order) => order.workOrderId === created.workOrderId)).toBe(true);
  });

  it("keeps MCP factory writes inside the selected repository", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-platform-mcp-new-"));
    const context = createLocalPlatformMcpContext(root);
    await expect(context.call("create_factory", {
      name: "safe factory",
      yaml: "schemaVersion: v1alpha1\nname: safe factory\n",
      files: [{ path: "../outside.txt", contents: "must not be written" }],
    })).rejects.toThrow(/escapes the repository root/);
    expect(fs.existsSync(path.join(root, ".tinkerbot", "factory.yaml"))).toBe(false);
  });

  it("speaks newline-delimited JSON-RPC on stdio without logging to stdout", async () => {
    const root = temporaryFactoryRoot();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`]);
    await runPlatformMcpStdio(createLocalPlatformMcpContext(root), { input, output });
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
