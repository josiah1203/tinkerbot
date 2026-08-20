import { createReport, mainAsync } from "./index";
import { localFactoryGraphStatusPayload } from "./factory-os";
import { defaultLocalDbPath, formatCostTab, formatEvalTab, formatPlanTab, SqliteFactoryStore } from "../../local-runtime/src";
import { localDashboardPayload } from "./runtime-cli";
import { runKitWorkstationInteractive, runKitWorkstationOnce, type KitWorkstationDeps } from "../../tui/src";
import { mainSelfHostedWorker } from "./self-hosted-worker-cli";

export const FACTORY_CLI_HELP = `Tinkerbot Factory CLI

This is the separately installable factory/operator entrypoint. It shares the
current command implementation with tb so factory, graph, outcome, evidence,
runtime, and verification functions do not drift between clients.

Usage:
  tinkerbot-factory <tb command>       run any current Tinkerbot command
  tinkerbot-factory tui                open the kit-based workstation
  tinkerbot-factory mcp serve          run the platform MCP over stdio
  tinkerbot-factory worker --help      run one signed self-hosted harness dispatch

Examples:
  tinkerbot-factory factory status <work-order-id>
  tinkerbot-factory work graph <work-order-id>
  tinkerbot-factory outcome record --work-order <id> --outcome-status POSITIVE --mature
`;

export async function mainFactoryCli(argv = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(FACTORY_CLI_HELP);
    return 0;
  }
  if (argv[0] === "tui") {
    const cwd = process.cwd();
    const deps: KitWorkstationDeps = {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      cwd,
      env: process.env,
      header: () => ({ repo: cwd, base: "origin/main", head: "HEAD" }),
      createReport: () => {
        const report = createReport({ cwd, command: "check" });
        return { verdict: report.verdict, limitations: report.limitations };
      },
      fetchWork: (id) => {
        const order = new SqliteFactoryStore(defaultLocalDbPath(cwd)).orders.get(id);
        if (!order) return { verdict: "UNKNOWN", summary: `Work order ${id} was not found in local state.` };
        const graph = localFactoryGraphStatusPayload(cwd, id);
        const state = graph.state as { verificationVerdict?: string };
        return { verdict: state.verificationVerdict ?? order.verificationVerdict, summary: JSON.stringify({ workOrder: order, graph: state }, null, 2) };
      },
      localGraph: (id) => JSON.stringify(localFactoryGraphStatusPayload(cwd, id), null, 2),
      localRuntime: () => {
        const view = localDashboardPayload(cwd);
        return { plan: formatPlanTab(view), cost: formatCostTab(view), eval: formatEvalTab(view) };
      },
    };
    const once = argv.includes("--once") || !process.stdout.isTTY || !process.stdin.isTTY;
    const help = argv.includes("--help") || argv.includes("-h");
    const workOrderId = argv[1] === "work" ? argv[2] : undefined;
    const agent = argv[1] === "--agent" ? argv[2] as "claude" | "gemini" | "codex" | "cursor" | "shell" : undefined;
    return once ? runKitWorkstationOnce({ workOrderId, agent, help }, deps) : runKitWorkstationInteractive({ workOrderId, agent, help }, deps);
  }
  if (argv[0] === "mcp" && argv[1] === "serve") {
    const { mainPlatformMcp } = await import("../../platform-mcp/src/cli");
    return mainPlatformMcp(argv.slice(2));
  }
  if (argv[0] === "worker") return mainSelfHostedWorker(argv.slice(1));
  return mainAsync(argv);
}

if (require.main === module) void mainFactoryCli().then((code) => { process.exitCode = code; });
