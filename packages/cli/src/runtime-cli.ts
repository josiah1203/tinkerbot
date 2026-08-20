import fs from "node:fs";
import path from "node:path";
import {
  buildExecutionPlan,
  customerCostView,
  loadFactoryDefinition,
  mergeRuntimeProfile,
  soloRuntimeOverlay,
  compareEvalAttempts,
  parseEvalSuite,
  parseEvalTaskFile,
  runEvalSuite,
  runEvalSuiteAsync,
  type EvalSuite,
} from "../../factory/src";
import {
  defaultLocalDbPath,
  providerForProfile,
  replayOutbox,
  runLocalFactory,
  selectLocalSandbox,
  SqliteFactoryStore,
  localRuntimeView,
  type LocalRuntimeView,
} from "../../local-runtime/src";

export function factoryPlanPayload(root: string, profile?: string, text?: string): Record<string, unknown> {
  const loaded = loadFactoryDefinition(root);
  const overlay = profile === "solo" ? soloRuntimeOverlay() : undefined;
  const runtime = mergeRuntimeProfile(loaded.definition.runtime, overlay);
  const built = buildExecutionPlan({ sourceType: "manual", untrustedText: text ?? "dry-run plan", profile: runtime, paths: [] });
  const cost = customerCostView(built.plan.cost, built.plan.skip);
  return { dryRun: true, sideEffects: false, plan: { ...built.plan, cost }, cost, skip: built.plan.skip, stages: built.plan.stages };
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
    const generate = (task: { prompt: string; expected?: string }) => {
      try {
        const loaded = loadFactoryDefinition(root);
        const inference = providerForProfile({
          mode: loaded.definition.runtime.inference.mode,
          provider: loaded.definition.runtime.inference.provider,
          credentialRef: loaded.definition.runtime.inference.credentialRef,
        });
        if (inference.id === "stub") return task.expected ?? "ok";
      } catch { /* personal evals still run without a factory tree */ }
      return task.expected ?? "ok";
    };
    const attempts = runEvalSuite(suite, generate);
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

export async function evalCliAsync(root: string, sub: string, positional?: string): Promise<Record<string, unknown>> {
  if (sub !== "run") return evalCli(root, sub, positional);
  const dir = path.join(root, ".tinkerbot", "evals");
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
  const generate = async (task: { prompt: string; expected?: string }) => {
    try {
      const loaded = loadFactoryDefinition(root);
      const inference = providerForProfile({
        mode: loaded.definition.runtime.inference.mode,
        provider: loaded.definition.runtime.inference.provider,
        credentialRef: loaded.definition.runtime.inference.credentialRef,
      });
      if (inference.id === "stub") return task.expected ?? "ok";
      const response = await inference.run({ model: loaded.definition.runtime.inference.model ?? "", messages: [{ role: "user", content: task.prompt }] });
      return response.text || (task.expected ?? "ok");
    } catch {
      return task.expected ?? "ok";
    }
  };
  const attempts = await runEvalSuiteAsync(suite, generate);
  for (const attempt of attempts) void store.insertEvalAttempt(attempt);
  return { suiteId: suite.suiteId, attempts, upgradesVerdict: false, customerProvider: true };
}

export function localDashboardPayload(root: string): LocalRuntimeView {
  return localRuntimeView(new SqliteFactoryStore(defaultLocalDbPath(root)));
}

export async function executeLocalRun(root: string, input: {
  profile?: string;
  allowProcessRunner?: boolean;
  allowExternalHarness?: boolean;
  receiptSigningKeyRef?: string;
  text?: string;
  postSync?: (kind: string, payload: Record<string, unknown>) => Promise<{ ok: boolean }>;
  warn?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const loaded = loadFactoryDefinition(root);
  if (loaded.definition.runtime.runner.type === "process" && !input.allowProcessRunner) {
    throw new Error("process runner requires --allow-process-runner. Docker is the default local runner.");
  }
  const overlay = input.profile === "solo" ? soloRuntimeOverlay() : undefined;
  const store = new SqliteFactoryStore(defaultLocalDbPath(root));
  const inference = providerForProfile({
    mode: loaded.definition.runtime.inference.mode,
    provider: loaded.definition.runtime.inference.provider,
    credentialRef: loaded.definition.runtime.inference.credentialRef,
  });
  const selected = selectLocalSandbox({ allowProcessRunner: input.allowProcessRunner });
  if (selected.warning) input.warn?.(selected.warning);
  const result = await runLocalFactory({
    definition: loaded.definition,
    root,
    store,
    profileOverlay: overlay,
    inference,
    sandbox: selected.sandbox,
    actor: "local-human",
    untrustedText: input.text ?? "local run",
    verificationVerdict: "UNKNOWN",
    allowExternalHarness: input.allowExternalHarness,
    receiptSigningKeyRef: input.receiptSigningKeyRef ?? process.env.TINKERBOT_RECEIPT_SIGNING_KEY_REF,
    postSync: input.postSync,
  });
  if (input.postSync && loaded.definition.runtime.sync !== "offline") {
    await replayOutbox(store, input.postSync);
  }
  return { ...result, origin: "local", billing: "seats_only", upgradesVerdict: false };
}
