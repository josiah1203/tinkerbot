import { suggestSlash } from "./commands";
import type { Block, Session, StageStatus } from "./types";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";

export interface RenderOptions {
  columns?: number;
  color?: boolean;
  showPrompt?: boolean;
}

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let remaining = paragraph;
    while (remaining.length > width) {
      const slice = remaining.slice(0, width);
      const breakAt = slice.lastIndexOf(" ");
      const take = breakAt > width / 2 ? breakAt : width;
      lines.push(remaining.slice(0, take).trimEnd());
      remaining = remaining.slice(take).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

function box(lines: string[], width: number, prefix = ""): string[] {
  const inner = Math.max(10, width - 2);
  const content = lines.flatMap((line) => wrap(line, inner - 2));
  const top = `╭${"─".repeat(inner)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  return [top, ...content.map((line) => `│ ${line.padEnd(inner - 2, " ")} │`), bottom].map((line) => `${prefix}${line}`);
}

function toolMark(status: StageStatus, color: boolean): string {
  if (status === "running") return paint(color, CYAN, "⏺");
  if (status === "locked" || status === "skipped") return paint(color, DIM, "○");
  if (status === "error") return paint(color, RED, "⏺");
  return paint(color, CYAN, "⏺");
}

function renderTool(block: Extract<Block, { kind: "tool" }>, color: boolean): string[] {
  const hint = block.hint ? `(${block.hint})` : "";
  const title = block.name.includes("(") ? block.name : `${block.name}${hint}`;
  const lines = [`${toolMark(block.status, color)} ${paint(color, BOLD, title)}`];
  const results = block.result.length ? block.result : block.status === "running" ? ["…"] : [];
  for (const [index, line] of results.entries()) {
    const branch = index === results.length - 1 ? "⎿" : "│";
    lines.push(`  ${paint(color, DIM, `${branch}  ${line}`)}`);
  }
  return lines;
}

function verdictTone(text: string, color: boolean): string {
  if (/\bPASS\b/.test(text)) return paint(color, GREEN, text);
  if (/\bFAIL\b/.test(text)) return paint(color, RED, text);
  if (/\bUNKNOWN\b/.test(text)) return paint(color, YELLOW, text);
  return text;
}

export function renderSession(session: Session, options: RenderOptions = {}): string {
  const columns = Math.max(40, Math.min(options.columns ?? 80, 100));
  const color = Boolean(options.color);
  const lines: string[] = [];
  const mode = session.mode === "work" ? `work ${session.workOrderId ?? ""}`.trim() : "local";
  lines.push(paint(color, BOLD, `Tinkerbot  ${session.version}`));
  lines.push(paint(color, DIM, `${mode} · ${session.repo} · ${session.base}...${session.head}`));
  lines.push("");
  for (const block of session.blocks) {
    if (block.kind === "user") {
      lines.push(...box([`❯ ${block.text}`], columns));
      lines.push("");
    } else if (block.kind === "assistant") {
      for (const line of wrap(block.text, columns - 2)) lines.push(`  ${line}`);
      lines.push("");
    } else {
      const rendered = renderTool(block, color);
      lines.push(block.id === "verdict" ? verdictTone(rendered[0] ?? "", color) : rendered[0] ?? "");
      lines.push(...rendered.slice(1));
      lines.push("");
    }
  }
  if (options.showPrompt) {
    const suggestions = suggestSlash(session.input);
    if (suggestions.length && session.input.startsWith("/")) {
      for (const suggestion of suggestions.slice(0, 6)) lines.push(paint(color, DIM, `  ${suggestion.name.padEnd(16)}${suggestion.summary}`));
      lines.push("");
    }
    lines.push(...box([`❯ ${session.input}`], columns));
    lines.push(paint(color, DIM, session.busy ? "  esc to interrupt" : "  / for commands"));
  }
  return `${lines.join("\n")}\n`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
