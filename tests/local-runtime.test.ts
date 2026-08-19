import { describe, expect, test } from "vitest";
import {
  buildExecutionPlan,
  compareEvalAttempts,
  executeFactoryRun,
  hostedRuntimeDefaults,
  mayUseInlineSelfReview,
  MemoryFactoryStore,
  parseEvalSuite,
  parseFactoryDefinition,
  runEvalSuite,
  scoreEvalOutput,
  soloRuntimeOverlay,
  validateInlineApproval,
  mergeRuntimeProfile,
} from "../packages/factory/src";
import { publicCapabilities } from "../packages/control-plane/src/entitlements";
import { assertNoSecretInPayload, resolveCredentialRef, runLocalFactory, SqliteFactoryStore, stubInferenceProvider, stubSandboxPort } from "../packages/local-runtime/src";
import { evalCli, factoryPlanPayload } from "../packages/cli/src/runtime-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const yaml = "version: 1\nname: pay\nrepositories: [acme/pay]\n";

describe("runtime contracts", () => {
  test("v1 defaults to hosted multi-agent and v1alpha2 parses runtime", () => {
    const v1 = parseFactoryDefinition(yaml);
    expect(v1.schemaVersion).toBe("v1");
    expect(v1.runtime).toMatchObject(hostedRuntimeDefaults("github_actions"));
    const v2 = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  collaboration: solo\n  controlPlane: local\n  pipeline: adaptive\n  approval: inline_self_review\n  runner:\n    type: docker\n  inference:\n    mode: byok\n    provider: anthropic\n    credentialRef: env:ANTHROPIC_API_KEY\n  sync: offline\n`);
    expect(v2.schemaVersion).toBe("v1alpha2");
    expect(v2.runtime.collaboration).toBe("solo");
    expect(v2.runtime.inference.credentialRef).toBe("env:ANTHROPIC_API_KEY");
    expect(() => parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  inference:\n    mode: byok\n    credentialRef: sk-live-not-a-ref-value\n`)).toThrow(/credentialRef/);
    expect(() => parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nagentDefaults:\n  harness: claude-code\n`)).toThrow(/harness/);
  });

  test("planner is deterministic and never skips verification", () => {
    const profile = hostedRuntimeDefaults();
    const a = buildExecutionPlan({ sourceType: "github_pull_request", untrustedText: "typo", profile, diffs: { paths: ["README.md"], changedFileCount: 1, changedLines: 2 } });
    const b = buildExecutionPlan({ sourceType: "github_pull_request", untrustedText: "typo", profile, diffs: { paths: ["README.md"], changedFileCount: 1, changedLines: 2 } });
    expect(a.plan.skip).toEqual(b.plan.skip);
    expect(a.plan.stages.find((stage) => stage.id === "verification")?.include).toBe(true);
    const restricted = buildExecutionPlan({ sourceType: "github_issue", untrustedText: "rewrite authentication", profile, paths: ["src/auth/session.ts"], diffs: { paths: ["src/auth/session.ts"], changedFileCount: 1, changedLines: 40 } });
    expect(restricted.autonomyMode).toBe("restricted");
    expect(restricted.plan.escalationEligible).toBe(true);
    expect(restricted.plan.skip).not.toContain("verification");
  });

  test("inline self-review cannot be used by agents or restricted work", () => {
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "agent" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", autonomyMode: "restricted" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", lineId: "release" }).allowed).toBe(false);
    expect(mayUseInlineSelfReview({ approval: "inline_self_review", actorKind: "human", risk: "low" }).allowed).toBe(true);
    expect(validateInlineApproval({ approvalId: "a", workOrderId: "w", requester: "human", approver: "factory-agent", actorKind: "human", decision: "approved", createdAt: "now" }).ok).toBe(false);
  });

  test("single_agent escalates in place on restricted paths and still requires verification", async () => {
    const definition = parseFactoryDefinition(`schemaVersion: v1alpha2\nname: pay\nrepositories: [acme/pay]\nruntime:\n  pipeline: single_agent\n  controlPlane: local\n`);
    const store = new MemoryFactoryStore();
    const escalated = await executeFactoryRun({ definition, sourceType: "manual", untrustedText: "fix login", paths: [".github/workflows/x.yml"], store, specApproved: true, sandboxComplete: true, verificationIngested: true, verificationVerdict: "PASS" });
    expect(escalated.escalated || escalated.plan?.escalated).toBeTruthy();
    expect(escalated.stages.some((stage) => stage.stage === "verification")).toBe(true);
    const quiet = await executeFactoryRun({ definition, sourceType: "manual", untrustedText: "docs nits", store, actorKind: "human", specApproved: true, sandboxComplete: true, verificationIngested: true, verificationVerdict: "PASS" });
    expect(quiet.stages.some((stage) => stage.stage === "verification")).toBe(true);
    expect(quiet.plan?.cost.platformInvoice).toBe("seats_only");
  });
});

describe("local runtime", () => {
  test("sqlite work order to stub sandbox receipt without secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-"));
    const db = path.join(dir, "local.db");
    const store = new SqliteFactoryStore(db);
    const definition = parseFactoryDefinition(yaml);
    definition.runtime = mergeRuntimeProfile(definition.runtime, soloRuntimeOverlay());
    const result = await runLocalFactory({
      definition,
      root: dir,
      store,
      inference: stubInferenceProvider(),
      sandbox: stubSandboxPort(),
      specApproved: true,
      verificationVerdict: "PASS",
      verificationIngested: true,
      untrustedText: "typo in readme",
    });
    expect(result.runId).toBeTruthy();
    expect(store.receipts.length).toBeGreaterThan(0);
    expect(() => assertNoSecretInPayload(store.receipts[0])).not.toThrow();
    expect(resolveCredentialRef("env:TB_TEST_KEY", { TB_TEST_KEY: "abc" })).toBe("abc");
    expect(() => resolveCredentialRef("sk-raw")).toThrow();
  });

  test("evals stay advisory", () => {
    const suite = parseEvalSuite("name: personal\ntasks:\n  - id: t1\n    prompt: hello\n    expected: hello\n");
    const attempts = runEvalSuite(suite, () => "hello");
    expect(scoreEvalOutput(suite.tasks[0]!, "hello")[0]?.upgradesVerdict).toBe(false);
    expect(compareEvalAttempts(attempts, attempts).upgradesVerdict).toBe(false);
  });
});

describe("entitlements", () => {
  test("local/BYOK/evals are included without a solo billing tier", () => {
    expect(publicCapabilities("free").local_execution).toBe("included");
    expect(publicCapabilities("free").byok_inference).toBe("included");
    expect(publicCapabilities("developer").portable_eval_suites).toBe("included");
    expect(publicCapabilities("free").private_execution).toBe("unavailable");
    expect(publicCapabilities("enterprise").private_execution).toBe("custom");
  });
});

describe("cli helpers", () => {
  test("factory plan payload is a dry run", () => {
    const root = path.join(process.cwd(), "fixtures/factory/v1alpha1");
    const payload = factoryPlanPayload(root, "solo", "typo");
    expect(payload.dryRun).toBe(true);
    expect(payload.sideEffects).toBe(false);
  });

  test("eval init writes yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-eval-"));
    fs.mkdirSync(path.join(dir, ".git"));
    const result = evalCli(dir, "init");
    expect(result.initialized).toBe(true);
    expect(fs.existsSync(path.join(dir, ".tinkerbot/evals/personal-suite.yaml"))).toBe(true);
  });
});
