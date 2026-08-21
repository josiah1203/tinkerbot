import { createReport } from "./index";
import { localFactoryGraphStatusPayload } from "./factory-os";
import { defaultLocalDbPath, formatCostTab, formatEvalTab, formatPlanTab, SqliteFactoryStore } from "../../local-runtime/src";
import { localDashboardPayload } from "./runtime-cli";
import { runKitWorkstationInteractive, runKitWorkstationOnce, type KitWorkstationDeps } from "../../tui/src";

export async function mainWorkstationCli(argv = process.argv.slice(2)): Promise<number> {
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
  const workOrderId = argv[0] === "work" ? argv[1] : undefined;
  const agent = argv[0] === "--agent" ? argv[1] as "claude" | "gemini" | "codex" | "cursor" | "shell" : undefined;
  return once ? runKitWorkstationOnce({ workOrderId, agent, help }, deps) : runKitWorkstationInteractive({ workOrderId, agent, help }, deps);
}

if (require.main === module) void mainWorkstationCli().then((code) => { process.exitCode = code; });
