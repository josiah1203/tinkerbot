import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

const localChecks = [];
function check(name, ok, detail) {
  localChecks.push({ name, ok: Boolean(ok), detail });
}

const requiredFiles = [
  "docs/architecture-map.md",
  "docs/release-readiness.md",
  "docs/adr/0010-durable-factory-spine.md",
  "docs/adr/0011-hosted-production-closure-and-differentiation-sequencing.md",
  "apps/control-plane-worker/wrangler.jsonc",
  "apps/control-plane-worker/.env.example",
  "apps/control-plane-worker/migrations/0023_factory_command_telemetry_retention.sql",
  "apps/control-plane-worker/migrations/0024_factory_operational_telemetry.sql",
  "packages/factory/src/telemetry.ts",
  "packages/local-runtime/src/sqlite-store.ts",
  "apps/control-plane-worker/src/factory-store.ts",
  "apps/control-plane-worker/src/foreman-routes.ts",
  "apps/control-plane-worker/src/factory-maintenance.ts",
  "apps/control-plane-worker/src/factory-request.ts",
  "apps/control-plane-worker/src/factory-definition-store.ts",
  "apps/control-plane-worker/src/factory-graph-store.ts",
  "apps/control-plane-worker/src/factory-artifact-store.ts",
  "apps/control-plane-worker/src/factory-operations-store.ts",
  "apps/control-plane-worker/src/assurance-routes.ts",
  "apps/control-plane-worker/src/factory-projection-store.ts",
  "apps/control-plane-worker/src/factory-telemetry-store.ts",
  "apps/control-plane-worker/src/factory-workspace-store.ts",
  "apps/control-plane-worker/src/factory-read-model.ts",
  "apps/control-plane-worker/src/factory-executor.ts",
  "apps/control-plane-worker/src/workos-sync.ts",
  "apps/control-plane-worker/src/billing-routes.ts",
  "apps/control-plane-worker/src/tenant-auth.ts",
  "apps/control-plane-worker/src/tenant-routes.ts",
  "apps/control-plane-worker/src/github-integrations.ts",
  "apps/control-plane-worker/src/integration-routes.ts",
  "apps/control-plane-worker/src/self-hosted-routes.ts",
  "packages/hosted-integrations/src/d1-stores.ts",
  "packages/hosted-integrations/src/evidence-store.ts",
  "packages/hosted-integrations/src/provider-core.ts",
  "packages/hosted-integrations/src/workos-provider.ts",
  "packages/hosted-integrations/src/stripe-provider.ts",
  "apps/control-plane/server.mjs",
];
for (const relativePath of requiredFiles) check(`required:${relativePath}`, exists(relativePath), "file present");

const packageJson = JSON.parse(read("package.json"));
for (const scriptName of ["verify:tree", "typecheck", "test", "release:dry-run"]) {
  check(`package-script:${scriptName}`, typeof packageJson.scripts?.[scriptName] === "string", "script registered");
}

