import { executeTuiCommand, parseTuiCommand, type TuiCommandHandlers } from "./commands";

test("parses every documented TUI command without terminal-keymap assumptions", () => {
  expect(parseTuiCommand("")).toEqual({ kind: "empty" });
  expect(parseTuiCommand("/auth")).toEqual({ kind: "filter", query: "auth" });
  expect(parseTuiCommand("r")).toEqual({ kind: "rerun" });
  expect(parseTuiCommand(":diff")).toEqual({ kind: "detail", view: "diff" });
  expect(parseTuiCommand("evidence")).toEqual({ kind: "detail", view: "evidence" });
  expect(parseTuiCommand("config")).toEqual({ kind: "detail", view: "policy" });
  expect(parseTuiCommand("help")).toEqual({ kind: "detail", view: "help" });
  expect(parseTuiCommand("export-evidence")).toEqual({ kind: "export-evidence" });
  expect(parseTuiCommand("export markdown")).toEqual({ kind: "export-report", format: "markdown" });
  expect(parseTuiCommand("export sarif")).toEqual({ kind: "export-report", format: "sarif" });
  expect(parseTuiCommand("export json")).toEqual({ kind: "export-report", format: "json" });
  expect(parseTuiCommand("receipt")).toEqual({ kind: "export-receipt" });
  expect(parseTuiCommand(":repository /tmp/worktree")).toEqual({ kind: "repository", root: "/tmp/worktree" });
  expect(parseTuiCommand("repo")).toEqual({ kind: "filter", query: "repo" });
  expect(parseTuiCommand("open")).toEqual({ kind: "github" });
  expect(parseTuiCommand("clear")).toEqual({ kind: "clear" });
  expect(parseTuiCommand("customer-facing query")).toEqual({ kind: "filter", query: "customer-facing query" });
});

test("executes every command through explicit UI handlers", () => {
  const events: string[] = [];
  const handlers: TuiCommandHandlers = {
    filter: (value) => events.push(`filter:${value}`),
    rerun: () => events.push("rerun"),
    detail: (value) => events.push(`detail:${value}`),
    exportEvidence: () => events.push("evidence"),
    exportReport: (value) => events.push(`report:${value}`),
    exportReceipt: () => events.push("receipt"),
    repository: (value) => events.push(`repository:${value}`),
    repositoryUnavailable: () => events.push("repository-unavailable"),
    github: () => events.push("github"),
    clear: () => events.push("clear"),
  };
  const commands = ["", "/auth", "rerun", "diff", "evidence", "policy", "help", "export-evidence", "export markdown", "export sarif", "export json", "export", "repository /tmp/worktree", "github", "clear", "unrecognized"];
  for (const command of commands) executeTuiCommand(parseTuiCommand(command), handlers);
  executeTuiCommand({ kind: "repository", root: "" }, handlers);
  expect(events).toEqual([
    "filter:auth", "rerun", "detail:diff", "detail:evidence", "detail:policy", "detail:help", "evidence", "report:markdown", "report:sarif", "report:json", "receipt", "repository:/tmp/worktree", "github", "clear", "filter:unrecognized", "repository-unavailable",
  ]);
});
