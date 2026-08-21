import { expect, test } from "vitest";
import { authorizeIntegrationCommand, handleAdapterEnvelope } from "../packages/factory/src";

const base = { provider: "github" as const, externalId: "issue:42", text: "@tinkerbot status", actorId: "user_1", actorRoles: [], organizationId: "org_1", factoryId: "fac_1", aggregateId: "wo_1", deliveryId: "delivery_1" };

test("provider-neutral integration commands are idempotent, linked, and permission-aware", () => {
  const status = authorizeIntegrationCommand(base);
  expect(status).toMatchObject({ accepted: true, idempotencyKey: "external:github:delivery_1", command: { command: "status" }, externalReference: { provider: "github", aggregateId: "wo_1" } });
  expect(status.reply).toContain("/app/factories/fac_1/work/wo_1");
  expect(authorizeIntegrationCommand({ ...base, text: "@tinkerbot approve" })).toMatchObject({ accepted: false, reason: "authorized_approver_required" });
  expect(authorizeIntegrationCommand({ ...base, text: "@tinkerbot approve", actorRoles: ["approver"] })).toMatchObject({ accepted: true });
  expect(authorizeIntegrationCommand({ ...base, text: "@tinkerbot release", actorRoles: ["approver"] })).toMatchObject({ accepted: false, reason: "release_authority_required" });
  expect(authorizeIntegrationCommand({ ...base, provider: "slack", text: "@tinkerbot release", actorRoles: ["release_authority"] })).toMatchObject({ accepted: true });
});

test("every provider passes through the same signed adapter boundary", () => {
  expect(handleAdapterEnvelope({ ...base, signatureValid: false })).toMatchObject({ accepted: false, reason: "invalid_integration_signature" });
  for (const provider of ["github", "slack", "jira", "linear", "webhook"] as const) {
    expect(handleAdapterEnvelope({ ...base, provider, deliveryId: `${provider}-1`, signatureValid: true })).toMatchObject({ accepted: true, command: { command: "status" } });
  }
});
