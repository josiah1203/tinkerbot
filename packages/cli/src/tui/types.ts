import type { TestSelectionPlan, Verdict } from "../../../core/src/types";

export type StreamId = "impact" | "select" | "subset" | "integrity" | "suite" | "coverage" | "mutation" | "fixtures" | "verdict";

export type StreamRole = "analysis" | "recommendation" | "early_signal" | "authoritative" | "optional" | "verdict";

export interface StreamSpec {
  id: StreamId;
  /** Claude Code-style tool title, e.g. Bash(pnpm test --run). */
  label: string;
  role: StreamRole;
  feedsVerdict: boolean;
  enabled: boolean;
  locked: boolean;
  lockReason?: string;
}

export interface StreamFlags {
  runBaseTests: boolean;
  runMutation: boolean;
  watchSubset: boolean;
  coverageConfigured: boolean;
  fixturesEnabled: boolean;
  testCommand: string;
}

export type StageStatus = "running" | "done" | "locked" | "error" | "skipped";

export interface StageEvent {
  type: "stage_start" | "stage_log" | "stage_end";
  id: string;
  label?: string;
  chunk?: string;
  status?: StageStatus;
  summary?: string;
  feedsVerdict?: boolean;
}

export interface TuiOptions {
  help?: boolean;
  subcommand?: string;
  positional?: string;
  once?: boolean;
  base?: string;
  head?: string;
  config?: string;
  mutation?: boolean;
  baseTests: boolean;
  mode?: "advisory" | "blocking";
  failOn?: string[];
  mutationMax?: number;
  policy?: string;
  timeout?: number;
  maxFiles?: number;
  maxFindings?: number;
  agent?: string;
}

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; hint?: string; status: StageStatus; result: string[]; feedsVerdict?: boolean };

export interface Session {
  repo: string;
  base: string;
  head: string;
  mode: "local" | "work";
  workOrderId?: string;
  version: string;
  blocks: Block[];
  input: string;
  busy: boolean;
  lastVerdict?: Verdict;
  selection?: TestSelectionPlan;
}

export type Intent =
  | { type: "none" }
  | { type: "check" }
  | { type: "impact" }
  | { type: "select-tests" }
  | { type: "work"; id: string }
  | { type: "steer"; text: string }
  | { type: "take" }
  | { type: "return" }
  | { type: "approve" }
  | { type: "dashboard" }
  | { type: "plan" }
  | { type: "cost" }
  | { type: "eval" }
  | { type: "clear" }
  | { type: "help" }
  | { type: "exit" }
  | { type: "reject"; command: string; reason: string };
