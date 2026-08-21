import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildFactoryStarter } from "./starter";
import { createWorkerEnvelope } from "./authority";
import { assertFactoryTreeIntegrity, factoryTreeDigestFromFiles, semanticFactoryTreePath } from "./tree-integrity";

type FactoryStageId = "foreman" | "triage" | "specification" | "architecture" | "implementation" | "review" | "verification" | "release" | "test" | "security" | "outcome";
type WorkOrderState = "intake" | "triage" | "specification" | "implementation" | "review" | "verification" | "approval" | "ready" | "merged" | "released" | "blocked" | "failed" | "cancelled" | "unknown";

interface FactoryAgentDefinition {
  id: string;
  model: string;
  provider: "workers-ai" | "gateway" | "none";
  harness: string;
  timeoutSeconds: number;
}

interface FactoryAi {
  run(model: string, input: { messages: Array<{ role: string; content: string }> }, options?: { gateway?: { id: string; collectLog?: boolean; metadata?: Record<string, string> } }): Promise<{ response?: string }>;
}

interface FactoryQueueMessage {
  deliveryId: string;
  installationId?: number;
  organizationId?: string;
  repository?: string;
  sourceType: FactoryIntakeSource;
  sourceId: string;
  issueOrPullRequest?: string;
  sha?: string;
  actor: string;
}

interface WorkOrder {
  workOrderId: string;
  status: WorkOrderState;
  repositoryId: string;
}

function sanitizeUntrustedPromptInput(value: string, limit = 8_000): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,})/gi, "[redacted]")
    .slice(0, limit);
}

export const AI_GATEWAY_ID = "tinkerbot-factory";
export const EXHAUST_PREFIX = "org";
export const IMPLEMENT_BRANCH_PREFIX = "tinkerbot/";
export const DEFAULT_MODELS = {
  foreman: "@cf/openai/gpt-oss-120b",
  specification: "@cf/openai/gpt-oss-120b",
  review: "@cf/openai/gpt-oss-120b",
  triage: "@cf/zhipuai/glm-4.7-flash",
  implement: "@cf/zhipuai/glm-5.2",
  implementFallback: "@cf/qwen/qwen2.5-coder-32b-instruct",
  computerUse: "@cf/meta/llama-4-scout-17b-16e-instruct",
  embedding: "@cf/qwen/qwen3-embedding-0.6b",
} as const;

export type FactoryHarness = "tinkerbot-sandbox" | "github_actions" | "none" | "default";
export type FactoryIntakeSource =
  | "github_issue"
  | "github_pull_request"
  | "manual"
  | "mcp"
  | "slack"
  | "linear"
  | "jira"
  | "github_dependabot"
  | "github_code_scanning"
  | "github_secret_scanning"
  | "incident"
  | "support"
  | "roadmap"
  | "scheduled"
  | "gitlab_issue"
  | "gitlab_merge_request";
export type ForemanToolName = "skip_stage" | "ask_human" | "continue_conversation" | "spawn_agent" | "dispatch_sandbox" | "dispatch_verify" | "request_revision";
export type FactoryWait = "spec_approval" | "sandbox" | "self_hosted_harness" | "factory_definition" | "oidc_ingest" | "revision" | "human_merge";
export type ActivityColumn = "triage" | "planning" | "building" | "reviewing" | "blocked" | "done";

export const FOREMAN_TOOLS: readonly ForemanToolName[] = ["skip_stage", "ask_human", "continue_conversation", "spawn_agent", "dispatch_sandbox", "dispatch_verify", "request_revision"];
export const FACTORY_MCP_TOOLS = ["send_task", "get_task", "message_foreman", "get_conversation", "create_factory"] as const;
export const INTAKE_SOURCES: readonly FactoryIntakeSource[] = ["github_issue", "github_pull_request", "manual", "mcp", "slack", "linear", "jira", "github_dependabot", "github_code_scanning", "github_secret_scanning", "incident", "support", "roadmap", "scheduled", "gitlab_issue", "gitlab_merge_request"];

