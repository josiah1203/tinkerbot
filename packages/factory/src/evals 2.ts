import { parse as parseYaml } from "yaml";

export interface EvalTask {
  taskId: string;
  prompt: string;
  expected?: string;
  tags?: string[];
}

export interface EvalSuite {
  suiteId: string;
  name: string;
  tasks: EvalTask[];
  baselineDigest?: string;
  createdAt: string;
}

export interface EvalMetric {
  name: string;
  score: number;
  upgradesVerdict: false;
}

export interface EvalAttempt {
  attemptId: string;
  suiteId: string;
  taskId: string;
  output: string;
  metrics: EvalMetric[];
  passed: boolean;
  createdAt: string;
}

export interface EvalCompareResult {
  suiteId: string;
  improved: string[];
  regressed: string[];
  unchanged: string[];
  upgradesVerdict: false;
}

export function parseEvalSuite(contents: string, suiteId = "personal"): EvalSuite {
  const parsed = parseYaml(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Eval suite must be a mapping.");
  const raw = parsed as Record<string, unknown>;
  const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: EvalTask[] = tasksRaw.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const taskId = typeof record.id === "string" ? record.id : typeof record.taskId === "string" ? record.taskId : `task-${index}`;
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    if (!prompt) throw new Error(`Eval task ${taskId} requires a prompt.`);
    return { taskId, prompt, expected: typeof record.expected === "string" ? record.expected : undefined, tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : undefined };
  });
  return {
    suiteId: typeof raw.suiteId === "string" ? raw.suiteId : suiteId,
    name: typeof raw.name === "string" ? raw.name : suiteId,
    tasks,
    createdAt: new Date().toISOString(),
  };
}

export function parseEvalTaskFile(taskId: string, contents: string): EvalTask {
  const parsed = parseYaml(contents);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const prompt = typeof record.prompt === "string" ? record.prompt : contents.trim();
  if (!prompt) throw new Error(`Eval task ${taskId} requires a prompt.`);
  return { taskId, prompt, expected: typeof record.expected === "string" ? record.expected : undefined };
}

export function scoreEvalOutput(task: EvalTask, output: string): EvalMetric[] {
  const expected = task.expected?.trim();
  const overlap = expected ? (output.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0) : output.trim() ? 0.5 : 0;
  return [{ name: "advisory_match", score: overlap, upgradesVerdict: false }];
}

export async function runEvalSuiteAsync(suite: EvalSuite, generate: (task: EvalTask) => Promise<string> | string, now = new Date().toISOString()): Promise<EvalAttempt[]> {
  const attempts: EvalAttempt[] = [];
  for (const task of suite.tasks) {
    const output = await generate(task);
    const metrics = scoreEvalOutput(task, output);
    attempts.push({
      attemptId: `${suite.suiteId}:${task.taskId}:${now}`,
      suiteId: suite.suiteId,
      taskId: task.taskId,
      output,
      metrics,
      passed: metrics.every((metric) => metric.score >= 1) || !task.expected,
      createdAt: now,
    });
  }
  return attempts;
}

export function runEvalSuite(suite: EvalSuite, generate: (task: EvalTask) => string, now = new Date().toISOString()): EvalAttempt[] {
  return suite.tasks.map((task) => {
    const output = generate(task);
    const metrics = scoreEvalOutput(task, output);
    return {
      attemptId: `${suite.suiteId}:${task.taskId}:${now}`,
      suiteId: suite.suiteId,
      taskId: task.taskId,
      output,
      metrics,
      passed: metrics.every((metric) => metric.score >= 1) || !task.expected,
      createdAt: now,
    };
  });
}

export function compareEvalAttempts(current: EvalAttempt[], baseline: EvalAttempt[]): EvalCompareResult {
  const suiteId = current[0]?.suiteId ?? baseline[0]?.suiteId ?? "unknown";
  const baseByTask = new Map(baseline.map((attempt) => [attempt.taskId, attempt]));
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  for (const attempt of current) {
    const prior = baseByTask.get(attempt.taskId);
    if (!prior) {
      unchanged.push(attempt.taskId);
      continue;
    }
    const currentScore = attempt.metrics[0]?.score ?? 0;
    const priorScore = prior.metrics[0]?.score ?? 0;
    if (currentScore > priorScore) improved.push(attempt.taskId);
    else if (currentScore < priorScore) regressed.push(attempt.taskId);
    else unchanged.push(attempt.taskId);
  }
  return { suiteId, improved, regressed, unchanged, upgradesVerdict: false };
}
