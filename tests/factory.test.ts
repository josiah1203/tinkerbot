import { describe, expect, test } from "vitest";
import {
  canTransition,
  classifyWorkOrderGroup,
  containsRawCredentials,
  createWorkOrder,
  decodeJwtPayload,
  executeFactoryRun,
  factoryDefinitionDigest,
  loadFactoryDefinition,
  parseFactoryDefinition,
  publicationDedupeKey,
  runForeman,
  sanitizeUntrustedPromptInput,
  signRecord,
  transitionWorkOrder,
  validateFactoryDefinition,
  validateOidcClaims,
  verificationAuthority,
  verifySignedRecord,
  workOrderEventIdempotencyKey,
  validateAgentReceipt,
  assertSandboxPushAllowed,
  classifyActivityColumn,
  DEFAULT_MODELS,
  handleFactoryMcpTool,
  handleMcpJsonRpc,
  implementBranchName,
  jiraIntake,
  linearIntake,
  planForemanActions,
  sandboxImplementPlan,
  scoreConversation,
  slackIntake,
  workersAiGatewayOptions,
  AI_GATEWAY_ID,
  routeProductionLine,
  resolveAutonomy,
  autonomyAllowsSkip,
  acquireWorkCellLease,
  releaseExpiredCells,
  cellCredentialScope,
  takeWorkCell,
  parseSkillDocument,
  evaluateSkillProposal,
  activateSkill,
  draftImprovementProposal,
  stewardSelfMergeRejected,
  evaluateMergeReadiness,
  createReleaseCandidate,
  recordDeployment,
  runAssuranceCheckpoint,
  controlTowerGroup,
  githubSecurityIntake,
  foremanMaySelectStage,
  returnWorkCell,
  parseAutonomyDocument,
  parseProductDocument,
  parseLineDocument,
  parseEvolutionDocument,
  resolveProduct,
  applyWorkOrderRouting,
  incidentIntake,
  supportIntake,
  scheduledMaintenanceTask,
  createRollbackWorkOrder,
  recordOutcome,
  secondaryTowerLane,
  factoryAnalystReport,
  isProductionLineId,
  isAutonomyMode,
  isOsIntakeSource,
  stagesForLine,
  defaultProductionLines,
  parseForemanModelOutput,
  runForemanAgent,
  runImplementSandbox,
  parseSandboxRunner,
  selfImprovementTask,
  ingestedVerdict,
  waitForFactoryRun,
  reviewRequestsRevision,
  ASSURANCE_CHECKPOINTS,
  computerUsePlan,
  createPullRequestBody,
  exhaustObjectKey,
  parseAlias,
  parseRepositories,
  assertAllowedHarness,
  parseAgentType,
  parseAutomationFile,
  parseRunnerYaml,
  parseAgentFile,
  automationMatches,
  factoryDashboardMetrics,
  applyFactoryTree,
  sourceTypeFromTrigger,
  parseFactorySchemaVersion,
  parseIntegrations,
  parseCredentialStrategy,
  parseAgentDefaults,
  mcpServerNames,
  ACTIVITY_COLUMN_LABELS,
  buildFactoryStarter,
} from "../packages/factory/src";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const yaml = `
version: 1
name: production-services
repositories:
  - acme/payments
sources:
  - type: github_pull_request
  - type: github_issue
  - type: manual
agents:
  - id: triage
    model: "@cf/meta/llama-3.1-8b-instruct"
    provider: workers-ai
  - id: specification
    provider: workers-ai
  - id: review
    provider: workers-ai
secretRefs:
  - env:GITHUB_APP_PRIVATE_KEY
approvals:
  required: true
`;

