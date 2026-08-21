import { githubEventKind, githubInstallationAccount, inlineReviewComments, mapCheckAnnotations, mintInstallationToken, publishCheckRun, publishInlineComments } from "../../../packages/github/src";
import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import { D1FactoryStore } from "./factory-store";
import type { Env } from "./index";

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function githubNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function githubText(value: unknown, maximum = 300): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

async function persistGitHubRepository(database: D1DatabaseLike, installationId: number, value: unknown, status: "active" | "removed" | "suspended", updatedAt: string): Promise<void> {
  const repository = recordValue(value);
  const repositoryId = githubNumber(repository.id);
  const fullName = githubText(repository.full_name);
  if (!repositoryId || !fullName) return;
  await database.prepare("INSERT INTO tinkerbot_github_repositories (repository_id, installation_id, full_name, visibility, status, permissions_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(repository_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, visibility = excluded.visibility, status = excluded.status, permissions_json = excluded.permissions_json, updated_at = excluded.updated_at")
    .bind(repositoryId, installationId, fullName.toLowerCase(), githubText(repository.visibility, 40) ?? null, status, JSON.stringify(recordValue(repository.permissions)), updatedAt).run();
}

export async function persistGitHubWebhook(database: D1DatabaseLike, payload: Record<string, unknown>, eventName: string | undefined): Promise<{ kind: ReturnType<typeof githubEventKind>; installationId?: number; repository?: string; sourceId?: string; sha?: string }> {
  const kind = githubEventKind(eventName);
  const installation = recordValue(payload.installation);
  const installationId = githubNumber(installation.id) ?? githubNumber(payload.installation_id);
  const now = new Date().toISOString();
  if (kind === "installation" && installationId) {
    const action = githubText(payload.action, 80) ?? "";
    const account = githubInstallationAccount(payload);
    const status = action === "deleted" ? "deleted" : action === "suspend" ? "suspended" : "active";
    await database.prepare("INSERT INTO tinkerbot_github_installations (installation_id, account_id, account_login, status, installed_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(installation_id) DO UPDATE SET account_id = COALESCE(excluded.account_id, tinkerbot_github_installations.account_id), account_login = COALESCE(excluded.account_login, tinkerbot_github_installations.account_login), status = excluded.status, updated_at = excluded.updated_at")
      .bind(installationId, account.id ?? null, account.login ?? null, status, now, now).run();
    const repositoryStatus = status === "suspended" ? "suspended" : action === "removed" ? "removed" : "active";
    for (const repository of [...(Array.isArray(payload.repositories) ? payload.repositories : []), ...(Array.isArray(payload.repositories_added) ? payload.repositories_added : []), payload.repository]) {
      await persistGitHubRepository(database, installationId, repository, repositoryStatus, now);
    }
    for (const repository of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
      await persistGitHubRepository(database, installationId, repository, "removed", now);
    }
  }
  const repository = recordValue(payload.repository);
  const pull = recordValue(payload.pull_request);
  const issue = recordValue(payload.issue);
  const sha = githubText(recordValue(pull.head).sha, 64) ?? githubText(recordValue(payload.head).sha, 64);
  const sourceId = kind === "pull_request" ? String(githubNumber(payload.number) ?? githubNumber(pull.number) ?? "") : kind === "issue" ? String(githubNumber(issue.number) ?? "") : undefined;
  return { kind, installationId, repository: githubText(repository.full_name), sourceId, sha };
}

export async function publishVerificationToGitHub(env: Env, input: { repository: string; sha?: string; runId?: string; bundle: Record<string, unknown>; dashboardUrl: string }): Promise<void> {
  if (!env.DB || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !input.sha) return;
  const installation = await env.DB.prepare("SELECT i.installation_id, i.status FROM tinkerbot_github_installations i JOIN tinkerbot_github_repositories r ON r.installation_id = i.installation_id WHERE lower(r.full_name) = lower(?1) LIMIT 1").bind(input.repository).first<{ installation_id: number; status: string }>();
  if (!installation || installation.status !== "active") return;
  const factories = new D1FactoryStore(env.DB);
  const receipts = Array.isArray(input.bundle.receipts) ? input.bundle.receipts as Array<Record<string, unknown>> : [];
  const verdict = typeof receipts[0]?.verdict === "string" ? receipts[0].verdict : "UNKNOWN";
  const findings = Array.isArray(input.bundle.findings) ? input.bundle.findings as Array<{ id?: string; file?: string; line?: number; startLine?: number; message?: string; ruleId?: string; severity?: string }> : [];
  try {
    const token = await mintInstallationToken({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: installation.installation_id });
    const annotations = mapCheckAnnotations(findings as never);
    const runId = input.runId ?? "ingest";
    for (const finding of findings) {
      const fingerprint = typeof finding.id === "string" ? finding.id : `${finding.file}:${finding.line}:${finding.message}`;
      const created = await factories.putPublication({ runId, commitSha: input.sha, fingerprint, kind: "inline", now: new Date().toISOString() });
      if (created === "duplicate") return;
    }
    await publishCheckRun({ token, repository: input.repository }, { headSha: input.sha, verdict, summary: `Tinkerbot verification ${verdict}. ${input.dashboardUrl}`, annotations, detailsUrl: input.dashboardUrl });
    const pullNumber = Number(String(input.bundle.pullNumber ?? "").replace(/\D/g, ""));
    if (Number.isSafeInteger(pullNumber) && pullNumber > 0) {
      await publishInlineComments({ token, repository: input.repository }, pullNumber, inlineReviewComments(findings as never, input.sha, input.dashboardUrl));
    }
  } catch {
    // Publication failure stays UNKNOWN on the dashboard; it must not upgrade a verdict.
  }
}