export function defaultModelForAgent(id: string): string {
  if (id === "triage") return DEFAULT_MODELS.triage;
  if (id === "implement" || id === "implementation") return DEFAULT_MODELS.implement;
  if (id === "computer-use") return DEFAULT_MODELS.computerUse;
  return DEFAULT_MODELS.foreman;
}

export function workersAiGatewayOptions(metadata: { workOrderId?: string; stage?: string; factoryId?: string; organizationId?: string }): { gateway: { id: string; collectLog: true; metadata: Record<string, string> } } {
  return {
    gateway: {
      id: AI_GATEWAY_ID,
      collectLog: true,
      metadata: Object.fromEntries(Object.entries({ workOrderId: metadata.workOrderId, stage: metadata.stage, factoryId: metadata.factoryId, organizationId: metadata.organizationId }).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    },
  };
}

export function exhaustObjectKey(organizationId: string, workOrderId: string, kind: "transcript" | "eval" | "screenshot" | "sandbox-log"): string {
  return `${EXHAUST_PREFIX}/${organizationId}/exhaust/${workOrderId}/${kind}.json`;
}

export interface ForemanAction {
  tool: ForemanToolName;
  stage?: FactoryStageId;
  reason: string;
  agentId?: string;
}

export interface ForemanDecision {
  actions: ForemanAction[];
  skip: FactoryStageId[];
  askHuman: boolean;
  dispatchSandbox: boolean;
  dispatchVerify: boolean;
  requestRevision: boolean;
  summary: string;
}

export function planForemanActions(input: {
  sourceType: FactoryIntakeSource;
  untrustedText?: string;
  specApproved?: boolean;
  sandboxComplete?: boolean;
  pullRequestSha?: string;
  verificationIngested?: boolean;
  verificationVerdict?: string;
  reviewRequestsRevision?: boolean;
  forceSkipSpec?: boolean;
  forbidSkip?: boolean;
}): ForemanDecision {
  const skip: FactoryStageId[] = [];
  const localized = input.forceSkipSpec === true || /\b(typo|nits?|docs?|readme|changelog)\b/i.test(input.untrustedText ?? "") || input.sourceType === "github_pull_request" && (input.untrustedText ?? "").length < 80;
  if (localized && input.forbidSkip !== true) skip.push("specification");
  const askHuman = !input.specApproved && !skip.includes("specification");
  const actions: ForemanAction[] = [];
  for (const stage of skip) actions.push({ tool: "skip_stage", stage, reason: "Request is already bounded." });
  if (askHuman) actions.push({ tool: "ask_human", stage: "specification", reason: "Spec approval is required before sandbox implement." });
  if (input.reviewRequestsRevision) actions.push({ tool: "request_revision", stage: "implementation", reason: "Review requested another implement pass." });
  else if (input.specApproved || skip.includes("specification")) actions.push({ tool: "dispatch_sandbox", stage: "implementation", reason: "Spec is approved or skipped." });
  if (input.sandboxComplete && input.pullRequestSha) actions.push({ tool: "dispatch_verify", stage: "verification", reason: "PR SHA exists; tb check is the verdict authority." });
  if (!input.verificationIngested) actions.push({ tool: "continue_conversation", stage: "verification", reason: "Waiting for Action OIDC ingest." });
  return {
    actions,
    skip,
    askHuman,
    dispatchSandbox: actions.some((action) => action.tool === "dispatch_sandbox"),
    dispatchVerify: actions.some((action) => action.tool === "dispatch_verify"),
    requestRevision: Boolean(input.reviewRequestsRevision),
    summary: actions.map((action) => action.tool).join(",") || "continue_conversation",
  };
}

export async function runForemanAgent(ai: FactoryAi | undefined, agent: FactoryAgentDefinition | undefined, input: Parameters<typeof planForemanActions>[0] & { workOrderId: string; factoryId: string }): Promise<ForemanDecision> {
  const fallback = planForemanActions(input);
  if (!ai || !agent || agent.provider === "none") return fallback;
  try {
    const result = await ai.run(agent.model, {
      messages: [
        { role: "system", content: "You are the Tinkerbot factory Foreman. Choose tools: skip_stage, ask_human, continue_conversation, spawn_agent, dispatch_sandbox, dispatch_verify, request_revision. Never merge. Never change a tb check verdict. Never skip verification. Reply as JSON {\"actions\":[{\"tool\":\"...\",\"stage\":\"...\",\"reason\":\"...\"}]}." },
        { role: "user", content: sanitizeUntrustedPromptInput(JSON.stringify({ sourceType: input.sourceType, text: input.untrustedText, specApproved: input.specApproved, sandboxComplete: input.sandboxComplete, sha: input.pullRequestSha, ingested: input.verificationIngested, verdict: input.verificationVerdict })) },
      ],
    }, workersAiGatewayOptions({ workOrderId: input.workOrderId, stage: "foreman", factoryId: input.factoryId }));
    const parsed = parseForemanModelOutput(typeof result.response === "string" ? result.response : "");
    if (!parsed) return { ...fallback, summary: `${fallback.summary}; model_unparsed` };
    if (parsed.skip.includes("verification") || parsed.actions.some((action) => action.stage === "verification" && action.tool === "skip_stage")) {
      return { ...fallback, summary: "Foreman attempted to skip verification; ignored." };
    }
    return parsed;
  } catch {
    return { ...fallback, summary: "Foreman model failed; used fail-closed heuristics." };
  }
}

export function parseForemanModelOutput(text: string): ForemanDecision | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[0]) as { actions?: Array<{ tool?: string; stage?: string; reason?: string; agentId?: string }> };
    const actions = (raw.actions ?? []).flatMap((item): ForemanAction[] => {
      if (!FOREMAN_TOOLS.includes(item.tool as ForemanToolName)) return [];
      return [{ tool: item.tool as ForemanToolName, stage: item.stage as FactoryStageId | undefined, reason: typeof item.reason === "string" ? item.reason : "unspecified", agentId: item.agentId }];
    });
    if (!actions.length) return undefined;
    return {
      actions,
      skip: actions.filter((action) => action.tool === "skip_stage" && action.stage).map((action) => action.stage as FactoryStageId),
      askHuman: actions.some((action) => action.tool === "ask_human"),
      dispatchSandbox: actions.some((action) => action.tool === "dispatch_sandbox"),
      dispatchVerify: actions.some((action) => action.tool === "dispatch_verify"),
      requestRevision: actions.some((action) => action.tool === "request_revision"),
      summary: actions.map((action) => action.tool).join(","),
    };
  } catch {
    return undefined;
  }
}

