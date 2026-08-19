import crypto from "node:crypto";

export const GITLAB_SAFE_EVENTS = ["Merge Request Hook", "Issue Hook"] as const;
export const GITLAB_PRIVILEGED_EVENTS = ["Job Hook", "Pipeline Hook", "Deployment Hook", "System Hook"] as const;

export interface GitlabAdmission {
  accepted: boolean;
  reason?: "invalid_token" | "missing_delivery" | "malformed_payload" | "unsafe_event" | "merge_is_not_intake";
  idempotencyKey?: string;
  sourceType?: "gitlab_merge_request" | "gitlab_issue";
  sourceId?: string;
  repository?: string;
  title?: string;
  payload?: Record<string, unknown>;
}

function tokenOk(provided: string | undefined, secret: string | undefined): boolean {
  if (!secret || !provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function admitGitlabWebhook(input: {
  payload: string;
  token?: string;
  secret?: string;
  eventName?: string;
  deliveryId?: string;
}): GitlabAdmission {
  if (!tokenOk(input.token, input.secret)) return { accepted: false, reason: "invalid_token" };
  const deliveryId = input.deliveryId?.trim();
  if (!deliveryId) return { accepted: false, reason: "missing_delivery" };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { accepted: false, reason: "malformed_payload" };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { accepted: false, reason: "malformed_payload" };
  }
  const eventName = input.eventName ?? "";
  if ((GITLAB_PRIVILEGED_EVENTS as readonly string[]).includes(eventName)) return { accepted: false, reason: "unsafe_event" };
  if (eventName === "Merge Request Hook") {
    const objectAttrs = payload.object_attributes && typeof payload.object_attributes === "object" ? payload.object_attributes as Record<string, unknown> : {};
    if (objectAttrs.action === "merge") return { accepted: false, reason: "merge_is_not_intake" };
    const project = payload.project && typeof payload.project === "object" ? payload.project as Record<string, unknown> : {};
    const iid = String(objectAttrs.iid ?? objectAttrs.id ?? deliveryId);
    return {
      accepted: true,
      idempotencyKey: `gitlab:merge_request:${deliveryId}`,
      sourceType: "gitlab_merge_request",
      sourceId: iid,
      repository: typeof project.path_with_namespace === "string" ? project.path_with_namespace : undefined,
      title: typeof objectAttrs.title === "string" ? objectAttrs.title : "GitLab merge request",
      payload,
    };
  }
  if (eventName === "Issue Hook") {
    const objectAttrs = payload.object_attributes && typeof payload.object_attributes === "object" ? payload.object_attributes as Record<string, unknown> : {};
    const project = payload.project && typeof payload.project === "object" ? payload.project as Record<string, unknown> : {};
    const iid = String(objectAttrs.iid ?? objectAttrs.id ?? deliveryId);
    return {
      accepted: true,
      idempotencyKey: `gitlab:issue:${deliveryId}`,
      sourceType: "gitlab_issue",
      sourceId: iid,
      repository: typeof project.path_with_namespace === "string" ? project.path_with_namespace : undefined,
      title: typeof objectAttrs.title === "string" ? objectAttrs.title : "GitLab issue",
      payload,
    };
  }
  return { accepted: false, reason: "unsafe_event" };
}