describe("factory domain", () => {
  test("parses, canonicalizes, and rejects raw credentials", () => {
    const definition = parseFactoryDefinition(yaml);
    expect(definition.name).toBe("production-services");
    expect(definition.runner.type).toBe("github_actions");
    expect(validateFactoryDefinition(definition)).toEqual([]);
    expect(factoryDefinitionDigest(definition)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(containsRawCredentials({ token: "ghs_abcdefghijklmnopqrstuvwxyz" })).toBe(true);
    expect(() => parseFactoryDefinition("name: bad\nrepositories: [acme/payments]\nsecret: sk-proj-abcdefghijklmnop")).toThrow(/credentials/);
  });

  test("loads factory.yaml from a repository root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinkerbot-factory-"));
    fs.mkdirSync(path.join(root, ".tinkerbot"));
    fs.writeFileSync(path.join(root, ".tinkerbot", "factory.yaml"), yaml);
    const loaded = loadFactoryDefinition(root);
    expect(loaded.definition.repositories).toEqual(["acme/payments"]);
    expect(loaded.digest).toBe(loaded.treeDigest);
    expect(loaded.definition.agents[0]?.model).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  test("work-order transitions are append-only, idempotent, and fail closed", () => {
    const order = createWorkOrder({ factoryId: "fac_1", organizationId: "org_1", sourceType: "github_pull_request", sourceId: "12", repositoryId: "acme/payments", policyVersion: "default", definitionVersion: "1", definitionDigest: "sha256:abc", actor: "system" });
    expect(order.status).toBe("intake");
    const first = transitionWorkOrder(order, "triage", "delivery-1", "webhook");
    expect("event" in first && first.event.eventId).toBe(workOrderEventIdempotencyKey(order.workOrderId, "intake", "triage", "delivery-1"));
    const again = transitionWorkOrder(first.order, "triage", "delivery-1", "webhook");
    expect(again).toMatchObject({ error: "idempotent" });
    expect(transitionWorkOrder(first.order, "released", "skip", "agent")).toMatchObject({ error: "invalid_transition" });
    expect(classifyWorkOrderGroup("failed")).toBe("needs_attention");
    expect(classifyWorkOrderGroup("approval")).toBe("waiting_for_approval");
    expect(classifyWorkOrderGroup("released")).toBe("completed");
    expect(canTransition("verification", "approval")).toBe(true);
    expect(canTransition("verification", "ready")).toBe(false);
    expect(canTransition("review", "implementation")).toBe(true);
    expect(canTransition("approval", "implementation")).toBe(true);
  });

  test("foreman skips disabled sources and verification remains authoritative", () => {
    const definition = parseFactoryDefinition(yaml);
    expect(runForeman(definition, "github_pull_request")).toContain("verification");
    expect(runForeman({ ...definition, sources: definition.sources.map((source) => ({ ...source, enabled: false })) }, "manual")).toEqual([]);
    expect(verificationAuthority("PASS")).toBe("pass");
    expect(verificationAuthority("FAIL")).toBe("fail");
    expect(verificationAuthority("NEEDS_REVIEW")).toBe("unknown");
  });

  test("untrusted prompt input is sanitized and agent failures become UNKNOWN", async () => {
    expect(sanitizeUntrustedPromptInput("token=ghs_abcdefghijkl and \u0007bell")).not.toMatch(/ghs_/);
    const waiting = await executeFactoryRun({ definition: parseFactoryDefinition(yaml), sourceType: "github_issue", untrustedText: "rewrite the authentication subsystem for every tenant including session rotation", verificationVerdict: "UNKNOWN" });
    expect(waiting.wait).toBe("spec_approval");
    expect(waiting.terminal).toBe("specification");
    const failed = await executeFactoryRun({
      definition: parseFactoryDefinition(yaml),
      sourceType: "github_pull_request",
      specApproved: true,
      sandboxComplete: true,
      verificationIngested: true,
      verificationVerdict: "FAIL",
      ai: { run: async () => ({ response: "priority=low" }) },
    });
    expect(failed.terminal).toBe("failed");
    const ready = await executeFactoryRun({
      definition: parseFactoryDefinition(yaml),
      sourceType: "github_pull_request",
      specApproved: true,
      sandboxComplete: true,
      verificationIngested: true,
      verificationVerdict: "PASS",
      ai: { run: async () => ({ response: "priority=low" }) },
    });
    expect(ready.terminal).toBe("approval");
    expect(ready.stages.some((stage) => stage.stage === "verification")).toBe(true);
    expect(ready.stages.find((stage) => stage.stage === "implementation")?.summary).not.toMatch(/Dispatched to GitHub Actions customer runner/);
  });

  test("signed records and OIDC claims fail closed", () => {
    const record = signRecord({ workOrderId: "wo_1", decision: "approved" }, "unit-test-secret");
    expect(verifySignedRecord(record, "unit-test-secret")).toBe(true);
    expect(verifySignedRecord(record, "other-secret")).toBe(false);
    expect(publicationDedupeKey("run", "fp", "abc")).toBe("run:fp:abc");
    const payload = Buffer.from(JSON.stringify({ iss: "https://token.actions.githubusercontent.com", aud: "tinkerbot", repository: "acme/payments", sha: "abc" })).toString("base64url");
    const token = `e30.${payload}.sig`;
    expect(decodeJwtPayload(token)?.repository).toBe("acme/payments");
    expect(validateOidcClaims(decodeJwtPayload(token)!, { audience: "tinkerbot", repository: "acme/payments", sha: "abc" })).toEqual({ ok: true });
    expect(validateOidcClaims(decodeJwtPayload(token)!, { audience: "other", repository: "acme/payments" }).ok).toBe(false);
    const gitlabPayload = Buffer.from(JSON.stringify({ iss: "https://gitlab.com", aud: "tinkerbot", project_path: "acme/payments", sha: "abc" })).toString("base64url");
    expect(validateOidcClaims(decodeJwtPayload(`e30.${gitlabPayload}.sig`)!, { audience: "tinkerbot", repository: "acme/payments" })).toEqual({ ok: true });
  });

  test("agent receipts missing required factory fields stay UNKNOWN and never upgrade a verdict", () => {
    expect(validateAgentReceipt(null).valid).toBe(false);
    expect(validateAgentReceipt({ repository: "acme/payments" }).missing).toContain("agentIdentity");
    expect(validateAgentReceipt({ repository: "acme/payments", agentIdentity: "triage", workflowId: "run", baseSha: "a", headSha: "b", model: "m", provider: "workers-ai", harness: "default", definitionHash: "sha256:x", inputRef: "in", outputRef: "out" }).valid).toBe(true);
  });

  test("Warp-parity Foreman, sandbox, MCP, intake, and evals fail closed", async () => {
    expect(DEFAULT_MODELS.implement).toContain("@cf/");
    expect(workersAiGatewayOptions({ workOrderId: "wo", stage: "foreman" }).gateway.id).toBe(AI_GATEWAY_ID);
    expect(planForemanActions({ sourceType: "github_issue", untrustedText: "rewrite authentication for every tenant" }).askHuman).toBe(true);
    expect(planForemanActions({ sourceType: "github_pull_request", untrustedText: "typo" }).skip).toContain("specification");
    expect(assertSandboxPushAllowed("main").ok).toBe(false);
    expect(assertSandboxPushAllowed(implementBranchName("wo_12345678")).ok).toBe(true);
    const plan = sandboxImplementPlan({ repository: "acme/payments", workOrderId: "wo_12345678" });
    expect(plan.mergeForbidden).toBe(true);
    expect(plan.steps.some((step) => step.purpose === "push")).toBe(true);
    expect(classifyActivityColumn("implementation")).toBe("building");
    expect(classifyActivityColumn("specification")).toBe("planning");
    expect(slackIntake({ event: { text: "<@U1> fix flaky test", ts: "1.2", user: "U2" } }).sourceType).toBe("slack");
    expect(linearIntake({ data: { id: "LIN-1", title: "Bug", description: "x" } }).sourceType).toBe("linear");
    expect(jiraIntake({ issue: { key: "PAY-9", fields: { summary: "Outage", description: "500s" } } }).sourceType).toBe("jira");
    const mcp = await handleFactoryMcpTool("send_task", { title: "Fix flaky test", note: "from cursor" }, {
      organizationId: "org_1",
      actor: "dev",
      sendTask: async () => ({ workOrderId: "wo_mcp" }),
      getTask: async () => ({ workOrder: undefined, conversation: [] }),
      messageForeman: async () => ({ accepted: true as const }),
    });
    expect(mcp).toEqual({ ok: true, result: { workOrderId: "wo_mcp" } });
    const listed = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      organizationId: "org_1",
      actor: "dev",
      sendTask: async () => ({ workOrderId: "wo_mcp" }),
      getTask: async () => ({ workOrder: undefined }),
      messageForeman: async () => ({ accepted: true as const }),
    });
    expect(listed.result).toMatchObject({ tools: expect.any(Array) });
    expect(JSON.stringify(listed.result)).toContain("create_factory");
    const created = await handleFactoryMcpTool("create_factory", { name: "payments" }, {
      organizationId: "org_1",
      actor: "dev",
      sendTask: async () => ({ workOrderId: "wo_mcp" }),
      getTask: async () => ({ workOrder: undefined, conversation: [] }),
      messageForeman: async () => ({ accepted: true as const }),
      createFactory: async (input) => ({ factoryId: input.name === "payments" ? "fac_new" : "x" }),
    });
    expect(created).toEqual({ ok: true, result: { factoryId: "fac_new" } });
    const fromFiles = await handleFactoryMcpTool("create_factory", { name: "payments", yaml: "name: payments\n", files: [{ path: ".tinkerbot/factory.yaml", contents: "name: payments\n" }] }, {
      organizationId: "org_1",
      actor: "dev",
      sendTask: async () => ({ workOrderId: "wo_mcp" }),
      getTask: async () => ({ workOrder: undefined, conversation: [] }),
      messageForeman: async () => ({ accepted: true as const }),
      createFactory: async (input) => ({ factoryId: input.files[0]?.path ?? "x" }),
    });
    expect(fromFiles).toEqual({ ok: true, result: { factoryId: ".tinkerbot/factory.yaml" } });
    expect((await handleFactoryMcpTool("create_factory", { name: "x" }, {
      organizationId: "org_1",
      actor: "dev",
      sendTask: async () => ({ workOrderId: "wo_mcp" }),
      getTask: async () => ({ workOrder: undefined, conversation: [] }),
      messageForeman: async () => ({ accepted: true as const }),
    })).ok).toBe(false);
    expect(buildFactoryStarter({ name: "payments", owner: "acme", repository: "pay" }).files.some((file) => file.path === ".tinkerbot/factory.yaml")).toBe(true);
    expect(buildFactoryStarter({ name: "payments", owner: "acme", repository: "pay", harness: "tinkerbot-sandbox", integrations: ["slack"] }).yaml).toContain("harness: tinkerbot-sandbox");
    expect(scoreConversation({ messages: [] }, "ran tests").passed).toBe(false);
    expect(scoreConversation({ messages: [{ role: "assistant", agentId: "review", content: "tb check PASS", at: "now" }] }, "did the agent run tb check?").upgradesVerdict).toBe(false);
  });
});

