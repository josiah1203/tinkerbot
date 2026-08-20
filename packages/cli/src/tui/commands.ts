import type { Intent } from "./types";

export const SLASH_COMMANDS: Array<{ name: string; summary: string; hidden?: boolean }> = [
  { name: "/check", summary: "Run local tb check. Configured suite is the gate." },
  { name: "/impact", summary: "Show the impact graph without rewriting the verdict." },
  { name: "/select-tests", summary: "Recommendation only. Never skips required tests." },
  { name: "/work", summary: "Attach a hosted work-order run." },
  { name: "/steer", summary: "Steer the attached work order." },
  { name: "/take", summary: "Take the work-cell lease." },
  { name: "/return", summary: "Return the work-cell lease." },
  { name: "/approve", summary: "Approve specification only. Humans merge." },
  { name: "/plan", summary: "Show the local execution plan. Not a verdict." },
  { name: "/cost", summary: "Show your BYOK provider spend. Tinkerbot invoices seats only." },
  { name: "/eval", summary: "Show portable eval compare. Cannot upgrade tb check." },
  { name: "/graph", summary: "Show the append-only Factory Graph for a local work order." },
  { name: "/dashboard", summary: "Open the browser control tower." },
  { name: "/clear", summary: "Clear the transcript." },
  { name: "/help", summary: "Show commands." },
  { name: "/exit", summary: "Leave the session." },
];

const FORBIDDEN: Record<string, string> = {
  merge: "The TUI cannot merge. Humans merge after tb check.",
  pass: "The TUI cannot write PASS. tb check is the only verdict.",
  fail: "The TUI cannot rewrite a verdict.",
  "approve-verdict": "The TUI cannot approve a verification verdict.",
};

export function suggestSlash(input: string): Array<{ name: string; summary: string }> {
  const prefix = input.trim().toLowerCase();
  if (!prefix.startsWith("/")) return [];
  return SLASH_COMMANDS.filter((command) => !command.hidden && command.name.startsWith(prefix));
}

export function parseIntent(line: string): Intent {
  const trimmed = line.trim();
  if (!trimmed) return { type: "none" };
  const slash = trimmed.startsWith("/") ? trimmed.slice(1) : undefined;
  const [rawCommand, ...rest] = (slash ?? trimmed).split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();
  if (slash !== undefined) {
    const forbidden = FORBIDDEN[command];
    if (forbidden) return { type: "reject", command: `/${command}`, reason: forbidden };
    if (command === "check") return { type: "check" };
    if (command === "impact") return { type: "impact" };
    if (command === "select-tests" || command === "select") return { type: "select-tests" };
    if (command === "work") {
      if (!argument) return { type: "reject", command: "/work", reason: "/work requires a work-order id." };
      return { type: "work", id: argument.split(/\s+/)[0]! };
    }
    if (command === "steer") return { type: "steer", text: argument };
    if (command === "take") return { type: "take" };
    if (command === "return") return { type: "return" };
    if (command === "approve") return { type: "approve" };
    if (command === "dashboard") return { type: "dashboard" };
    if (command === "plan") return { type: "plan" };
    if (command === "cost") return { type: "cost" };
    if (command === "eval") return { type: "eval" };
    if (command === "graph") {
      if (!argument) return { type: "reject", command: "/graph", reason: "/graph requires a work-order id." };
      return { type: "graph", id: argument.split(/\s+/)[0]! };
    }
    if (command === "clear") return { type: "clear" };
    if (command === "help") return { type: "help" };
    if (command === "exit" || command === "quit") return { type: "exit" };
    return { type: "reject", command: `/${command}`, reason: `Unknown command /${command}. Type /help.` };
  }
  if (/^(check|verify|tb check|run check|run verification)$/i.test(trimmed)) return { type: "check" };
  if (/^(impact|show impact)$/i.test(trimmed)) return { type: "impact" };
  if (/^(select-tests|select tests)$/i.test(trimmed)) return { type: "select-tests" };
  if (/^(help|\?)$/i.test(trimmed)) return { type: "help" };
  if (/^(exit|quit)$/i.test(trimmed)) return { type: "exit" };
  if (/^@tinker\b/i.test(trimmed)) {
    return { type: "reject", command: trimmed, reason: "@tinker is the GitHub/Slack/Jira/Linear handle, not this terminal. Use /check or /help." };
  }
  return {
    type: "reject",
    command: trimmed,
    reason: "This is a verification session, not a coding agent. Try /check, /work <id>, or /help.",
  };
}

export function helpText(): string {
  return [
    "Verification session. tb check is the only verdict. Agents cannot merge.",
    ...SLASH_COMMANDS.map((command) => `${command.name.padEnd(16)}${command.summary}`),
  ].join("\n");
}
