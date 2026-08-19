import fs from "node:fs";
import path from "node:path";
import {
  buildExecutionPlan,
  loadFactoryDefinition,
  mergeRuntimeProfile,
  soloRuntimeOverlay,
  compareEvalAttempts,
  parseEvalSuite,
  parseEvalTaskFile,
  runEvalSuite,
  type EvalSuite,
} from "../../factory/src";
import {
  defaultLocalDbPath,
  dockerSandboxPort,
  processSandboxPort,
  providerForProfile,
  runLocalFactory,
  SqliteFactoryStore,
  stubInferenceProvider,
  stubSandboxPort,
} from "../../local-runtime/src";

export function factoryPlanPayload(root: string, profile?: string, text?: string): Record<string, unknown> {
  const loaded = loadFactoryDefinition(root);
  const overlay = profile === "solo" ? soloRuntimeOverlay() : undefined;
  const runtime = mergeRuntimeProfile(loaded.definition.runtime, overlay);
  const built = buildExecutionPlan({ sourceType: "manual", untrustedText: text ?? "dry-run plan", profile: runtime, paths: [] });
  return { dryRun: true, sideEffects: false, plan: built.plan, cost: built.plan.cost, skip: built.plan.skip, stages: built.plan.stages };
}

export function evalCli(root: string, sub: string, positional?: string): Record<string, unknown> {
  const dir = path.join(root, ".tinkerbot", "evals");
  if (sub === "init") {
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    const suitePath = path.join(dir, "personal-suite.yaml");
    if (!fs.existsSync(suitePath)) fs.writeFileSync(suitePath, "name: personal\ntasks: []\n");
    return { initialized: true, path: ".tinkerbot/evals/personal-suite.yaml" };
  }
  if (sub === "add") {
    const taskId = positional || `task-${Date.now()}`;
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks", `${taskId}.yaml`), `prompt: ${taskId} fixture\nexpected: ok\n`);
    return { added: taskId, upgradesVerdict: false };
  }
  const suiteFile = path.join(dir, "personal-suite.yaml");
  let suite: EvalSuite = { suiteId: "personal", name: "personal", tasks: [], createdAt: new Date().toISOString() };
  if (fs.existsSync(suiteFile)) suite = parseEvalSuite(fs.readFileSync(suiteFile, "utf8"), "personal");
  const taskDir = path.join(dir, "tasks");
  if (fs.existsSync(taskDir)) {
    for (const file of fs.readdirSync(taskDir).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))) {
      suite.tasks.push(parseEvalTaskFile(file.replace(/\.ya?ml$/, ""), fs.readFileSync(path.join(taskDir, file), "utf8")));
    }
  }
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  if (sub === "run") {
    const attempts = runEvalSuite(suite, (task) => task.expected ?? "ok");
    for (const attempt of attempts) void store.insertEvalAttempt(attempt);
    return { suiteId: suite.suiteId, attempts, upgradesVerdict: false };
  }
  if (sub === "baseline") {
    void store.putEvalSuite({ ...suite, baselineDigest: "sha256:baseline" });
    return { baseline: true, suiteId: suite.suiteId, upgradesVerdict: false };
  }
  if (sub === "compare") {
    const current = runEvalSuite(suite, (task) => task.expected ?? "ok");
    const baseline = store.attempts.filter((attempt) => attempt.suiteId === suite.suiteId);
    return { ...compareEvalAttempts(current, baseline.length ? baseline : current), upgradesVerdict: false as const };
  }
  if (sub === "export") return { suite, attempts: store.attempts, upgradesVerdict: false };
  throw new Error("Usage: tb eval init|add|run|compare|baseline|export");
}

export function localDashboardPayload(root: string): Record<string, unknown> {
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  return {
    local: true,
    organizationId: "local",
    plans: [...store.plans.values()].map((plan) => ({ planId: plan.planId, skip: plan.skip, cost: plan.cost, escalationReason: plan.escalationReason })),
    evals: store.attempts.map((attempt) => ({ taskId: attempt.taskId, passed: attempt.passed, upgradesVerdict: false })),
    billing: "seats_only",
  };
}

export async function executeLocalRun(root: string, input: { profile?: string; allowProcessRunner?: boolean; text?: string }): Promise<Record<string, unknown>> {
  const loaded = loadFactoryDefinition(root);
  if (loaded.definition.runtime.runner.type === "process" && !input.allowProcessRunner) {
    throw new Error("process runner requires --allow-process-runner. Docker is the default local runner.");
  }
  const overlay = input.profile === "solo" ? soloRuntimeOverlay() : undefined;
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const inference = process.env.TINKERBOT_STUB_INFERENCE === "0"
    ? providerForProfile({ mode: loaded.definition.runtime.inference.mode, provider: loaded.definition.runtime.inference.provider, credentialRef: loaded.definition.runtime.inference.credentialRef })
    : stubInferenceProvider();
  const sandbox = input.allowProcessRunner ? processSandboxPort(true) : process.env.TINKERBOT_STUB_SANDBOX === "0" ? dockerSandboxPort() : stubSandboxPort();
  const result = await runLocalFactory({
    definition: loaded.definition,
    root,
    store,
    profileOverlay: overlay,
    inference,
    sandbox,
    actor: "local-human",
    untrustedText: input.text ?? "local run",
    verificationVerdict: "UNKNOWN",
  });
  return { ...result, origin: "local", billing: "seats_only", upgradesVerdict: false };
}
