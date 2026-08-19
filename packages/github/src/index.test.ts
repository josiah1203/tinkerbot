import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  TINKERBOT_CHECK_NAME,
  admitWebhook,
  canPublish,
  canAccessInstallationRepository,
  checkConclusion,
  createGitHubAuditEvent,
  deliveryIdempotencyKey,
  hasLegacyCommentMarker,
  installationRepositoryAccessState,
  isForkPullRequest,
  isSafePullRequestEvent,
  mapCheckAnnotations,
  normalizeAnnotationPath,
  redactGitHubSecrets,
  stableFindingFingerprint,
  verifyWebhookSignature,
} from "./index";

describe("GitHub assurance boundary", () => {
  test("verifies webhook signatures and rejects forged or malformed payloads", () => {
    const payload = JSON.stringify({ action: "synchronize" });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    expect(verifyWebhookSignature(payload, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(payload, signature.replace(/.$/, "0"), "secret")).toBe(false);
    expect(verifyWebhookSignature(payload, "sha1=bad", "secret")).toBe(false);
    expect(verifyWebhookSignature(payload, undefined, "secret")).toBe(false);
  });

  test("allows only safe pull request event names and handles fork degradation", () => {
    expect(isSafePullRequestEvent("pull_request", "opened")).toBe(true);
    expect(isSafePullRequestEvent("pull_request", "synchronize")).toBe(true);
    expect(isSafePullRequestEvent("pull_request_target", "opened")).toBe(false);
    expect(isSafePullRequestEvent("workflow_dispatch", undefined)).toBe(true);
    expect(admitWebhook({ payload: JSON.stringify({ action: "created", alert: { number: 1 } }), signature: `sha256=${createHmac("sha256", "secret").update(JSON.stringify({ action: "created", alert: { number: 1 } })).digest("hex")}`, secret: "secret", eventName: "dependabot_alert", deliveryId: "dep-1" }).accepted).toBe(true);
    expect(isForkPullRequest({ pull_request: { head: { repo: { fork: true } } } })).toBe(true);
    expect(isForkPullRequest({ pull_request: { head: { repo: { full_name: "contrib/repo" } }, base: { repo: { full_name: "owner/repo" } } } })).toBe(true);
    expect(isForkPullRequest({ pull_request: { head: { repo: { full_name: "owner/repo" } }, base: { repo: { full_name: "owner/repo" } } } })).toBe(false);
  });

  test("fails closed for permissions, forks, duplicate deliveries, and legacy names remain discoverable", () => {
    expect(canPublish("check", { checks: "write" })).toBe(true);
    expect(canPublish("annotation", { checks: "read" })).toBe(false);
    expect(canPublish("comment", { issues: "write" })).toBe(true);
    expect(canPublish("comment", { pull_requests: "write" }, true)).toBe(false);
    expect(deliveryIdempotencyKey("delivery-1", "pull_request")).toBe("github:pull_request:delivery-1");
    expect(deliveryIdempotencyKey("bad delivery", "pull_request")).toBeUndefined();
    expect(hasLegacyCommentMarker("old\n<!-- pr-proof:sticky -->")).toBe(true);
    expect(TINKERBOT_CHECK_NAME).toBe("Tinkerbot Verify");
  });

  test("normalizes paths and produces bounded stable annotations", () => {
    expect(normalizeAnnotationPath("./src\\auth.ts")).toBe("src/auth.ts");
    expect(normalizeAnnotationPath("../secret.txt")).toBeUndefined();
    expect(normalizeAnnotationPath("/absolute.ts")).toBeUndefined();
    const findings = Array.from({ length: 60 }, (_, index) => ({ id: `f-${index}`, ruleId: "rule", file: `src/${String(60 - index).padStart(2, "0")}.ts`, line: 2, severity: "warning", message: "line\nwith control\u0000", title: "rule" }));
    const annotations = mapCheckAnnotations(findings);
    expect(annotations).toHaveLength(50);
    expect(annotations[0]?.path).toBe("src/01.ts");
    expect(annotations[0]?.message).not.toContain("\n");
    expect(mapCheckAnnotations([{ id: "bad", file: "../bad.ts", line: 1, message: "bad" }])).toEqual([]);
    expect(stableFindingFingerprint(findings[0]!)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(checkConclusion("PASS")).toBe("success");
    expect(checkConclusion("FAIL")).toBe("failure");
    expect(checkConclusion("UNKNOWN")).toBe("neutral");
  });

  test("fails closed for missing, mismatched, or suspended App repositories", () => {
    const records = [
      { installationId: 7, repositoryId: 11, fullName: "Acme/Payments-API", permissions: { checks: "write" as const } },
      { installationId: 7, repositoryId: 12, fullName: "acme/suspended", suspended: true },
    ];
    expect(installationRepositoryAccessState(records, 7, 11, "acme/payments-api")).toBe("authorized");
    expect(canAccessInstallationRepository(records, 7, 11, "acme/payments-api")).toBe(true);
    expect(installationRepositoryAccessState(records, 7, 99, "acme/missing")).toBe("missing");
    expect(installationRepositoryAccessState(records, 7, 11, "other/payments-api")).toBe("mismatch");
    expect(installationRepositoryAccessState(records, 7, 12, "acme/suspended")).toBe("suspended");
  });

  test("redacts token-shaped values and emits metadata-only audit events", () => {
    expect(redactGitHubSecrets("token=github_pat_abcdefghijklmnop secret", ["secret"])).toBe("token=[REDACTED] [REDACTED]");
    const event = createGitHubAuditEvent({ action: "installation_received", installationId: 7, repositoryId: 11, repository: "Acme/Payments-API", deliveryId: "delivery-1", outcome: "accepted", observedAt: "2026-01-01T00:00:00.000Z" });
    expect(event).toEqual({ eventId: expect.any(String), action: "installation_received", installationId: 7, repositoryId: 11, repository: "acme/payments-api", deliveryId: "delivery-1", outcome: "accepted", observedAt: "2026-01-01T00:00:00.000Z" });
  });

  test("admits signed safe webhooks and rejects forged, malformed, duplicate-keyless, and unsafe events", () => {
    const payload = JSON.stringify({ action: "synchronize", repository: { full_name: "acme/payments" } });
    const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;
    expect(admitWebhook({ payload, signature, secret: "secret", eventName: "pull_request", deliveryId: "delivery-1" })).toMatchObject({ accepted: true, idempotencyKey: "github:pull_request:delivery-1", audit: { outcome: "accepted", repository: "acme/payments" } });
    expect(admitWebhook({ payload, signature: "sha256=bad", secret: "secret", eventName: "pull_request", deliveryId: "delivery-2" }).reason).toBe("invalid_signature");
    const malformedPayload = "{bad";
    const malformedSignature = `sha256=${createHmac("sha256", "secret").update(malformedPayload).digest("hex")}`;
    expect(admitWebhook({ payload: malformedPayload, signature: malformedSignature, secret: "secret", eventName: "pull_request", deliveryId: "delivery-3" }).reason).toBe("malformed_payload");
    expect(admitWebhook({ payload, signature, secret: "secret", eventName: "pull_request_target", deliveryId: "delivery-4" }).reason).toBe("unsafe_event");
    expect(admitWebhook({ payload, signature, secret: "secret", eventName: "pull_request", deliveryId: undefined }).reason).toBe("missing_delivery");
  });
});