export function classifyActivityColumn(status: WorkOrderState): ActivityColumn {
  if (status === "blocked" || status === "failed" || status === "unknown") return "blocked";
  if (status === "merged" || status === "released" || status === "cancelled") return "done";
  if (status === "intake" || status === "triage") return "triage";
  if (status === "specification" || status === "approval") return "planning";
  if (status === "implementation") return "building";
  return "reviewing";
}

export function sandboxIdForWorkOrder(workOrderId: string): string {
  return `factory-${workOrderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48)}`;
}

export function implementBranchName(workOrderId: string): string {
  // Preserve the work-order identity. A short prefix is readable but lets
  // unrelated UUIDs collide after enough cells have been created. Normal IDs
  // fit under Git's ref limit; long caller-supplied IDs receive a stable hash
  // suffix so the branch remains deterministic without becoming unbounded.
  const normalized = workOrderId.replace(/[^A-Za-z0-9_-]/g, "");
  const suffix = normalized.length <= 48
    ? normalized
    : `${normalized.slice(0, 31)}-${crypto.createHash("sha256").update(workOrderId).digest("hex").slice(0, 16)}`;
  return `${IMPLEMENT_BRANCH_PREFIX}${suffix || "work"}`;
}

export function assertSandboxPushAllowed(ref: string): { ok: true } | { ok: false; reason: string } {
  if (ref === "main" || ref === "master" || ref === "production" || ref.startsWith("release/")) return { ok: false, reason: "Agents cannot push to a protected default or release branch." };
  if (!/^tinkerbot\/[A-Za-z0-9_-]{1,64}$/.test(ref)) return { ok: false, reason: "Sandbox git push is limited to safe tinkerbot/* branches." };
  return { ok: true };
}

