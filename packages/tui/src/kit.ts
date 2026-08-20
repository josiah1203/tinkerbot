import type { MasterState } from "./tabs";

/** claude-code-kit UI contract. Do not import @claude-code-kit/agent into core, Action, or Workers. */
export const CLAUDE_CODE_KIT_PACKAGES = ["@claude-code-kit/ui", "@claude-code-kit/ink-renderer"] as const;
export const CLAUDE_CODE_KIT_FORBIDDEN = ["@claude-code-kit/agent"] as const;

export const KIT_COMMANDS = [
  { name: "check", description: "Run tb check. Authoritative verification." },
  { name: "work", description: "Attach a work order." },
  { name: "graph", description: "Inspect an append-only Factory Graph projection." },
  { name: "plan", description: "Show the local execution plan." },
  { name: "cost", description: "Show BYOK spend. Seats only on the invoice." },
  { name: "eval", description: "Advisory evals. Cannot upgrade tb check." },
  { name: "factory", description: "Inspect factory definition." },
  { name: "dashboard", description: "Open the control-plane dashboard." },
  { name: "tab", description: "Switch or close an underlying workstation tab." },
  { name: "claude", description: "Open the user-owned Claude CLI." },
  { name: "gemini", description: "Open the user-owned Gemini CLI." },
  { name: "codex", description: "Open the user-owned Codex CLI." },
  { name: "cursor", description: "Open the user-owned Cursor CLI." },
  { name: "shell", description: "Open the user-owned shell." },
  { name: "help", description: "Show master commands." },
  { name: "exit", description: "Leave the session." },
];

export function kitStatusSegments(state: MasterState): Array<{ content: string }> {
  return [
    { content: "customer-worker" },
    { content: state.lastVerdict ?? "no-verdict" },
    { content: state.repo },
  ];
}

export function renderKitWorkstation(state: MasterState, body?: string): string {
  // Keep this older public helper on the same visual contract as the live
  // workstation. The lazy import avoids a module cycle because the fallback
  // renderer also reads KIT_COMMANDS from this contract module.
  const { renderKitWorkstationFrame } = require("./workstation") as typeof import("./workstation");
  return renderKitWorkstationFrame({
    master: state,
    kit: {
      root: "",
      packages: CLAUDE_CODE_KIT_PACKAGES,
      rendererEntry: "",
      uiEntry: "",
      ready: false,
      reason: "fallback",
    },
    input: "",
    cursor: 0,
    suggestionIndex: 0,
    messages: [],
  }, body);
}

export function tuiRejectsTinkerMention(line: string): boolean {
  return /^@tinker\b/i.test(line.trim());
}
