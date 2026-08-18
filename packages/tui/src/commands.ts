export type TuiDetailTarget = "diff" | "evidence" | "policy" | "help";

export type TuiCommand =
  | { kind: "empty" }
  | { kind: "filter"; query: string }
  | { kind: "rerun" }
  | { kind: "detail"; view: TuiDetailTarget }
  | { kind: "export-evidence" }
  | { kind: "export-report"; format: "json" | "markdown" | "sarif" }
  | { kind: "export-receipt" }
  | { kind: "repository"; root: string }
  | { kind: "github" }
  | { kind: "clear" };

export function parseTuiCommand(value: string): TuiCommand {
  const command = value.trim();
  if (!command) return { kind: "empty" };
  if (command.startsWith("/")) return { kind: "filter", query: command.slice(1) };
  const normalized = command.startsWith(":") ? command.slice(1).trim().toLowerCase() : command.toLowerCase();
  if (["r", "rerun", "run", "verify"].includes(normalized)) return { kind: "rerun" };
  if (["d", "diff"].includes(normalized)) return { kind: "detail", view: "diff" };
  if (["e", "evidence"].includes(normalized)) return { kind: "detail", view: "evidence" };
  if (["p", "policy", "config"].includes(normalized)) return { kind: "detail", view: "policy" };
  if (normalized === "export-evidence") return { kind: "export-evidence" };
  if (normalized === "export markdown") return { kind: "export-report", format: "markdown" };
  if (normalized === "export sarif") return { kind: "export-report", format: "sarif" };
  if (normalized === "export json") return { kind: "export-report", format: "json" };
  if (["x", "export", "receipt"].includes(normalized)) return { kind: "export-receipt" };
  if (normalized.startsWith("repo ") || normalized.startsWith("repository ")) return { kind: "repository", root: command.replace(/^:?\s*(repo|repository)\s+/i, "").trim() };
  if (["github", "open", "o"].includes(normalized)) return { kind: "github" };
  if (["help", "?"].includes(normalized)) return { kind: "detail", view: "help" };
  if (normalized === "clear") return { kind: "clear" };
  return { kind: "filter", query: command };
}

export interface TuiCommandHandlers {
  filter(query: string): void;
  rerun(): void;
  detail(view: TuiDetailTarget): void;
  exportEvidence(): void;
  exportReport(format: "json" | "markdown" | "sarif"): void;
  exportReceipt(): void;
  repository(root: string): void;
  repositoryUnavailable(): void;
  github(): void;
  clear(): void;
}

export function executeTuiCommand(command: TuiCommand, handlers: TuiCommandHandlers): void {
  if (command.kind === "empty") return;
  if (command.kind === "filter") return handlers.filter(command.query);
  if (command.kind === "rerun") return handlers.rerun();
  if (command.kind === "detail") return handlers.detail(command.view);
  if (command.kind === "export-evidence") return handlers.exportEvidence();
  if (command.kind === "export-report") return handlers.exportReport(command.format);
  if (command.kind === "export-receipt") return handlers.exportReceipt();
  if (command.kind === "repository") return command.root ? handlers.repository(command.root) : handlers.repositoryUnavailable();
  if (command.kind === "github") return handlers.github();
  return handlers.clear();
}
