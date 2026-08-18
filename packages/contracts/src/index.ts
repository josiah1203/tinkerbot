import { parse as parseYaml } from "yaml";
import type { ContractChange, Confidence, Finding, PrProofConfig, ContractReport } from "../../core/src/types";
import { isSourceFile, isTestFile, listFilesAtRevision, readFileAtRevision } from "../../git/src";
import { languageEnabled } from "../../language-core/src";
import { graphForRevision } from "../../parser/src";

interface Operation {
  method: string;
  path: string;
  requiredRequest: string[];
  requiredResponse: string[];
  enums: string[];
  security: string;
}

function contractFiles(files: string[]): string[] {
  return files.filter((file) => /(^|\/)(openapi|swagger|api-contract)([^/]*)(\.ya?ml|\.json)$/i.test(file) || /(^|\/)(openapi|swagger)\.(ya?ml|\.json)$/i.test(file));
}

function parseContract(raw: string, file: string): { operations: Map<string, Operation>; unknowns: string[] } {
  let document: Record<string, unknown>;
  try { document = (file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as Record<string, unknown>; }
  catch { return { operations: new Map(), unknowns: [`Contract file ${file} could not be parsed.`] }; }
  const paths = document.paths && typeof document.paths === "object" ? document.paths as Record<string, unknown> : {};
  const operations = new Map<string, Operation>();
  for (const [route, value] of Object.entries(paths)) {
    if (!value || typeof value !== "object") continue;
    for (const [method, operationValue] of Object.entries(value as Record<string, unknown>)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method.toLowerCase()) || !operationValue || typeof operationValue !== "object") continue;
      const operation = operationValue as Record<string, unknown>;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const requiredRequest = parameters.filter((item) => typeof item === "object" && item && (item as Record<string, unknown>).required === true).map((item) => String((item as Record<string, unknown>).name ?? "parameter")).sort();
      const requestBody = operation.requestBody as Record<string, unknown> | undefined;
      const requestSchema = ((requestBody?.content as Record<string, unknown> | undefined)?.["application/json"] as Record<string, unknown> | undefined)?.schema as Record<string, unknown> | undefined;
      if (Array.isArray(requestSchema?.required)) requiredRequest.push(...requestSchema.required.map(String));
      const responses = operation.responses as Record<string, unknown> | undefined;
      const success = responses && Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))?.[1] as Record<string, unknown> | undefined;
      const responseSchema = (((success?.content as Record<string, unknown> | undefined)?.["application/json"] as Record<string, unknown> | undefined)?.schema as Record<string, unknown> | undefined);
      const requiredResponse = Array.isArray(responseSchema?.required) ? responseSchema.required.map(String).sort() : [];
      const enums = JSON.stringify(operation).match(/"enum"\s*:\s*\[[^\]]*\]/g) ?? [];
      const security = JSON.stringify(operation.security ?? document.security ?? []);
      operations.set(`${method.toUpperCase()} ${route}`, { method: method.toUpperCase(), path: route, requiredRequest: [...new Set(requiredRequest)].sort(), requiredResponse, enums: enums.sort(), security });
    }
  }
  return { operations, unknowns: Object.keys(paths).length ? [] : ["OpenAPI document has no paths; generated or dynamic routes may be outside static analysis."] };
}

function consumers(root: string, revision: string, location: string, config?: PrProofConfig): { files: string[]; tests: string[] } {
  const files = listFilesAtRevision(revision, root).filter((file) => isSourceFile(file) && (!config || languageEnabled(file, config.languages)));
  const found: string[] = [];
  for (const file of files) { const text = readFileAtRevision(revision, file, root) ?? ""; if (text.includes(location)) found.push(file); }
  return { files: found.filter((file) => !isTestFile(file)), tests: found.filter(isTestFile) };
}

function finding(change: ContractChange): Finding {
  const severity = change.kind === "breaking" ? "critical" : change.kind === "potentially_breaking" || change.kind === "unknown" ? "warning" : "info";
  return {
    id: `contract:${change.contractType}:${change.location}:${change.kind}`,
    ruleId: change.kind === "breaking" ? "contract.breaking" : change.kind === "potentially_breaking" ? "contract.potentially-breaking" : change.kind === "unknown" ? "contract.unknown" : "contract.additive",
    category: "contract",
    severity,
    file: change.location.split("#")[0],
    line: 1,
    message: `${change.kind === "breaking" ? "Breaking" : change.kind === "potentially_breaking" ? "Potentially breaking" : change.kind === "additive" ? "Additive" : "Unknown"} ${change.contractType} change at ${change.location}`,
    explanation: `Contract comparison found a ${change.kind} change. Affected consumers: ${change.affectedConsumers.length ? change.affectedConsumers.join(", ") : "none statically resolved"}. Related tests: ${change.relatedTests.length ? change.relatedTests.join(", ") : "none found"}.`,
    evidence: { before: change.before, after: change.after, detail: change.location },
    suggestedAction: change.kind === "breaking" ? "Update consumers and add or update a focused contract/integration test before merging." : change.kind === "unknown" ? "Review the generated or dynamic contract manually and run the full relevant suite." : "Confirm the contract change is intentional and covered by consumers or contract tests.",
    confidence: change.confidence,
    blocking: change.kind === "breaking",
    module: "contracts",
  };
}

export interface ContractOptions { root: string; base: string; head: string; config: PrProofConfig; }

