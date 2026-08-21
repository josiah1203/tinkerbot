import type { D1DatabaseLike } from "../../../packages/hosted-integrations/src";
import {
  applyFactoryTree,
  assertFactoryTreeIntegrity,
  containsRawCredentials,
  factoryDefinitionDigest,
  parseFactoryDefinition,
  type FactoryDefinition,
  validateFactoryDefinition,
} from "../../../packages/factory/src";

export interface FactoryRecord {
  factoryId: string;
  organizationId: string;
  name: string;
  status: string;
  definitionDigest?: string;
}

export interface FactoryDefinitionStoreDependencies {
  replaceAutomations(factoryId: string, automations: FactoryDefinition["automations"], now: string): Promise<void>;
}

export class D1FactoryDefinitionStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly dependencies: FactoryDefinitionStoreDependencies,
  ) {}

  async listFactories(organizationId: string): Promise<Array<{ factoryId: string; name: string; status: string; updatedAt: string }>> {
    const statement = this.database.prepare("SELECT factory_id, name, status, updated_at FROM tinkerbot_factories WHERE organization_id = ?1 ORDER BY updated_at DESC").bind(organizationId);
    if (typeof statement.all !== "function") return [];
    const result = await statement.all<{ factory_id: string; name: string; status: string; updated_at: string }>();
    return (result.results ?? []).map((row) => ({ factoryId: row.factory_id, name: row.name, status: row.status, updatedAt: row.updated_at }));
  }

  async getFactory(factoryId: string): Promise<FactoryRecord | null> {
    const row = await this.database.prepare("SELECT factory_id, organization_id, name, status, definition_digest FROM tinkerbot_factories WHERE factory_id = ?1").bind(factoryId).first<{ factory_id: string; organization_id: string; name: string; status: string; definition_digest?: string | null }>();
    return row ? { factoryId: row.factory_id, organizationId: row.organization_id, name: row.name, status: row.status, definitionDigest: row.definition_digest ?? undefined } : null;
  }

  async putFactory(input: { factoryId: string; organizationId: string; name: string; yaml?: string; files?: Array<{ path: string; contents: string }>; now?: string }): Promise<{ factoryId: string; digest?: string }> {
    const now = input.now ?? new Date().toISOString();
    let digest: string | undefined;
    const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.factoryId)) throw new Error("Factory id is invalid.");
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,199}$/.test(input.name.trim())) throw new Error("Factory name is invalid.");
    const existing = await this.getFactory(input.factoryId);
    if (existing && existing.organizationId !== input.organizationId) throw new Error("Factory belongs to another organization.");
    if (input.yaml !== undefined && (typeof input.yaml !== "string" || input.yaml.length === 0 || bytes(input.yaml) > 512_000)) throw new Error("Factory YAML must be between 1 and 512000 bytes.");
    const normalizedFiles = input.files?.map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }));
    if (normalizedFiles && (normalizedFiles.length > 128 || normalizedFiles.some((file) => !file || typeof file.path !== "string" || !file.path || file.path.length > 512 || bytes(file.path) > 2_048 || file.path.includes("\0") || file.path.startsWith("/") || file.path.split("/").includes("..") || typeof file.contents !== "string" || bytes(file.contents) > 512_000))) throw new Error("Factory files exceed the allowed count, path, or content limits.");
    if (normalizedFiles && new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) throw new Error("Factory file paths must be unique.");
    if (normalizedFiles) assertFactoryTreeIntegrity(normalizedFiles);
    if (normalizedFiles && normalizedFiles.reduce((total, file) => total + bytes(file.contents), 0) > 4_000_000) throw new Error("Factory files exceed the 4 MB content limit.");
    if ((input.yaml !== undefined || normalizedFiles) && containsRawCredentials({ yaml: input.yaml, files: normalizedFiles })) throw new Error("Factory definitions must not contain raw credentials.");
    if (input.yaml) {
      let definition = parseFactoryDefinition(input.yaml);
      const definitionFile = normalizedFiles?.find((file) => file.path === ".tinkerbot/factory.yaml");
      if (definitionFile && definitionFile.contents !== input.yaml) throw new Error("Factory YAML must match the .tinkerbot/factory.yaml file payload.");
      if (normalizedFiles?.length) definition = applyFactoryTree(definition, normalizedFiles);
      const definitionErrors = validateFactoryDefinition(definition, { requireForeman: definition.schemaVersion === "v1alpha1" || definition.agents.some((agent) => agent.agentType === "FOREMAN") });
      if (definitionErrors.length) throw new Error(`Invalid factory definition: ${definitionErrors.join("; ")}`);
      digest = factoryDefinitionDigest(definition);
      const definitionId = crypto.randomUUID();
      await this.database.prepare("INSERT INTO tinkerbot_factory_definitions (definition_id, factory_id, digest, yaml, files_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(definitionId, input.factoryId, digest, input.yaml, normalizedFiles?.length ? JSON.stringify(normalizedFiles) : null, now).run();
      await this.database.prepare("INSERT INTO tinkerbot_factory_definition_versions (version_id, factory_id, definition_id, version, digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(crypto.randomUUID(), input.factoryId, definitionId, Date.now(), digest, now).run();
      await this.dependencies.replaceAutomations(input.factoryId, definition.automations ?? [], now);
    }
    await this.database.prepare("INSERT INTO tinkerbot_factories (factory_id, organization_id, name, status, definition_digest, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5) ON CONFLICT(factory_id) DO UPDATE SET name = excluded.name, definition_digest = COALESCE(excluded.definition_digest, tinkerbot_factories.definition_digest), updated_at = excluded.updated_at").bind(input.factoryId, input.organizationId, input.name, digest ?? null, now).run();
    return { factoryId: input.factoryId, digest };
  }

  async getLatestDefinition(factoryId: string): Promise<{ yaml: string; files: Array<{ path: string; contents: string }>; digest: string } | null> {
    const row = await this.database.prepare("SELECT yaml, files_json, digest FROM tinkerbot_factory_definitions WHERE factory_id = ?1 ORDER BY created_at DESC").bind(factoryId).first<{ yaml: string; files_json?: string | null; digest: string }>();
    if (!row) return null;
    let files: Array<{ path: string; contents: string }> = [];
    if (row.files_json) {
      try {
        const parsed = JSON.parse(row.files_json) as unknown;
        if (Array.isArray(parsed)) files = parsed.filter((item): item is { path: string; contents: string } => Boolean(item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" && typeof (item as { contents?: unknown }).contents === "string"));
      } catch { /* Stored files_json that is not an array is treated as missing files. */ }
    }
    return { yaml: row.yaml, files, digest: row.digest };
  }
}
