import type { WorkItem } from "./model";

export type DetailView = "overview" | "diff" | "evidence" | "policy" | "run" | "help" | "repositories" | "runs" | "releases";

export function safeText(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function short(value: string | undefined, size = 12): string {
  return value ? value.slice(0, size) : "—";
}

export function detailTitle(view: DetailView): string {
  return ({ overview: "Overview", diff: "Diff", evidence: "Evidence trace", policy: "Policy", run: "Verification run", help: "Help", repositories: "Repositories", runs: "Runs", releases: "Releases" } as Record<DetailView, string>)[view];
}

export function filetypeForPath(file: string | undefined): string | undefined {
  const extension = file?.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", java: "java", rb: "ruby", json: "json", yaml: "yaml", yml: "yaml", md: "markdown" } as Record<string, string | undefined>)[extension ?? ""];
}

export function itemSummary(item: WorkItem | undefined): string {
  if (!item) return "Select a work item to inspect its local evidence.";
  return `${item.glyph} ${item.title}${item.file ? ` · ${item.file}${item.line ? `:${item.line}` : ""}` : ""}`;
}