export interface SandboxExecStep {
  argv: string[];
  cwd?: string;
  /** Explicit non-secret environment additions for a step; never interpolated into a shell command. */
  env?: Record<string, string>;
  timeout?: number;
  purpose: "clone" | "branch" | "edit" | "test" | "commit" | "push" | "preview";
}

export function sandboxImplementPlan(input: { repository: string; workOrderId: string; baseRef?: string; intent?: string }): { sandboxId: string; branch: string; steps: SandboxExecStep[]; mergeForbidden: true } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new Error("Sandbox repository must be an owner/name identifier.");
  const baseRef = input.baseRef ?? "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseRef) || baseRef.includes("..")) throw new Error("Sandbox baseRef is invalid.");
  const branch = implementBranchName(input.workOrderId);
  const [owner, name] = input.repository.split("/");
  const remote = `https://github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}.git`;
  const cwd = "/workspace/repo";
  return {
    sandboxId: sandboxIdForWorkOrder(input.workOrderId),
    branch,
    mergeForbidden: true,
    steps: [
      { purpose: "clone", argv: ["git", "clone", "--depth", "50", remote, "repo"], cwd: "/workspace" },
      { purpose: "branch", argv: ["git", "checkout", "-B", branch, `origin/${baseRef}`], cwd },
      { purpose: "edit", argv: ["/bin/sh", "-c", "printf '%s\\n' \"$TINKERBOT_TASK\" > /tmp/tinkerbot-task.txt"], env: { TINKERBOT_TASK: sanitizeUntrustedPromptInput(input.intent ?? "implement the approved spec") } },
      { purpose: "test", argv: ["/bin/bash", "-lc", "if [ -f package.json ]; then pnpm test --if-present; elif [ -f pytest.ini ] || [ -d tests ]; then python -m pytest -q; else true; fi"], cwd, timeout: 900_000 },
      { purpose: "commit", argv: ["git", "add", "-A"], cwd },
      { purpose: "commit", argv: ["git", "commit", "-m", `tinkerbot: ${branch.slice("tinkerbot/".length)}`, "--allow-empty"], cwd },
      { purpose: "push", argv: ["git", "push", "-u", "origin", branch], cwd },
    ],
  };
}

