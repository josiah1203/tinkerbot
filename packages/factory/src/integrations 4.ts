import crypto from "node:crypto";
import { integrationReply, parseIntegrationCommand, type ExternalReference, type IntegrationCommand } from "./graph";

export type IntegrationProvider = ExternalReference["provider"];
export interface IntegrationRequest { provider: IntegrationProvider; externalId: string; externalUrl?: string; text: string; actorId: string; actorRoles: string[]; organizationId: string; factoryId: string; aggregateId?: string; deliveryId: string; }
export interface IntegrationCommandResult { accepted: boolean; idempotencyKey: string; command?: IntegrationCommand; reason?: string; externalReference?: ExternalReference; reply: string; }
export interface AdapterEnvelope { provider: IntegrationProvider; deliveryId: string; externalId: string; actorId: string; text: string; signatureValid: boolean; actorRoles: string[]; organizationId: string; factoryId: string; aggregateId?: string; externalUrl?: string; }

const MUTATING_COMMANDS = new Set<IntegrationCommand["command"]>(["plan", "challenge", "assign", "run", "review", "approve", "release", "pause", "resume"]);
const APPROVER_COMMANDS = new Set<IntegrationCommand["command"]>(["approve"]);
const RELEASE_COMMANDS = new Set<IntegrationCommand["command"]>(["release"]);

/**
 * Shared entry point for external adapters. Each provider validates its own signature
 * before calling this function; this layer owns only Tinkerbot authorization and IDs.
 */
export function authorizeIntegrationCommand(request: IntegrationRequest): IntegrationCommandResult {
  const command = parseIntegrationCommand(request.text);
  const idempotencyKey = `external:${request.provider}:${request.deliveryId}`;
  if (!command) return { accepted: false, idempotencyKey, reason: "unsupported_command", reply: "Tinkerbot: no supported @tinkerbot command found." };
  const roles = new Set(request.actorRoles);
  if (APPROVER_COMMANDS.has(command.command) && !roles.has("approver")) return { accepted: false, idempotencyKey, command, reason: "authorized_approver_required", reply: "Tinkerbot: approval requires an authorized approver." };
  if (RELEASE_COMMANDS.has(command.command) && !roles.has("release_authority")) return { accepted: false, idempotencyKey, command, reason: "release_authority_required", reply: "Tinkerbot: release requires release authority." };
  if (MUTATING_COMMANDS.has(command.command) && !roles.has("factory_operator") && !roles.has("approver") && !roles.has("release_authority")) return { accepted: false, idempotencyKey, command, reason: "factory_operator_required", reply: "Tinkerbot: this command requires factory-operator permission." };
  const externalReference: ExternalReference = { externalReferenceId: `xref_${crypto.createHash("sha256").update(`${request.provider}:${request.externalId}`).digest("hex").slice(0, 24)}`, provider: request.provider, externalId: request.externalId, aggregateId: request.aggregateId ?? request.factoryId, url: request.externalUrl };
  return { accepted: true, idempotencyKey, command, externalReference, reply: integrationReply({ status: `Tinkerbot accepted @tinkerbot ${command.command}.`, controlPlaneUrl: `/app/factories/${request.factoryId}${request.aggregateId ? `/work/${request.aggregateId}` : ""}` }) };
}

/** Common adapter boundary; each provider validates its native signature before invoking it. */
export function handleAdapterEnvelope(envelope: AdapterEnvelope): IntegrationCommandResult {
  const idempotencyKey = `external:${envelope.provider}:${envelope.deliveryId}`;
  if (!envelope.signatureValid) return { accepted: false, idempotencyKey, reason: "invalid_integration_signature", reply: "Tinkerbot: integration signature was rejected." };
  return authorizeIntegrationCommand({ provider: envelope.provider, externalId: envelope.externalId, externalUrl: envelope.externalUrl, text: envelope.text, actorId: envelope.actorId, actorRoles: envelope.actorRoles, organizationId: envelope.organizationId, factoryId: envelope.factoryId, aggregateId: envelope.aggregateId, deliveryId: envelope.deliveryId });
}