export function analyzeContracts(options: ContractOptions): ContractReport {
  const baseFiles = listFilesAtRevision(options.base, options.root);
  const headFiles = listFilesAtRevision(options.head, options.root);
  const files = [...new Set([...contractFiles(baseFiles), ...contractFiles(headFiles)])].sort();
  const changes: ContractChange[] = [];
  const unknowns: string[] = [];
  for (const file of files.slice(0, options.config.limits.max_files_analyzed)) {
    const baseText = readFileAtRevision(options.base, file, options.root);
    const headText = readFileAtRevision(options.head, file, options.root);
    if (!baseText && headText) {
      changes.push({ kind: "additive", contractType: "openapi", location: file, after: headText.slice(0, 2000), affectedConsumers: [], relatedTests: [], confidence: "medium" });
      continue;
    }
    if (baseText && !headText) {
      changes.push({ kind: "breaking", contractType: "openapi", location: file, before: baseText.slice(0, 2000), affectedConsumers: [], relatedTests: [], confidence: "high" });
      continue;
    }
    if (!baseText || !headText) continue;
    const before = parseContract(baseText, file);
    const after = parseContract(headText, file);
    unknowns.push(...before.unknowns, ...after.unknowns);
    const keys = [...new Set([...before.operations.keys(), ...after.operations.keys()])].sort();
    for (const key of keys) {
      const oldOperation = before.operations.get(key);
      const newOperation = after.operations.get(key);
      const routeConsumers = consumers(options.root, options.head, key.split(" ").slice(1).join(" "), options.config);
      if (oldOperation && !newOperation) changes.push({ kind: "breaking", contractType: "openapi", location: `${file}#${key}`, before: JSON.stringify(oldOperation), affectedConsumers: routeConsumers.files, relatedTests: routeConsumers.tests, confidence: "high" });
      else if (!oldOperation && newOperation) changes.push({ kind: "additive", contractType: "openapi", location: `${file}#${key}`, after: JSON.stringify(newOperation), affectedConsumers: routeConsumers.files, relatedTests: routeConsumers.tests, confidence: "high" });
      else if (oldOperation && newOperation) {
        const addedRequired = newOperation.requiredRequest.filter((field) => !oldOperation.requiredRequest.includes(field));
        const removedResponse = oldOperation.requiredResponse.filter((field) => !newOperation.requiredResponse.includes(field));
        const securityChanged = oldOperation.security !== newOperation.security;
        if (addedRequired.length) changes.push({ kind: "breaking", contractType: "openapi", location: `${file}#${key} request`, before: JSON.stringify(oldOperation.requiredRequest), after: JSON.stringify(newOperation.requiredRequest), affectedConsumers: routeConsumers.files, relatedTests: routeConsumers.tests, confidence: "high" });
        if (removedResponse.length) changes.push({ kind: "breaking", contractType: "openapi", location: `${file}#${key} response`, before: JSON.stringify(oldOperation.requiredResponse), after: JSON.stringify(newOperation.requiredResponse), affectedConsumers: routeConsumers.files, relatedTests: routeConsumers.tests, confidence: "high" });
        if (securityChanged) changes.push({ kind: "potentially_breaking", contractType: "openapi", location: `${file}#${key} security`, before: oldOperation.security, after: newOperation.security, affectedConsumers: routeConsumers.files, relatedTests: routeConsumers.tests, confidence: "medium" });
      }
    }
  }
  const sourceFiles = [...new Set([...baseFiles, ...headFiles])].filter((file) => isSourceFile(file) && languageEnabled(file, options.config.languages)).slice(0, options.config.limits.max_files_analyzed);
  const graphOptions = {
    validateSyntax: options.config.validation.toolchain_checks,
    validationTimeoutMs: Math.min(5_000, options.config.framework.test_timeout_seconds * 1_000),
    maxValidatedFiles: Math.min(options.config.limits.max_files_analyzed, 250),
  };
  const baseGraph = graphForRevision(options.root, options.base, sourceFiles, (revision, file) => readFileAtRevision(revision, file, options.root), graphOptions);
  const headGraph = graphForRevision(options.root, options.head, sourceFiles, (revision, file) => readFileAtRevision(revision, file, options.root), graphOptions);
  unknowns.push(...baseGraph.unknowns, ...headGraph.unknowns);
  for (const file of sourceFiles) {
    const before = new Set(baseGraph.modules.get(file)?.exports ?? []);
    const after = new Set(headGraph.modules.get(file)?.exports ?? []);
    const contractType = ["typescript", "javascript"].includes(headGraph.modules.get(file)?.language ?? baseGraph.modules.get(file)?.language ?? "") ? "typescript_exports" : "source_exports";
    for (const name of before) if (!after.has(name)) {
      const related = consumers(options.root, options.head, name, options.config);
      changes.push({ kind: "breaking", contractType, location: `${file}#${name}`, before: name, affectedConsumers: related.files, relatedTests: related.tests, confidence: "high" });
    }
    for (const name of after) if (!before.has(name)) changes.push({ kind: "additive", contractType, location: `${file}#${name}`, after: name, affectedConsumers: [], relatedTests: [], confidence: "high" });
  }
  if (!files.length) unknowns.push("No OpenAPI or Swagger contract file was found; source export comparison is the available contract evidence.");
  const deduped = [...new Map(changes.map((change) => [`${change.contractType}:${change.location}:${change.kind}`, change])).values()].sort((a, b) => `${a.kind}:${a.location}`.localeCompare(`${b.kind}:${b.location}`));
  return { filesAnalyzed: files.length + sourceFiles.length, changes: deduped, findings: deduped.map(finding), unknowns: [...new Set(unknowns)] };
}
