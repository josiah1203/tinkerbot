import { expect, test } from "vitest";
import { admitGitlabWebhook } from "../packages/gitlab/src";

const secret = "gitlab-webhook-secret";

test("GitLab MR and issue hooks admit and never treat merge as intake", () => {
  const mr = JSON.stringify({ object_attributes: { iid: 12, title: "Fix login", action: "open" }, project: { path_with_namespace: "acme/pay" } });
  const accepted = admitGitlabWebhook({ payload: mr, token: secret, secret, eventName: "Merge Request Hook", deliveryId: "d1" });
  expect(accepted).toMatchObject({ accepted: true, sourceType: "gitlab_merge_request", repository: "acme/pay" });
  const merged = admitGitlabWebhook({ payload: JSON.stringify({ object_attributes: { iid: 12, action: "merge" }, project: { path_with_namespace: "acme/pay" } }), token: secret, secret, eventName: "Merge Request Hook", deliveryId: "d2" });
  expect(merged).toEqual({ accepted: false, reason: "merge_is_not_intake" });
  const issue = admitGitlabWebhook({ payload: JSON.stringify({ object_attributes: { iid: 3, title: "Bug" }, project: { path_with_namespace: "acme/pay" } }), token: secret, secret, eventName: "Issue Hook", deliveryId: "d3" });
  expect(issue.sourceType).toBe("gitlab_issue");
});

test("GitLab job pipeline deployment and system hooks are rejected", () => {
  for (const eventName of ["Job Hook", "Pipeline Hook", "Deployment Hook", "System Hook"]) {
    const result = admitGitlabWebhook({ payload: "{}", token: secret, secret, eventName, deliveryId: "x" });
    expect(result).toEqual({ accepted: false, reason: "unsafe_event" });
  }
  expect(admitGitlabWebhook({ payload: "{}", token: "nope", secret, eventName: "Issue Hook", deliveryId: "x" }).reason).toBe("invalid_token");
  expect(admitGitlabWebhook({ payload: "{", token: secret, secret, eventName: "Issue Hook", deliveryId: "x" }).reason).toBe("malformed_payload");
  expect(admitGitlabWebhook({ payload: "{}", token: secret, secret, eventName: "Issue Hook" }).reason).toBe("missing_delivery");
  expect(admitGitlabWebhook({ payload: "[]", token: secret, secret, eventName: "Issue Hook", deliveryId: "x" }).reason).toBe("malformed_payload");
});