describe("factory operating system", () => {
  test("routes demand onto production lines and risk-based autonomy", () => {
    expect(routeProductionLine({ sourceType: "github_dependabot", text: "bump lodash" }).lineId).toBe("dependency");
    expect(routeProductionLine({ sourceType: "github_code_scanning" }).lineId).toBe("security");
    expect(routeProductionLine({ sourceType: "incident", text: "sev1 outage" }).lineId).toBe("incident");
    expect(routeProductionLine({ sourceType: "github_issue", text: "add checkout flow" }).lineId).toBe("feature");
    expect(resolveAutonomy({ lineId: "security" })).toBe("restricted");
    expect(resolveAutonomy({ lineId: "feature", paths: ["src/auth/session.ts"] })).toBe("restricted");
    expect(resolveAutonomy({ lineId: "feature", paths: ["README.md"], text: "docs typo" })).toBe("policy_autonomous");
    expect(autonomyAllowsSkip("restricted", "specification")).toBe(false);
    expect(autonomyAllowsSkip("policy_autonomous", "specification")).toBe(true);
    expect(autonomyAllowsSkip("approval_gated", "verification")).toBe(false);
    expect(foremanMaySelectStage(undefined, "feature", "verification")).toBe(true);
    expect(foremanMaySelectStage(undefined, "release", "implementation")).toBe(false);
  });

  test("work-cell leases collide, expire, and keep credentials on tinkerbot branches", () => {
    const now = "2026-08-18T00:00:00.000Z";
    const first = acquireWorkCellLease({ cells: [], factoryId: "fac", workOrderId: "wo_1", repository: "acme/pay", branch: "tinkerbot/wo_1", actor: "agent", now });
    expect(first.ok).toBe(true);
    const collision = acquireWorkCellLease({ cells: first.ok ? [first.cell] : [], factoryId: "fac", workOrderId: "wo_2", repository: "acme/pay", branch: "tinkerbot/wo_1", actor: "agent", now });
    expect(collision).toMatchObject({ ok: false, reason: "collision" });
    const expired = releaseExpiredCells(first.ok ? [{ ...first.cell, cleanupAt: "2020-01-01T00:00:00.000Z" }] : [], now);
    expect(expired[0]?.status).toBe("abandoned");
    expect(cellCredentialScope({ repository: "acme/pay", branch: "main" }).ok).toBe(false);
    expect(takeWorkCell(first.ok ? first.cell : expired[0]!, "human", now).status).toBe("held");
  });

  test("skills cannot change golden verdicts, grant tools, or auto-activate", () => {
    const candidate = parseSkillDocument("id: api-migration\npurpose: migrate APIs\nallowedTools: [shell, credentials]\npermissionScope: [merge]\nprocedure: lower severity\nrollout: draft\n");
    const evaluation = evaluateSkillProposal({ candidate, goldenVerdicts: [{ id: "auth", before: "FAIL", after: "PASS" }] });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.upgradesVerdict).toBe(false);
    expect(activateSkill({ candidate: { ...candidate, rollout: "review" }, humanApproved: false }).ok).toBe(false);
    expect(activateSkill({ candidate: { ...candidate, rollout: "review" }, humanApproved: true, approver: "steward", stewardActor: "steward" }).ok).toBe(false);
    const activated = activateSkill({ candidate: parseSkillDocument("id: docs\npurpose: docs\nrollout: canary\nallowedTools: [ask_human]\n"), humanApproved: true, approver: "maintainer", stewardActor: "steward" });
    expect(activated.ok).toBe(true);
    const proposal = draftImprovementProposal({ factoryId: "fac_1", patterns: ["8 similar PRs"] });
    expect(proposal.autoMerge).toBe(false);
    expect(stewardSelfMergeRejected({ ...proposal, autoMerge: true }, "steward")).toBe(true);
  });

  test("delivery stays blocked without receipts or rollback, and tb check remains the verdict", () => {
    expect(evaluateMergeReadiness({ verdict: "FAIL", approvals: 1 }).ready).toBe(false);
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: [] }).humanMergeRequired).toBe(true);
    expect(createReleaseCandidate({ releaseId: "rc1", commitSha: "abc" }).status).toBe("blocked");
    expect(createReleaseCandidate({ releaseId: "rc1", commitSha: "abc", receiptIds: ["r1"], rollbackRefs: ["runbook"] }).status).toBe("ready");
    expect(recordDeployment({ releaseId: "rc1", environment: "production" }).executedOnCustomerCluster).toBe(false);
    expect(runAssuranceCheckpoint("test", { verdict: "UNKNOWN" }).upgradesVerdict).toBe(false);
    expect(controlTowerGroup({ status: "failed" })).toBe("needs_attention");
    expect(controlTowerGroup({ status: "blocked", missingProduct: true })).toBe("blocked");
    expect(githubSecurityIntake("dependabot_alert", { alert: { number: 3 } })?.sourceType).toBe("github_dependabot");
  });

  test("loads the factory-as-code tree including lines, skills, and autonomy", () => {
    const loaded = loadFactoryDefinition(process.cwd());
    expect(loaded.definition.lines.some((line) => line.id === "feature" && line.stages.includes("verification"))).toBe(true);
    expect(loaded.definition.skills.some((skill) => skill.id === "verification")).toBe(true);
    expect(loaded.definition.autonomy.neverMerge).toBe(true);
    expect(loaded.definition.evolution.autoMerge).toBe(false);
    expect(loaded.definition.product?.name).toBe("tinkerbot");
    expect(loaded.treeDigest).toMatch(/^sha256:/);
  });

  test("routes every production line and blocks unmapped products", () => {
    expect(routeProductionLine({ sourceType: "github_issue", text: "fix flaky checkout" }).lineId).toBe("bugfix");
    expect(routeProductionLine({ sourceType: "github_issue", text: "refactor service boundary" }).lineId).toBe("refactor");
    expect(routeProductionLine({ sourceType: "github_issue", text: "schema migration for billing" }).lineId).toBe("migration");
    expect(routeProductionLine({ sourceType: "github_issue", text: "cut release candidate" }).lineId).toBe("release");
    expect(routeProductionLine({ sourceType: "scheduled" }).lineId).toBe("maintenance");
    expect(routeProductionLine({ sourceType: "support", text: "customer cannot login" }).lineId).toBe("bugfix");
    expect(routeProductionLine({ sourceType: "support", text: "stale maintenance decay" }).lineId).toBe("maintenance");
    expect(routeProductionLine({ sourceType: "roadmap" }).outputKind).toBe("spec");
    expect(routeProductionLine({ sourceType: "github_secret_scanning" }).lineId).toBe("security");
    expect(routeProductionLine({ sourceType: "github_issue", text: "rollback production now" }).outputKind).toBe("rollback");
    expect(routeProductionLine({ sourceType: "github_pull_request", paths: ["deploy/helm/chart.yaml"] }).lineId).toBe("release");
    const product = parseProductDocument({ name: "payments", services: [{ id: "api", repository: "acme/payments", owners: ["owner"] }] });
    expect(resolveProduct({ product }, "acme/other")).toMatchObject({ blocked: true, action: "map repository to product" });
    expect(resolveProduct({ product }, "acme/payments").blocked).toBe(false);
    const routed = applyWorkOrderRouting({ sourceType: "github_issue", repositoryId: "acme/other", status: "intake" as const, intent: "add feature" }, { product });
    expect(routed.status).toBe("blocked");
    expect(isProductionLineId("feature")).toBe(true);
    expect(isProductionLineId("nope")).toBe(false);
    expect(isAutonomyMode("restricted")).toBe(true);
    expect(isOsIntakeSource("incident")).toBe(true);
  });

  test("autonomy policy cannot skip restricted or verification gates", () => {
    const policy = parseAutonomyDocument({ defaultMode: "approval_gated", rules: [{ match: "text", pattern: "docs", mode: "policy_autonomous" }] });
    expect(resolveAutonomy({ lineId: "feature", text: "docs only", policy })).toBe("policy_autonomous");
    expect(autonomyAllowsSkip("restricted", "specification")).toBe(false);
    expect(autonomyAllowsSkip("advisory", "specification")).toBe(false);
    expect(autonomyAllowsSkip("advisory", "architecture")).toBe(true);
    expect(autonomyAllowsSkip("policy_autonomous", "verification")).toBe(false);
    expect(autonomyAllowsSkip("policy_autonomous", "release")).toBe(false);
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: [], restricted: false }).humanMergeRequired).toBe(true);
    const typo = planForemanActions({ sourceType: "github_pull_request", untrustedText: "typo" });
    expect(typo.skip).toContain("specification");
    expect(autonomyAllowsSkip("restricted", "specification")).toBe(false);
  });

  test("work-cell concurrency, return, and abandoned held leases", () => {
    const now = "2026-08-18T00:00:00.000Z";
    const cells = Array.from({ length: 8 }, (_, index) => {
      const lease = acquireWorkCellLease({ cells: [], factoryId: "fac", workOrderId: `wo_${index}`, repository: `acme/r${index}`, branch: `tinkerbot/wo_${index}`, actor: "agent", now });
      return lease.ok ? lease.cell : undefined;
    }).filter((cell): cell is NonNullable<typeof cell> => Boolean(cell));
    const overflow = acquireWorkCellLease({ cells, factoryId: "fac", workOrderId: "wo_overflow", repository: "acme/new", branch: "tinkerbot/wo_overflow", actor: "agent", now, concurrencyLimit: 8 });
    expect(overflow).toMatchObject({ ok: false, reason: "concurrency" });
    expect(returnWorkCell(cells[0]!, now).heldBy).toBeUndefined();
    expect(cellCredentialScope({ repository: "acme/pay", branch: "tinkerbot/abc" }).ok).toBe(true);
    const held = takeWorkCell(cells[0]!, "human", now);
    const abandoned = releaseExpiredCells([{ ...held, cleanupAt: "2020-01-01T00:00:00.000Z" }], now);
    expect(abandoned[0]?.status).toBe("abandoned");
  });

  test("skill and evolution parsers reject unsafe mutations", () => {
    expect(() => parseSkillDocument("not a mapping")).toThrow(/Skill must be a mapping/);
    expect(() => parseSkillDocument("purpose: missing id")).not.toThrow();
    const suppress = parseSkillDocument("id: quiet\npurpose: suppress finding\nrollout: draft\n");
    expect(evaluateSkillProposal({ candidate: suppress }).passed).toBe(false);
    expect(activateSkill({ candidate: parseSkillDocument("id: x\npurpose: x\nrollout: draft\n"), humanApproved: true, approver: "human" }).ok).toBe(false);
    expect(factoryAnalystReport({ failures: [{ stage: "verification", reason: "unknown evidence" }, { stage: "verification", reason: "unknown evidence" }], rework: 4, costCents: 60_000 }).mayMutate).toBe(false);
    const stewardProposal = draftImprovementProposal({ factoryId: "fac_1", patterns: ["noise"] });
    expect(stewardSelfMergeRejected({ ...stewardProposal, stewardActor: "steward" }, "steward")).toBe(true);
    expect(() => parseLineDocument({ id: "feature", stages: ["foreman"] })).toThrow(/verification/);
    expect(parseEvolutionDocument({ autoMerge: true }).autoMerge).toBe(false);
    expect(defaultProductionLines().every((line) => line.stages.includes("verification"))).toBe(true);
    expect(stagesForLine({ lines: [{ id: "feature", stages: ["foreman", "triage"], agents: [], autonomy: "approval_gated", requiredEvidence: [], approvalRoles: [] }] }, "feature")).toContain("verification");
  });

  test("assurance checkpoints, delivery, and control tower cover every stage", () => {
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: false, unknowns: [] }).ready).toBe(false);
    expect(evaluateMergeReadiness({ verdict: "PASS", approvals: 1, evidenceFresh: true, unknowns: ["missing"] }).ready).toBe(false);
    expect(createReleaseCandidate({ releaseId: "rc", commitSha: "" }).status).toBe("blocked");
    expect(createRollbackWorkOrder({ repositoryId: "acme/pay" }, "rc1")).toMatchObject({ lineId: "incident", outputKind: "rollback", autonomyMode: "restricted" });
    expect(recordOutcome({ kind: "successful_release", confirmedBy: "human" }).authoritativeVerdictUnchanged).toBe(true);
    for (const checkpoint of ASSURANCE_CHECKPOINTS) {
      const result = runAssuranceCheckpoint(checkpoint, {
        intent: checkpoint === "intent" ? "ship a bounded checkout change" : undefined,
        acceptanceCriteria: "Given a card, when charged, then receipt must exist",
        architectureFit: checkpoint === "architecture" ? false : true,
        specHash: "a",
        implementationSpecHash: checkpoint === "implementation" ? "b" : "a",
        verdict: checkpoint === "test" ? "FAIL" : "PASS",
        impacted: checkpoint === "impact" ? false : true,
        securityChecked: checkpoint === "security" ? false : true,
        rollbackRefs: checkpoint === "release" ? [] : ["runbook"],
        outcomeConfirmed: checkpoint === "outcome" ? false : true,
      });
      expect(result.upgradesVerdict).toBe(false);
      expect(["ok", "blocked", "unknown"]).toContain(result.status);
    }
    expect(runAssuranceCheckpoint("intent", { intent: "too short" }).status).toBe("blocked");
    expect(secondaryTowerLane({ status: "specification", currentStage: "specification" })).toBe("needs_specification");
    expect(secondaryTowerLane({ status: "implementation", currentStage: "architecture" })).toBe("architecture_review");
    expect(secondaryTowerLane({ status: "verification", currentStage: "verification" })).toBe("verification");
    expect(secondaryTowerLane({ status: "released", currentStage: "complete" })).toBe("post_release");
    expect(controlTowerGroup({ status: "implementation", highFindings: 2 })).toBe("needs_attention");
    expect(controlTowerGroup({ status: "implementation", leaseCollision: true })).toBe("blocked");
    expect(controlTowerGroup({ status: "implementation", awaitingDecision: true })).toBe("waiting_for_approval");
    expect(controlTowerGroup({ status: "implementation", unknownEvidence: true })).toBe("needs_attention");
  });

  test("intake parsers and factory-as-code documents fail closed", () => {
    expect(incidentIntake({ incident: { id: "inc_1", title: "Sev1", description: "500s" } }).sourceType).toBe("incident");
    expect(supportIntake({ id: "sup_1", subject: "Login", body: "cannot sign in" }).sourceType).toBe("support");
    expect(scheduledMaintenanceTask("fac", "2026-08-18T00:00:00.000Z").lineId).toBe("maintenance");
    expect(githubSecurityIntake("code_scanning_alert", { alert: { number: 9 } })?.sourceType).toBe("github_code_scanning");
    expect(githubSecurityIntake("secret_scanning_alert", { alert: { number: 2 } })?.sourceType).toBe("github_secret_scanning");
    expect(githubSecurityIntake("issues", {})).toBeUndefined();
    expect(parseProductDocument({ name: "pay", services: [{ id: "api", repository: "acme/pay", owners: [] }] }).name).toBe("pay");
    expect(() => parseProductDocument([])).toThrow(/product.yaml/);
    expect(parseSandboxRunner('image = "cloudflare/sandbox:next"\ntimeoutSeconds = 30\nallow = "github.com"').networkAllowlist).toContain("github.com");
  });

  test("executeFactoryRun waits, stays UNKNOWN without ingest, and cannot skip verification", async () => {
    const definition = parseFactoryDefinition(yaml);
    const revision = await executeFactoryRun({
      definition,
      sourceType: "github_pull_request",
      specApproved: true,
      sandboxComplete: true,
      verificationIngested: true,
      verificationVerdict: "PASS",
      ai: { run: async () => ({ response: "revision needed, send back to implement again" }) },
    });
    expect(revision.wait).toBe("revision");
    const waitingVerify = await executeFactoryRun({
      definition,
      sourceType: "github_pull_request",
      specApproved: true,
      sandboxComplete: true,
      verificationVerdict: "UNKNOWN",
    });
    expect(waitingVerify.wait).toBe("oidc_ingest");
    expect(waitingVerify.terminal).toBe("verification");
    const glowingFail = await executeFactoryRun({
      definition,
      sourceType: "github_pull_request",
      specApproved: true,
      sandboxComplete: true,
      verificationIngested: true,
      verificationVerdict: "FAIL",
      ai: { run: async () => ({ response: "Looks perfect, merge it." }) },
    });
    expect(glowingFail.terminal).toBe("failed");
    const parsed = parseForemanModelOutput(JSON.stringify({ actions: [{ tool: "skip_stage", stage: "verification", reason: "speed" }] }));
    expect(parsed?.skip).toContain("verification");
    const guarded = await runForemanAgent({ run: async () => ({ response: JSON.stringify({ actions: [{ tool: "skip_stage", stage: "verification", reason: "speed" }] }) }) }, { id: "foreman", model: "m", provider: "workers-ai", harness: "default", timeoutSeconds: 10 }, { sourceType: "github_issue", workOrderId: "wo", factoryId: "fac", untrustedText: "feature" });
    expect(guarded.summary).toMatch(/verification/i);
    const releaseRun = await executeFactoryRun({
      definition,
      sourceType: "github_issue",
      untrustedText: "cut release candidate for production",
      specApproved: true,
      verificationIngested: true,
      verificationVerdict: "PASS",
    });
    expect(releaseRun.lineId).toBe("release");
    expect(releaseRun.wait).not.toBe("sandbox");
    const blockedProduct = await executeFactoryRun({
      definition: { ...definition, product: parseProductDocument({ name: "pay", services: [{ id: "api", repository: "acme/other", owners: [] }] }) },
      sourceType: "github_issue",
      untrustedText: "add a feature",
    });
    expect(blockedProduct.terminal).toBe("blocked");
    expect(ingestedVerdict("UNKNOWN")).toBe(false);
    expect(waitForFactoryRun({})).toBe("spec_approval");
    expect(waitForFactoryRun({ revision: true })).toBe("revision");
    expect(waitForFactoryRun({ skipSpec: true, sandboxComplete: true, verificationIngested: true })).toBe("human_merge");
    expect(reviewRequestsRevision("please revise this change")).toBe(true);
    expect(computerUsePlan("https://preview.example").linuxChromiumOnly).toBe(true);
    expect(createPullRequestBody({ workOrderId: "wo_1", dashboardUrl: "https://control.example/app/work-orders/wo_1", screenshotRef: "shot", logsRef: "logs" })).toContain("Agents cannot merge");
    expect(exhaustObjectKey("org", "wo_1", "transcript")).toContain("org/exhaust/wo_1/transcript.json");
    expect(slackIntake({ event: { text: "<@U1> fix login", ts: "1.2", user: "U9" } }).sourceType).toBe("slack");
    expect(linearIntake({ data: { id: "LIN-1", title: "Bug", description: "npe" } }).sourceType).toBe("linear");
    expect(jiraIntake({ issue: { key: "PAY-1", fields: { summary: "Outage", description: "500s" } } }).sourceType).toBe("jira");
    expect((await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { organizationId: "org", actor: "user", sendTask: async () => ({ workOrderId: "wo" }), getTask: async () => ({}), messageForeman: async () => ({ accepted: true as const }) })).result).toMatchObject({ serverInfo: { name: "tinkerbot-factory" } });
    expect((await handleMcpJsonRpc({ jsonrpc: "2.0", id: 2, method: "nope" }, { organizationId: "org", actor: "user", sendTask: async () => ({ workOrderId: "wo" }), getTask: async () => ({}), messageForeman: async () => ({ accepted: true as const }) })).error?.code).toBe(-32601);
    expect(selfImprovementTask({ factoryId: "fac", scorer: "tb-check-gate", failureReason: "empty", workOrderId: "wo" }).autoMerge).toBe(false);
    const sandbox = await runImplementSandbox({ exec: async () => ({ stdout: "ok", exitCode: 0 }) }, { sandboxId: "s", branch: "main", mergeForbidden: true, steps: [{ purpose: "push", argv: ["git", "push"] }] });
    expect(sandbox.status).toBe("blocked");
  });
});

