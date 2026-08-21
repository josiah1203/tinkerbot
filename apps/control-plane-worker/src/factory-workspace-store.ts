import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import type { FactoryDefinition } from "../../../packages/factory/src";

export type WorkspaceEnvironment = { id: string; name: string; status: string; owner?: string; updatedAt: string; factoryId?: string };
export type WorkspaceIntegration = { id: string; name: string; kind: string; status: string; owner?: string; updatedAt: string; scopes?: string };
export type WorkspaceSecretMetadata = { id: string; name: string; status: string; owner?: string; updatedAt: string; references?: string };

/**
 * Read-model and workspace metadata persistence is intentionally separate from
 * the Factory Graph/command ledger. These rows support operator surfaces and
 * configuration UX; they cannot advance lifecycle state.
 */
export class D1FactoryWorkspaceStore {
  constructor(private readonly database: D1DatabaseLike) {}

  async listEnvironments(organizationId: string): Promise<WorkspaceEnvironment[]> {
    const statement = this.database.prepare("SELECT environment_id, name, status, owner, factory_id, updated_at FROM tinkerbot_environments WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ environment_id: string; name: string; status: string; owner?: string | null; factory_id?: string | null; updated_at: string }>();
    return (result.results ?? []).map((row) => ({ id: row.environment_id, name: row.name, status: row.status, owner: row.owner ?? undefined, factoryId: row.factory_id ?? undefined, updatedAt: row.updated_at }));
  }

  async listIntegrations(organizationId: string): Promise<WorkspaceIntegration[]> {
    const statement = this.database.prepare("SELECT integration_id, name, kind, status, owner, scopes, updated_at FROM tinkerbot_integrations WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ integration_id: string; name: string; kind: string; status: string; owner?: string | null; scopes?: string | null; updated_at: string }>();
    return (result.results ?? []).map((row) => ({ id: row.integration_id, name: row.name, kind: row.kind, status: row.status, owner: row.owner ?? undefined, scopes: row.scopes ?? undefined, updatedAt: row.updated_at }));
  }

  async listSecretMetadata(organizationId: string): Promise<WorkspaceSecretMetadata[]> {
    const statement = this.database.prepare("SELECT secret_id, name, status, owner, references_text, updated_at FROM tinkerbot_secret_metadata WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ secret_id: string; name: string; status: string; owner?: string | null; references_text?: string | null; updated_at: string }>();
    return (result.results ?? []).map((row) => ({ id: row.secret_id, name: row.name, status: row.status, owner: row.owner ?? undefined, references: row.references_text ?? undefined, updatedAt: row.updated_at }));
  }

  async createSecretMetadata(input: { organizationId: string; name: string; reference: string; owner: string; now: string }): Promise<WorkspaceSecretMetadata> {
    const id = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_secret_metadata (secret_id, organization_id, name, status, owner, references_text, updated_at) VALUES (?1, ?2, ?3, 'managed', ?4, ?5, ?6)").bind(id, input.organizationId, input.name, input.owner, input.reference, input.now).run();
    return { id, name: input.name, status: "managed", owner: input.owner, references: input.reference, updatedAt: input.now };
  }

  async createIntegrationMetadata(input: { organizationId: string; name: string; kind: string; now: string }): Promise<WorkspaceIntegration> {
    const id = crypto.randomUUID();
    await this.database.prepare("INSERT INTO tinkerbot_integrations (integration_id, organization_id, name, kind, status, owner, scopes, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', 'Workspace', 'Awaiting configuration', ?5)").bind(id, input.organizationId, input.name, input.kind, input.now).run();
    return { id, name: input.name, kind: input.kind, status: "pending", owner: "Workspace", scopes: "Awaiting configuration", updatedAt: input.now };
  }

  async replaceAutomations(factoryId: string, automations: FactoryDefinition["automations"], now: string): Promise<void> {
    await this.database.prepare("DELETE FROM tinkerbot_automations WHERE factory_id = ?1").bind(factoryId).run();
    for (const automation of automations) {
      await this.database.prepare("INSERT INTO tinkerbot_automations (automation_id, factory_id, trigger, agent_id, enabled, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(`${factoryId}:${automation.name}`, factoryId, JSON.stringify(automation.triggers), automation.agent, automation.enabled ? 1 : 0, now).run();
    }
  }
}
