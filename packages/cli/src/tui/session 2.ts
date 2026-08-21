import type { Verdict } from "../../../core/src/types";
import { helpText, parseIntent } from "./commands";
import type { Block, Intent, Session, StageEvent, StageStatus } from "./types";

const WELCOME = "Verification session. I run tb check; I do not write verdicts or merge.\nSelected tests are an early signal. Type /check or /help.";

export function createSession(input: { repo: string; base: string; head: string; version: string; mode?: "local" | "work" }): Session {
  return {
    repo: input.repo,
    base: input.base,
    head: input.head,
    mode: input.mode ?? "local",
    version: input.version,
    blocks: [{ kind: "assistant", text: WELCOME }],
    input: "",
    busy: false,
  };
}

export function submitLine(session: Session): { session: Session; intent: Intent } {
  const text = session.input;
  const intent = parseIntent(text);
  let next: Session = { ...session, input: "", blocks: [...session.blocks, { kind: "user", text: text.trim() }] };
  if (intent.type === "none") return { session: { ...session, input: "" }, intent };
  if (intent.type === "clear") return { session: { ...next, blocks: [{ kind: "assistant", text: WELCOME }] }, intent };
  if (intent.type === "help") return { session: appendAssistant(next, helpText()), intent };
  if (intent.type === "reject") return { session: appendAssistant(next, intent.reason), intent };
  return { session: next, intent };
}

export function appendAssistant(session: Session, text: string): Session {
  return { ...session, blocks: [...session.blocks, { kind: "assistant", text }] };
}

export function applyStageEvent(session: Session, event: StageEvent): Session {
  if (event.type === "stage_start") {
    const tool: Block = { kind: "tool", id: event.id, name: event.label ?? event.id, status: "running", result: [], feedsVerdict: event.feedsVerdict };
    return { ...session, busy: true, blocks: [...session.blocks, tool] };
  }
  const index = [...session.blocks].reverse().findIndex((block) => block.kind === "tool" && block.id === event.id);
  if (index < 0) return session;
  const actual = session.blocks.length - 1 - index;
  const current = session.blocks[actual];
  if (!current || current.kind !== "tool") return session;
  const result = event.chunk ? [...current.result, event.chunk] : current.result;
  const status: StageStatus = event.type === "stage_log" ? current.status : event.status ?? "done";
  const summary = event.summary && event.type === "stage_end" ? [...result, event.summary] : result;
  const blocks = session.blocks.slice();
  blocks[actual] = { ...current, status, result: summary, feedsVerdict: event.feedsVerdict ?? current.feedsVerdict };
  const busy = event.type === "stage_end" ? session.blocks.some((block, position) => position !== actual && block.kind === "tool" && block.status === "running") : true;
  return { ...session, blocks, busy };
}

export function setVerdict(session: Session, verdict: Verdict, detail: string): Session {
  const withEvent = applyStageEvent(applyStageEvent(session, { type: "stage_start", id: "verdict", label: "Verdict", feedsVerdict: true }), { type: "stage_end", id: "verdict", status: "done", summary: `${verdict}\n${detail}`, feedsVerdict: true });
  return { ...withEvent, lastVerdict: verdict, busy: false };
}

export function handleKey(session: Session, key: string): { session: Session; submit?: boolean; exit?: boolean } {
  if (key === "\u0003") {
    if (session.input) return { session: { ...session, input: "" } };
    return { session, exit: true };
  }
  if (key === "\u0004") return { session, exit: !session.input };
  if (key === "\u001b") return { session: { ...session, input: session.busy ? session.input : "" } };
  if (key === "\r" || key === "\n") return { session, submit: Boolean(session.input.trim()) && !session.busy };
  if (key === "\u007f" || key === "\b") return { session: { ...session, input: session.input.slice(0, -1) } };
  if (session.busy) return { session };
  if (key.length === 1 && key >= " ") return { session: { ...session, input: `${session.input}${key}` } };
  return { session };
}