const migrations = fs.readdirSync(path.join(root, "apps/control-plane-worker/migrations"))
  .map((file) => /^([0-9]+)_.*\.sql$/.exec(file)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((left, right) => left - right);
const expectedMigrations = Array.from({ length: migrations.at(-1) ?? 0 }, (_, index) => index + 1);
check("migrations:contiguous", JSON.stringify(migrations) === JSON.stringify(expectedMigrations), `found ${migrations.length} contiguous migrations`);
check("migrations:telemetry-retention", migrations.includes(23), "migration 0023 is present");
check("migrations:operational-telemetry", migrations.includes(24), "migration 0024 is present");

const telemetrySource = read("packages/factory/src/telemetry.ts");
const runtimeSource = read("packages/factory/src/runtime.ts");
check("telemetry:typed-operational-signal", telemetrySource.includes('kind: "factory_operational"') && telemetrySource.includes("FACTORY_OPERATIONAL_SIGNALS"), "signal names and runtime guard are typed");
check("telemetry:no-sensitive-dimensions", /payload\|prompt\|secret\|credential\|token\|authorization/.test(telemetrySource), "sensitive dimension keys are rejected");
check("telemetry:retention-bounded", telemetrySource.includes("FACTORY_COMMAND_TELEMETRY_MAX_RETENTION_DAYS") && telemetrySource.includes("parseFactoryTelemetryRetentionDays"), "retention input is bounded");
check("runtime:canonical-capabilities", runtimeSource.includes("normalizeRunnerKind") && runtimeSource.includes("normalizeInferenceProvider") && runtimeSource.includes("runtimeCapabilityDecision") && runtimeSource.includes("RuntimeCapabilityError"), "runner/provider identifiers and executable capability decisions share a typed runtime boundary");

const sqliteSource = read("packages/local-runtime/src/sqlite-store.ts");
const d1Source = read("apps/control-plane-worker/src/factory-store.ts");
const foremanRoutesSource = read("apps/control-plane-worker/src/foreman-routes.ts");
const maintenanceSource = read("apps/control-plane-worker/src/factory-maintenance.ts");
const requestSource = read("apps/control-plane-worker/src/factory-request.ts");
const definitionStoreSource = read("apps/control-plane-worker/src/factory-definition-store.ts");
const graphStoreSource = read("apps/control-plane-worker/src/factory-graph-store.ts");
const artifactStoreSource = read("apps/control-plane-worker/src/factory-artifact-store.ts");
const operationsStoreSource = read("apps/control-plane-worker/src/factory-operations-store.ts");
const assuranceRoutesSource = read("apps/control-plane-worker/src/assurance-routes.ts");
const projectionSource = read("apps/control-plane-worker/src/factory-projection-store.ts");
const telemetryStoreSource = read("apps/control-plane-worker/src/factory-telemetry-store.ts");
const workspaceStoreSource = read("apps/control-plane-worker/src/factory-workspace-store.ts");
const readModelSource = read("apps/control-plane-worker/src/factory-read-model.ts");
const factoryRuntimeSource = read("apps/control-plane-worker/src/factory-runtime.ts");
const workosSource = read("apps/control-plane-worker/src/workos-sync.ts");
const billingRoutesSource = read("apps/control-plane-worker/src/billing-routes.ts");
const tenantAuthSource = read("apps/control-plane-worker/src/tenant-auth.ts");
const tenantRoutesSource = read("apps/control-plane-worker/src/tenant-routes.ts");
const githubIntegrationsSource = read("apps/control-plane-worker/src/github-integrations.ts");
const integrationRoutesSource = read("apps/control-plane-worker/src/integration-routes.ts");
const selfHostedRoutesSource = read("apps/control-plane-worker/src/self-hosted-routes.ts");
const hostedIntegrationsSource = read("packages/hosted-integrations/src/index.ts");
const hostedD1Source = read("packages/hosted-integrations/src/d1-stores.ts");
const hostedEvidenceSource = read("packages/hosted-integrations/src/evidence-store.ts");
const providerCoreSource = read("packages/hosted-integrations/src/provider-core.ts");
const workosProviderSource = read("packages/hosted-integrations/src/workos-provider.ts");
const stripeProviderSource = read("packages/hosted-integrations/src/stripe-provider.ts");
const dashboardServerSource = read("apps/control-plane/server.mjs");
check("telemetry:sqlite-sink", sqliteSource.includes("setTelemetrySink") && sqliteSource.includes("persistCommandTelemetry"), "SQLite command telemetry sink is wired");
check("telemetry:sqlite-cleanup", sqliteSource.includes("pruneCommandTelemetry") && sqliteSource.includes("DELETE FROM tinkerbot_factory_command_telemetry"), "SQLite cleanup is telemetry-only");
check("telemetry:d1-sink", d1Source.includes("telemetryStore.persistOperationalSignal") && telemetryStoreSource.includes("persistOperationalSignal") && telemetryStoreSource.includes("tinkerbot_factory_operational_telemetry"), "D1 operational signal sink is wired through the telemetry adapter");
check("telemetry:d1-cleanup", d1Source.includes("telemetryStore.pruneTelemetry") && telemetryStoreSource.includes("DELETE FROM tinkerbot_factory_command_telemetry") && telemetryStoreSource.includes("DELETE FROM tinkerbot_factory_operational_telemetry"), "D1 cleanup is telemetry-only through the telemetry adapter");
check("maintainability:executor-boundary", factoryRuntimeSource.includes("dispatchSelfHostedWork") && !factoryRuntimeSource.includes("class Sandbox"), "hosted executor behavior is isolated from the Factory runtime coordinator");
check("maintainability:foreman-boundary", foremanRoutesSource.includes("class ForemanDurableObject") && foremanRoutesSource.includes("runForemanWorkDecision") && !factoryRuntimeSource.includes("class ForemanDurableObject"), "serialized Foreman admission and typed decisions are isolated from the Factory runtime coordinator");
check("maintainability:maintenance-boundary", maintenanceSource.includes("sweepFactoryOs") && maintenanceSource.includes("scheduledMaintenanceTask") && !factoryRuntimeSource.includes("export async function sweepFactoryOs"), "scheduled Factory OS maintenance is isolated from the runtime coordinator");
check("maintainability:request-boundary", requestSource.includes("boundedJsonObject") && foremanRoutesSource.includes("./factory-request") && factoryRuntimeSource.includes("./factory-request"), "bounded JSON admission is shared through an explicit request boundary");
check("maintainability:workos-boundary", workosSource.includes("applyWorkOSEvent") && workosSource.includes("reconcileWorkOSEvents") && workosSource.includes("D1TenantStore"), "WorkOS membership and event reconciliation are isolated from the Worker route entrypoint");
check("maintainability:billing-boundary", billingRoutesSource.includes("handleBillingRoute") && billingRoutesSource.includes("reconcileBilling") && billingRoutesSource.includes("StripeBillingProvider") && !billingRoutesSource.includes("routeFactory") && !billingRoutesSource.includes("runFactoryTurn"), "billing provider/account routes are isolated from Factory lifecycle dispatch");
check("maintainability:tenant-auth-boundary", tenantAuthSource.includes("authorizeTenantSession") && tenantAuthSource.includes("ROLE_CAPABILITIES") && tenantAuthSource.includes("currentServiceCredential") && !factoryRuntimeSource.includes("ROLE_CAPABILITIES"), "session, tenant capability, and service-credential authorization are isolated from Factory lifecycle dispatch");
check("maintainability:tenant-route-boundary", tenantRoutesSource.includes("handleTenantRoute") && tenantRoutesSource.includes("/auth/workos/start") && tenantRoutesSource.includes("/tenant/invitations") && !read("apps/control-plane-worker/src/index.ts").includes('if (url.pathname === "/auth/workos/start"'), "OAuth, session, organization, membership, invitation, and sign-out routes are isolated from the Worker entrypoint");
check("maintainability:github-boundary", githubIntegrationsSource.includes("persistGitHubWebhook") && githubIntegrationsSource.includes("publishVerificationToGitHub") && githubIntegrationsSource.includes("mintInstallationToken") && !read("apps/control-plane-worker/src/index.ts").includes("async function persistGitHubWebhook") && !read("apps/control-plane-worker/src/index.ts").includes("async function publishVerificationToGitHub"), "GitHub intake persistence and verification publication are isolated from the Worker route entrypoint");
check("maintainability:integration-route-boundary", integrationRoutesSource.includes("handleIntegrationRoute") && integrationRoutesSource.includes("admitWebhook") && integrationRoutesSource.includes("WorkOSAuthProvider") && !read("apps/control-plane-worker/src/index.ts").includes('if (url.pathname === "/integrations/github/webhook"') && !read("apps/control-plane-worker/src/index.ts").includes("verifyIntegrationWebhook"), "provider webhook admission, integration command dispatch, and GitHub/WorkOS installation routes are isolated from the Worker entrypoint");
check("maintainability:self-hosted-route-boundary", selfHostedRoutesSource.includes("handleSelfHostedCompletion") && selfHostedRoutesSource.includes("verifySelfHostedCompletion") && !read("apps/control-plane-worker/src/index.ts").includes('if (url.pathname === "/self-hosted/complete"'), "signed self-hosted completion and graph resume are isolated from the Worker route entrypoint");
check("maintainability:telemetry-boundary", d1Source.includes("D1FactoryTelemetryStore") && !d1Source.includes("INSERT INTO tinkerbot_factory_operational_telemetry") && telemetryStoreSource.includes("class D1FactoryTelemetryStore"), "D1 command and operational telemetry are isolated from graph/domain persistence");
check("maintainability:projection-boundary", d1Source.includes("D1FactoryProjectionStore") && !d1Source.includes("createFactoryProjectionCheckpoint") && projectionSource.includes("class D1FactoryProjectionStore") && projectionSource.includes("shadowReadOrganization"), "D1 graph persistence delegates checkpoint, compatibility projection, and shadow-read concerns to an explicit adapter boundary");
check("maintainability:workspace-boundary", d1Source.includes("D1FactoryWorkspaceStore") && workspaceStoreSource.includes("class D1FactoryWorkspaceStore") && workspaceStoreSource.includes("listEnvironments") && workspaceStoreSource.includes("replaceAutomations"), "workspace metadata and read-model persistence are isolated from graph and command authority");
check("maintainability:read-model-boundary", d1Source.includes("D1FactoryReadModel") && d1Source.includes("return this.readModel.getWorkOrderView") && readModelSource.includes("class D1FactoryReadModel") && readModelSource.includes("projectFactoryEvents"), "graph-derived operator and WorkOrder views are isolated from D1 lifecycle persistence");
check("maintainability:artifact-boundary", d1Source.includes("D1FactoryArtifactStore") && d1Source.includes("return this.artifactStore.getRun") && artifactStoreSource.includes("class D1FactoryArtifactStore") && !artifactStoreSource.includes("FactoryCommandBoundary") && !artifactStoreSource.includes("tinkerbot_factory_graph_events"), "run, evidence, cost, execution-plan, token, publication, and evaluation artifacts are isolated from graph command authority");
check("maintainability:operations-boundary", d1Source.includes("D1FactoryOperationsStore") && d1Source.includes("return this.operationsStore.approveProposal") && operationsStoreSource.includes("class D1FactoryOperationsStore") && operationsStoreSource.includes("approveProposal") && !operationsStoreSource.includes("tinkerbot_factory_graph_events"), "Factory cells, products, skills, proposals, releases, deployments, outcomes, scorers, and self-improvement metadata are isolated from graph command authority");
check("maintainability:definition-boundary", d1Source.includes("D1FactoryDefinitionStore") && definitionStoreSource.includes("class D1FactoryDefinitionStore") && definitionStoreSource.includes("factoryDefinitionDigest") && !d1Source.includes("applyFactoryTree") && !d1Source.includes("assertFactoryTreeIntegrity"), "factory definition validation, digesting, versioning, and automation replacement are isolated from graph command authority");
check("maintainability:graph-persistence-boundary", d1Source.includes("D1FactoryGraphStore") && graphStoreSource.includes("class D1FactoryGraphStore") && d1Source.includes("return this.graphStore.appendFactoryCommand") && !d1Source.includes("INSERT INTO tinkerbot_factory_graph_events"), "D1 graph event, outbox, command-receipt, and replay persistence are isolated behind the graph storage adapter while the façade retains command authority");
check("maintainability:assurance-route-boundary", assuranceRoutesSource.includes("handleAssuranceRoute") && assuranceRoutesSource.includes("validateHostedAssuranceBundle") && assuranceRoutesSource.includes("verifyHostedReceipt") && !read("apps/control-plane-worker/src/index.ts").includes('if (url.pathname === "/assurance/ingest"'), "hosted assurance validation, receipt binding, evidence publication, and verification reconciliation are isolated from the Worker entrypoint");
check("maintainability:hosted-d1-boundary", hostedD1Source.includes("class D1TenantStore") && hostedD1Source.includes("class D1AuthSessionStore") && hostedD1Source.includes("class D1WebhookLedger") && !hostedIntegrationsSource.includes("class D1TenantStore") && !hostedIntegrationsSource.includes("class D1AuthSessionStore"), "D1 metadata, tenant, session, billing, and webhook persistence are isolated from hosted provider protocol clients");
check("maintainability:evidence-boundary", hostedEvidenceSource.includes("class R2JsonEvidenceStore") && hostedEvidenceSource.includes("class HttpEvidenceReplica") && hostedEvidenceSource.includes("class FanoutEvidenceStore") && !hostedIntegrationsSource.includes("class R2JsonEvidenceStore") && !hostedIntegrationsSource.includes("class FanoutEvidenceStore"), "R2 evidence persistence and optional replication are isolated from hosted provider protocol clients");
check("maintainability:provider-protocol-boundary", providerCoreSource.includes("class ProviderError") && workosProviderSource.includes("class WorkOSAuthProvider") && stripeProviderSource.includes("class StripeBillingProvider") && !hostedIntegrationsSource.includes("class WorkOSAuthProvider") && !hostedIntegrationsSource.includes("class StripeBillingProvider"), "WorkOS and Stripe protocol clients are isolated from the hosted integration contract facade");
check("maintainability:dashboard-preview-boundary", dashboardServerSource.includes("CONTROL_PLANE_MODE") && dashboardServerSource.includes("previewBackendEnabled") && dashboardServerSource.includes("preview_backend_disabled"), "the local in-memory dashboard fixture is explicitly disabled for production-mode static serving");

const workerConfig = read("apps/control-plane-worker/wrangler.jsonc");
const envExample = read("apps/control-plane-worker/.env.example");
check("worker:retention-configured", workerConfig.includes('"FACTORY_TELEMETRY_RETENTION_DAYS": "30"') && envExample.includes("FACTORY_TELEMETRY_RETENTION_DAYS=30"), "retention is explicitly configured with a disposable default");

const adr = read("docs/adr/0010-durable-factory-spine.md");
const adr0011 = read("docs/adr/0011-hosted-production-closure-and-differentiation-sequencing.md");
const architectureMap = read("docs/architecture-map.md");
const readiness = read("docs/release-readiness.md");
check("docs:adr-state", adr.includes("Proposed") && adr.includes("self-hosted") && adr.includes("feature-gated"), "ADR records the current executor decision and external status");
check("docs:adr-0011", adr0011.includes("Hosted Production Closure") && adr0011.includes("Gate A") && adr0011.includes("Differentiation"), "ADR-0011 records hosted closure gates and guarded differentiation sequencing");
check("docs:architecture-gates", architectureMap.includes("Open gates before production authority"), "architecture map keeps external gates visible");
check("docs:readiness-gates", readiness.includes("Open gates are:") && readiness.includes("self-hosted"), "release readiness separates local proof from external proof");

const externalGates = [
  { name: "workflow_runtime_contract", status: "pending", evidence: "Implement FactoryRunWorkflow as an official WorkflowEntrypoint with a durable step and a real caller, or remove the unused FACTORY_RUN binding." },
  { name: "canonical_commit_and_fresh_checkout", status: "pending", evidence: "Commit the canonical tree and reproduce the release checks from a clean checkout." },
  { name: "staging_shadow_read_soak", status: "pending", evidence: "Run the scheduled shadow-read sweep against staging and record a zero-divergence soak." },
  { name: "hosted_self_hosted_lifecycle", status: "pending", evidence: "Prove one real self-hosted dispatch, callback, verification, and terminal outcome." },
  { name: "provider_and_secret_provisioning", status: "pending", evidence: "Provision and verify Cloudflare, WorkOS, Stripe, GitHub OIDC, and signing resources in the target environment." },
  { name: "ci_deploy_and_signing_evidence", status: "pending", evidence: "Record successful CI/deploy, artifact signing, and provenance verification." },
  { name: "branch_reconciliation", status: "pending", evidence: "Reconcile the remaining branch/worktree variants or explicitly archive them with provenance." },
  { name: "module_decomposition", status: "pending", evidence: "Executor, Foreman admission/decision routing, bounded request parsing, scheduled maintenance, WorkOS synchronization, billing route, tenant authorization and routes, hosted assurance, provider intake routes, GitHub integration, signed self-hosted completion, D1 graph persistence, D1 projection, D1 telemetry, workspace metadata, factory definition persistence, graph-derived read models, run/evidence/cost artifacts, Factory operations metadata, hosted D1 storage, evidence, and provider protocol boundaries are extracted; continue reducing the largest Worker and Factory façade modules before treating maintainability as closed." },
];

const passed = localChecks.filter((item) => item.ok).length;
const localOk = passed === localChecks.length;
const report = {
  status: localOk ? "local_pass_external_pending" : "local_failed",
  readyForProductionAuthority: false,
  localChecks: { passed, total: localChecks.length, items: localChecks },
  externalGates,
};
console.log(JSON.stringify(report, null, 2));
if (!localOk) process.exitCode = 1;
