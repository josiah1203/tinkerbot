import type { MasterState } from "./tabs";
import { renderMasterChrome } from "./chrome";

/** claude-code-kit UI contract. Do not import @claude-code-kit/agent into core, Action, or Workers. */
export const CLAUDE_CODE_KIT_PACKAGES = ["@claude-code-kit/ui", "@claude-code-kit/ink-renderer"] as const;
export const CLAUDE_CODE_KIT_FORBIDDEN = ["@claude-code-kit/agent"] as const;

export const KIT_COMMANDS = [
  { name: "check", description: "Run tb check. Authoritative verification." },
  { name: "work", description: "Attach a work order." },
  { name: "plan", description: "Show the local execution plan." },
  { name: "cost", description: "Show BYOK spend. Seats only on the invoice." },
  { name: "eval", description: "Advisory evals. Cannot upgrade tb check." },
  { name: "factory", description: "Inspect factory definition." },
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
  const chrome = renderMasterChrome(state, body);
  return `kit:ui+ink-renderer (not @claude-code-kit/agent)\n${chrome}`;
}

export function tuiRejectsTinkerMention(line: string): boolean {
  return /^@tinker\b/i.test(line.trim());
}