export interface SandboxPort {
  exec(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<{ stdout: string; stderr?: string; exitCode: number }>;
}

export async function runImplementSandbox(port: SandboxPort, plan: ReturnType<typeof sandboxImplementPlan>, env: Record<string, string> = {}): Promise<{ status: "ok" | "unknown" | "blocked"; summary: string; logs: string; branch: string }> {
  const logs: string[] = [];
  const branchAllowed = assertSandboxPushAllowed(plan.branch);
  if (!branchAllowed.ok) return { status: "blocked", summary: branchAllowed.reason, logs: "", branch: plan.branch };
  for (const step of plan.steps) {
    if (step.purpose === "push") {
      const allowed = assertSandboxPushAllowed(plan.branch);
      if (!allowed.ok) return { status: "blocked", summary: allowed.reason, logs: logs.join("\n"), branch: plan.branch };
    }
    try {
      const result = await port.exec(step.argv, { cwd: step.cwd, env: { ...env, ...(step.env ?? {}) }, timeout: step.timeout });
      logs.push(`$ ${step.argv.join(" ")}\n${result.stdout}`.slice(0, 4_000));
      if (result.exitCode !== 0 && step.purpose !== "test") return { status: "unknown", summary: `Sandbox ${step.purpose} failed (${result.exitCode}).`, logs: logs.join("\n"), branch: plan.branch };
    } catch {
      return { status: "unknown", summary: `Sandbox ${step.purpose} threw.`, logs: logs.join("\n"), branch: plan.branch };
    }
  }
  return { status: "ok", summary: `Pushed ${plan.branch}. Merge is forbidden. Verification waits for tb check.`, logs: logs.join("\n"), branch: plan.branch };
}

export function computerUsePlan(previewUrl: string): { screenshots: true; linuxChromiumOnly: true; previewUrl: string } {
  return { screenshots: true, linuxChromiumOnly: true, previewUrl };
}

export function createPullRequestBody(input: { workOrderId: string; dashboardUrl: string; screenshotRef?: string; logsRef?: string }): string {
  return [
    "Tinkerbot factory implement agent opened this pull request.",
    "",
    `- Work order: ${input.workOrderId}`,
    `- Dashboard: ${input.dashboardUrl}`,
    input.screenshotRef ? `- Computer-use evidence: ${input.screenshotRef}` : "- Computer-use: Linux/Chromium only; macOS GUI is not claimed.",
    input.logsRef ? `- Sandbox logs: ${input.logsRef}` : undefined,
    "",
    "Agents cannot merge. `tb check` on GitHub Actions is the verification authority.",
  ].filter(Boolean).join("\n");
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool" | "human";
  agentId: string;
  content: string;
  toolNames?: string[];
  tokens?: number;
  at: string;
}

const TRANSCRIPT_SECRET_PATTERNS = [
  /(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|gh(?:p|s|o|u|r)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|whsec_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9_-]{8,})/gi,
  /((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
];

function redactTranscriptText(value: string): string {
  let result = value;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) result = result.replace(pattern, (match, prefix?: string) => prefix ? `${prefix}[redacted]` : "[redacted]");
  return result.slice(0, 16_000);
}

export function conversationTranscript(messages: ConversationMessage[]): { messages: ConversationMessage[]; zdr: true; training: false } {
  return { messages: messages.map((message) => ({ ...message, content: redactTranscriptText(message.content) })), zdr: true, training: false };
}

export function scoreConversation(transcript: { messages: ConversationMessage[] }, criteria: string, judge?: { passed: boolean; reason: string }): { passed: boolean; reason: string; upgradesVerdict: false } {
  if (judge) return { passed: judge.passed, reason: judge.reason, upgradesVerdict: false };
  const empty = transcript.messages.length === 0;
  return { passed: !empty && /test|spec|verify/i.test(criteria) ? transcript.messages.some((message) => /test|spec|tb check/i.test(message.content)) : !empty, reason: empty ? "Empty transcript is UNKNOWN, not a pass." : "Heuristic scorer; LLM judge optional.", upgradesVerdict: false };
}

export function selfImprovementTask(input: { factoryId: string; scorer: string; failureReason: string; workOrderId: string }): { title: string; target: "factory-definition"; opensPullRequest: true; autoMerge: false } {
  return {
    title: `factory-eval: ${input.scorer} failed on ${input.workOrderId}`,
    target: "factory-definition",
    opensPullRequest: true,
    autoMerge: false,
  };
}

export interface FactoryTreeFile {
  path: string;
  contents: string;
}

export function collectFactoryTreeFiles(root: string): FactoryTreeFile[] {
  const files: FactoryTreeFile[] = [];
  const base = path.join(root, ".tinkerbot");
  // Factory metadata is loaded from a customer checkout and can be reached by
  // the self-hosted worker before any harness isolation exists. Bound both the
  // number of entries and the decoded bytes so a generated/configured tree
  // cannot turn definition loading into an unbounded memory or CPU operation.
  const maxFiles = 512;
  const maxFileBytes = 512_000;
  const maxTotalBytes = 8_000_000;
  let totalBytes = 0;
  const walk = (directory: string, relative: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      // Factory metadata is configuration, not an arbitrary filesystem
      // crawler. A repository-controlled symlink could otherwise make a
      // digest, prompt, or agent definition read a secret outside `.tinkerbot`.
      if (entry.isSymbolicLink()) throw new Error(`Factory tree symlinks are not allowed: .tinkerbot/${rel}`);
      if (entry.isDirectory()) walk(full, rel);
      else {
        if (files.length >= maxFiles) throw new Error(`Factory tree contains more than ${maxFiles} files.`);
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size > maxFileBytes) throw new Error(`Factory tree file .tinkerbot/${rel} exceeds the ${maxFileBytes}-byte limit.`);
        totalBytes += stat.size;
        if (totalBytes > maxTotalBytes) throw new Error(`Factory tree exceeds the ${maxTotalBytes}-byte content limit.`);
        files.push({ path: `.tinkerbot/${rel}`, contents: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(base, "");
  const strictTree = process.env.CI === "1" || process.env.CI === "true" || process.env.TINKERBOT_ENFORCE_TREE_INTEGRITY === "1";
  const sorted = files.sort((left, right) => left.path.localeCompare(right.path));
  const exactPaths = new Set(sorted.map((file) => file.path));
  const seenSemantic = new Set<string>();
  const selected = strictTree ? sorted : sorted.filter((file) => {
    const canonicalPath = semanticFactoryTreePath(file.path);
    if (exactPaths.has(canonicalPath)) return file.path === canonicalPath;
    if (seenSemantic.has(canonicalPath)) return false;
    seenSemantic.add(canonicalPath);
    return true;
  });
  assertFactoryTreeIntegrity(selected, { root, requireTracked: strictTree, enforceSemanticUniqueness: strictTree });
  return selected;
}

export function factoryTreeDigest(files: FactoryTreeFile[]): string {
  // Upload order is not semantic. Canonical sorting prevents two clients from
  // producing different definition digests for the same file tree.
  return factoryTreeDigestFromFiles(files);
}

export function parseSandboxRunner(contents: string): { image: string; timeoutSeconds: number; networkAllowlist: string[] } {
  const image = contents.match(/image\s*=\s*"([^"]+)"/)?.[1] ?? "cloudflare/sandbox:next";
  const timeoutSeconds = Number(contents.match(/timeoutSeconds\s*=\s*(\d+)/)?.[1] ?? 1800);
  const allow = [...contents.matchAll(/allow\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  return { image, timeoutSeconds, networkAllowlist: allow.length ? allow : ["github.com", "api.github.com"] };
}

export interface McpToolContext {
  organizationId: string;
  actor: string;
  sendTask(input: { factoryId?: string; title: string; note: string; repositoryId?: string }): Promise<{ workOrderId: string }>;
  getTask(workOrderId: string): Promise<{ workOrder?: WorkOrder; conversation?: ConversationMessage[]; git?: { branch: string; commands: string[] } }>;
  messageForeman(workOrderId: string, note: string): Promise<{ accepted: true } | { accepted: false; reason: string }>;
  createFactory?(input: { name: string; yaml: string; files: Array<{ path: string; contents: string }> }): Promise<{ factoryId: string }>;
}

export function factoryMcpToolDescriptors(): Array<{ name: string; description: string }> {
  return [
    { name: "send_task", description: "Create a factory work order from a local coding agent. Never mutates the local filesystem." },
    { name: "get_task", description: "Read work-order status, run history, and optional local worktree git commands." },
    { name: "message_foreman", description: "Send a steer message to the work-order Foreman conversation." },
    { name: "get_conversation", description: "Read the Foreman transcript for a work order." },
    { name: "create_factory", description: "Create a factory from a starter .tinkerbot tree. Agents and automations stay git-edited." },
  ];
}

export async function handleFactoryMcpTool(name: string, args: Record<string, unknown>, context: McpToolContext): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!FACTORY_MCP_TOOLS.includes(name as (typeof FACTORY_MCP_TOOLS)[number])) return { ok: false, error: `Unknown MCP tool: ${name}` };
  if (name === "create_factory") {
    if (!context.createFactory) return { ok: false, error: "create_factory is unavailable." };
    const factoryName = typeof args.name === "string" ? args.name.trim() : "";
    if (!factoryName) return { ok: false, error: "create_factory requires name." };
    const yaml = typeof args.yaml === "string" ? args.yaml : undefined;
    const files = Array.isArray(args.files) ? args.files.filter((item): item is { path: string; contents: string } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && typeof (item as { contents?: unknown }).contents === "string")) : undefined;
    const starter = yaml && files?.length ? { yaml, files } : buildFactoryStarter({
      name: factoryName,
      owner: typeof args.owner === "string" ? args.owner : "owner",
      repository: typeof args.repository === "string" ? args.repository : "repository",
    });
    return { ok: true, result: await context.createFactory({ name: factoryName, yaml: starter.yaml, files: starter.files }) };
  }
  if (name === "send_task") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const note = typeof args.note === "string" ? args.note : "";
    if (!title) return { ok: false, error: "send_task requires title." };
    const created = await context.sendTask({ factoryId: typeof args.factory === "string" ? args.factory : undefined, title, note, repositoryId: typeof args.repository === "string" ? args.repository : undefined });
    return { ok: true, result: created };
  }
  const workOrderId = typeof args.workOrderId === "string" ? args.workOrderId : typeof args.taskId === "string" ? args.taskId : "";
  if (!workOrderId) return { ok: false, error: `${name} requires workOrderId.` };
  if (name === "message_foreman") {
    const note = typeof args.note === "string" ? args.note : "";
    if (!note) return { ok: false, error: "message_foreman requires note." };
    return { ok: true, result: await context.messageForeman(workOrderId, note) };
  }
  const task = await context.getTask(workOrderId);
  if (name === "get_conversation") return { ok: true, result: { messages: task.conversation ?? [] } };
  const startWorking = args.start_working === true || args.startWorking === true;
  return {
    ok: true,
    result: {
      workOrder: task.workOrder,
      git: startWorking ? task.git ?? { branch: implementBranchName(workOrderId), commands: [`git fetch origin`, `git worktree add ../${implementBranchName(workOrderId)} origin/${implementBranchName(workOrderId)}`] } : undefined,
      workerEnvelope: startWorking ? createWorkerEnvelope({
        workOrderId,
        cellLeaseId: `cell_${workOrderId.slice(0, 8)}`,
        workerId: "customer-optional",
        role: "implementer",
        instructionVersion: "1",
        allowedTools: ["git", "test"],
        inputArtifactRefs: [],
        artifactManifest: [],
        evidenceRefs: [],
        cellReturnStatus: "held",
      }) : undefined,
      verificationVerdictForbidden: true,
    },
  };
}

export function handleMcpJsonRpc(body: unknown, context: McpToolContext): Promise<{ jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } }> {
  const request = body && typeof body === "object" ? body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } : {};
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return Promise.resolve({ jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", serverInfo: { name: "tinkerbot-factory", version: "0.1.0" }, capabilities: { tools: {} } } });
  }
  if (request.method === "tools/list") {
    return Promise.resolve({ jsonrpc: "2.0", id, result: { tools: factoryMcpToolDescriptors().map((tool) => ({ ...tool, inputSchema: { type: "object" } })) } });
  }
  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    const args = request.params?.arguments && typeof request.params.arguments === "object" ? request.params.arguments as Record<string, unknown> : {};
    return handleFactoryMcpTool(name, args, context).then((result) => result.ok
      ? { jsonrpc: "2.0" as const, id, result: { content: [{ type: "text", text: JSON.stringify(result.result) }] } }
      : { jsonrpc: "2.0" as const, id, error: { code: -32602, message: result.error } });
  }
  return Promise.resolve({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(request.method)}` } });
}

export function normalizeIntake(input: {
  sourceType: FactoryIntakeSource;
  sourceId?: string;
  repository?: string;
  title?: string;
  body?: string;
  actor?: string;
  deliveryId?: string;
  organizationId?: string;
  sha?: string;
}): FactoryQueueMessage & { sourceType: FactoryIntakeSource } {
  const text = [input.title, input.body].filter(Boolean).join("\n");
  return {
    deliveryId: input.deliveryId ?? `${input.sourceType}:${input.sourceId ?? crypto.randomUUID()}`,
    organizationId: input.organizationId,
    repository: input.repository,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? crypto.randomUUID(),
    issueOrPullRequest: sanitizeUntrustedPromptInput(text).slice(0, 8_000),
    sha: input.sha,
    actor: input.actor ?? input.sourceType,
  };
}

export function slackIntake(payload: Record<string, unknown>): ReturnType<typeof normalizeIntake> {
  const event = payload.event && typeof payload.event === "object" ? payload.event as Record<string, unknown> : payload;
  const text = typeof event.text === "string" ? event.text.replace(/<@[^>]+>/g, "").trim() : typeof payload.text === "string" ? payload.text : "";
  return normalizeIntake({ sourceType: "slack", sourceId: typeof event.ts === "string" ? event.ts : typeof payload.trigger_id === "string" ? payload.trigger_id : undefined, title: "Slack", body: text, actor: typeof event.user === "string" ? event.user : "slack" });
}

export function linearIntake(payload: Record<string, unknown>): ReturnType<typeof normalizeIntake> {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
  return normalizeIntake({ sourceType: "linear", sourceId: typeof data.id === "string" ? data.id : undefined, title: typeof data.title === "string" ? data.title : "Linear", body: typeof data.description === "string" ? data.description : "", repository: typeof data.team === "object" && data.team && "key" in data.team ? undefined : undefined, actor: "linear" });
}

export function jiraIntake(payload: Record<string, unknown>): ReturnType<typeof normalizeIntake> {
  const issue = payload.issue && typeof payload.issue === "object" ? payload.issue as Record<string, unknown> : payload;
  const fields = issue.fields && typeof issue.fields === "object" ? issue.fields as Record<string, unknown> : {};
  return normalizeIntake({ sourceType: "jira", sourceId: typeof issue.key === "string" ? issue.key : typeof issue.id === "string" ? issue.id : undefined, title: typeof fields.summary === "string" ? fields.summary : "Jira", body: typeof fields.description === "string" ? fields.description : "", actor: "jira" });
}

export function reviewRequestsRevision(summary: string): boolean {
  return /\b(revise|revision needed|send back|implement again)\b/i.test(summary);
}

export function waitForFactoryRun(input: { specApproved?: boolean; skipSpec?: boolean; sandboxComplete?: boolean; verificationIngested?: boolean; revision?: boolean }): FactoryWait | undefined {
  if (input.revision) return "revision";
  if (!input.skipSpec && !input.specApproved) return "spec_approval";
  if (!input.sandboxComplete) return "sandbox";
  if (!input.verificationIngested) return "oidc_ingest";
  return "human_merge";
}

export function ingestedVerdict(verdict: string | undefined): boolean {
  return verdict === "PASS" || verdict === "FAIL" || verdict === "NEEDS_REVIEW";
}