describe("Warp v1alpha1 factory definition", () => {
  test("parses owner/name repositories, alias, agentDefaults, and rejects third-party harnesses", () => {
    const definition = parseFactoryDefinition(fs.readFileSync(path.join(process.cwd(), "fixtures/factory/v1alpha1/.tinkerbot/factory.yaml"), "utf8"));
    expect(definition.schemaVersion).toBe("v1alpha1");
    expect(definition.alias).toBe("payments");
    expect(definition.repositories).toEqual(["acme/payments-service"]);
    expect(definition.integrations.map((item) => item.type)).toEqual(["slack", "linear"]);
    expect(definition.stages.some((stage) => stage.id === "verification")).toBe(true);
    expect(() => parseFactoryDefinition("schemaVersion: v1alpha1\nname: bad\nrepositories:\n  - owner: acme\n    name: pay\nagentDefaults:\n  harness:\n    type: claude\n    model: x\n")).toThrow(/harness/);
    expect(() => parseFactoryDefinition("schemaVersion: v1alpha1\nname: bad\nrepositories: [acme/pay]\nagentDefaults:\n  model: auto\n  harness:\n    type: oz\n")).toThrow(/both model and harness/);
    expect(() => parseFactoryDefinition("schemaVersion: v1alpha1\nname: dual\nrepositories: [acme/pay]\nintegrations:\n  - type: linear\n  - type: jira\nagentDefaults:\n  model: auto\n")).toThrow(/Linear or Jira/);
  });

  test("loads agent frontmatter, automations, and linux runners from the tree", () => {
    const loaded = loadFactoryDefinition(path.join(process.cwd(), "fixtures/factory/v1alpha1"));
    expect(loaded.definition.agents.some((agent) => agent.id === "foreman" && agent.agentType === "FOREMAN")).toBe(true);
    expect(loaded.definition.agentInstructions.foreman).toMatch(/Never merge/);
    expect(loaded.definition.automations[0]?.name).toBe("labeled-issue");
    expect(loaded.definition.automations[0]?.triggers[0]?.event).toBe("issue_labeled");
    expect(loaded.definition.runners[0]?.image).toBe("cloudflare/sandbox:next");
    expect(loaded.definition.sources.some((source) => source.type === "github_issue")).toBe(true);
  });

  test("automation filters, GitLab rejection, and macOS runners fail closed", () => {
    const automation = parseAutomationFile("labeled-issue", "---\nagent: foreman\ntriggers:\n  - provider: github\n    event: issue_labeled\n    filter:\n      repos: [acme/payments-service]\n      labels: [factory-ready]\n---\nTriage the issue.\n");
    expect(automationMatches(automation, { provider: "github", event: "issue_labeled", repo: "acme/payments-service", labels: ["factory-ready"] })).toBe(true);
    expect(automationMatches(automation, { provider: "github", event: "issue_labeled", repo: "acme/other", labels: ["factory-ready"] })).toBe(false);
    expect(automationMatches({ ...automation, enabled: false }, { provider: "github", event: "issue_labeled", repo: "acme/payments-service", labels: ["factory-ready"] })).toBe(false);
    expect(() => parseAutomationFile("gl", "---\ntriggers:\n  - provider: gitlab\n    event: Pipeline Hook\n---\nx\n")).toThrow(/privileged/);
    const gitlabMr = parseAutomationFile("gl-mr", "---\ntriggers:\n  - provider: gitlab\n    event: merge_request\n---\nx\n");
    expect(gitlabMr.triggers[0]?.provider).toBe("gitlab");
    expect(() => parseRunnerYaml("mac", "platform:\n  os: macos\n")).toThrow(/linux/);
    const agent = parseAgentFile("foreman", "---\nagentType: MAIN\nmodel: auto\n---\nRoute work.\n");
    expect(agent.agentType).toBe("FOREMAN");
    expect(() => parseAgentFile("x", "---\nagentType: FOREMAN\nmodel: auto\nharness: tinkerbot-sandbox\n---\nnope\n")).toThrow(/both model and harness/);
    const two = applyFactoryTree(parseFactoryDefinition("version: 1\nname: x\nrepositories: [acme/pay]\n"), [
      { path: ".tinkerbot/agents/a/agent.md", contents: "---\nagentType: FOREMAN\n---\nA\n" },
      { path: ".tinkerbot/agents/b/agent.md", contents: "---\nagentType: FOREMAN\n---\nB\n" },
    ]);
    expect(validateFactoryDefinition(two, { requireForeman: true }).some((error) => /FOREMAN/.test(error))).toBe(true);
    const metrics = factoryDashboardMetrics({ statuses: ["implementation", "released", "intake"], costCents: [12, 8] });
    expect(metrics.opened).toBe(2);
    expect(metrics.merged).toBe(1);
    expect(metrics.estimatedCostCents).toBe(20);
    expect(metrics.autonomyShare).toBeNull();
    expect(metrics.caption).toMatch(/not billing/);
    expect(classifyActivityColumn("implementation")).toBe("building");
    expect(classifyActivityColumn("cancelled")).toBe("done");
    expect(classifyActivityColumn("review")).toBe("reviewing");
    expect(() => parseAlias("!!!")).toThrow(/alias/);
    expect(parseAlias("")).toBeUndefined();
    expect(parseRepositories([{ owner: "acme" }, 1, { owner: "acme", name: "docs" }])).toEqual(["acme/docs"]);
    expect(parseRepositories(null)).toEqual([]);
    expect(assertAllowedHarness("workers-ai", "test")).toBe("default");
    expect(assertAllowedHarness(undefined, "test")).toBeUndefined();
    expect(() => assertAllowedHarness("claude", "test")).toThrow(/not supported/);
    expect(() => assertAllowedHarness({ type: "codex" }, "test")).toThrow(/not supported/);
    expect(() => assertAllowedHarness({ type: "unknown" }, "test")).toThrow(/invalid/);
    expect(() => assertAllowedHarness(12, "test")).toThrow(/invalid/);
    expect(() => parseAgentType("nope")).toThrow(/agentType/);
    expect(parseAgentFile("docs", "No frontmatter here.").agentType).toBe("CUSTOM");
    expect(parseAgentFile("impl", "---\nharness: tinkerbot-sandbox\nsecrets: [TOKEN]\nmcpServers:\n  sentry:\n    warpId: S1\n---\nImplement.\n")).toMatchObject({ harness: "tinkerbot-sandbox", secrets: ["TOKEN"], mcpServers: ["sentry"] });
    expect(() => parseAutomationFile("empty", "---\nenabled: false\n---\nno triggers\n")).toThrow(/trigger/);
    expect(() => parseAutomationFile("bad", "---\ntriggers:\n  - provider: mystery\n    event: ping\n---\nx\n")).toThrow(/provider is invalid/);
    const slack = parseAutomationFile("mention", "---\ntriggers:\n  - provider: slack\n    event: app_mention\n    filter:\n      channels: [eng]\n      users:\n        in: [jane]\n  - provider: schedule\n    event: cron_fired\n    schedule:\n      name: mornings\n      cron: \"0 9 * * 1-5\"\n  - provider: mcp\n    event: send_task\n  - provider: manual\n    event: direct\n  - provider: linear\n    event: issue_created\n  - provider: jira\n    event: issue_created\n  - provider: github\n    event: pull_request_opened\n  - provider: factory\n    event: work_item_stage_changed\n---\nHandle it.\n");
    expect(automationMatches(slack, { provider: "slack", event: "app_mention", channel: "eng" })).toBe(true);
    expect(automationMatches(slack, { provider: "slack", event: "app_mention", channel: "other" })).toBe(false);
    expect(sourceTypeFromTrigger(slack.triggers[0]!)).toBe("slack");
    expect(sourceTypeFromTrigger(slack.triggers[1]!)).toBe("scheduled");
    expect(sourceTypeFromTrigger(slack.triggers[2]!)).toBe("mcp");
    expect(sourceTypeFromTrigger(slack.triggers[3]!)).toBe("manual");
    expect(sourceTypeFromTrigger(slack.triggers[4]!)).toBe("linear");
    expect(sourceTypeFromTrigger(slack.triggers[5]!)).toBe("jira");
    expect(sourceTypeFromTrigger(slack.triggers[6]!)).toBe("github_pull_request");
    expect(sourceTypeFromTrigger(slack.triggers[7]!)).toBeUndefined();
    expect(parseRunnerYaml("plain", "image: cloudflare/sandbox:next\nsetupCommands: [corepack enable]\n").image).toBe("cloudflare/sandbox:next");
    expect(() => parseRunnerYaml("list", "- not a mapping\n")).toThrow(/mapping/);
    expect(() => parseFactorySchemaVersion({ version: 2 })).toThrow(/Unsupported/);
    expect(parseIntegrations("slack")).toEqual([]);
    expect(() => parseIntegrations([{ type: "github" }])).toThrow(/slack, linear, or jira/);
    expect(parseCredentialStrategy("CREATOR")).toBe("CREATOR");
    expect(() => parseCredentialStrategy("OTHER")).toThrow(/credentialStrategy/);
    expect(parseAgentDefaults({ model: "auto", runner: "sandbox", workerHost: "warp" })).toMatchObject({ runner: "sandbox", workerHost: "warp" });
    expect(() => parseAgentDefaults({ workerHost: "ec2-box" })).toThrow(/workerHost/);
    expect(mcpServerNames(["sentry", ""])).toEqual(["sentry"]);
    expect(mcpServerNames(null)).toEqual([]);
    const merged = applyFactoryTree(parseFactoryDefinition("version: 1\nname: x\nrepositories: [acme/pay]\nagents:\n  - id: implement\n    model: leftover\n    harness: github_actions\n"), [
      { path: ".tinkerbot/agents/implement.md", contents: "---\nagentType: IMPLEMENT\n---\nflat\n" },
      { path: ".tinkerbot/agents/implement/agent.md", contents: "---\nagentType: IMPLEMENT\nsecrets: [env:GITHUB_APP_PRIVATE_KEY]\nmcpServers: [github]\n---\nnested\n" },
      { path: ".tinkerbot/agents/docs.md", contents: "Write docs.\n" },
      { path: ".tinkerbot/notes.txt", contents: "ignore" },
    ]);
    expect(merged.agentInstructions.implement).toBe("nested");
    expect(merged.secretRefs.some((item) => item.includes("GITHUB_APP_PRIVATE_KEY"))).toBe(true);
    expect(merged.mcpServers).toContain("github");
    expect(merged.agents.some((agent) => agent.id === "docs" && agent.agentType === "CUSTOM")).toBe(true);
    expect(() => parseFactoryDefinition("schemaVersion: v1alpha1\nname: x\nrepositories: [acme/pay]\n")).toThrow(/agentDefaults/);
    expect(parseFactoryDefinition("schemaVersion: v1alpha1\nname: x\nrepositories: [acme/pay]\nagentDefaults:\n  model: auto\ncredentialStrategy: EXECUTOR\n").credentialStrategy).toBe("EXECUTOR");
    expect(ACTIVITY_COLUMN_LABELS.building).toBe("Building");
  });
});
