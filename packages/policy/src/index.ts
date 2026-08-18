import type { Finding, PrProofConfig, Severity } from "../../core/src/types";

export interface PolicyRule {
  ruleId: string;
  severity?: Severity;
  blocking: boolean;
  requiredEvidence: string[];
  unknownHandling: "advisory" | "fail";
  pathExclusions?: string[];
}

export interface PolicyPack {
  id: string;
  displayName: string;
  description: string;
  enabledRules: string[];
  rules: PolicyRule[];
  unknownHandling: "advisory" | "fail";
  rationale: string;
  limits: Partial<PrProofConfig["limits"]>;
}

const ALL = ["test_integrity", "coverage", "mutation", "impact", "contract", "fixture"];

const PACKS: Record<string, PolicyPack> = {
  default: {
    id: "default",
    displayName: "Default advisory",
    description: "Conservative evidence review with optional evidence reported as UNKNOWN.",
    enabledRules: ALL,
    rules: [],
    unknownHandling: "advisory",
    rationale: "The default pack preserves the MVP advisory behavior and does not block missing optional evidence.",
    limits: {},
  },
  strict: {
    id: "strict",
    displayName: "Strict verification",
    description: "Blocks high-confidence actionable findings and treats incomplete evidence as a release concern.",
    enabledRules: ALL,
    rules: [{ ruleId: "*", blocking: true, requiredEvidence: ["location", "evidence"], unknownHandling: "fail" }],
    unknownHandling: "fail",
    rationale: "Use only when the repository explicitly wants evidence gaps and actionable findings to gate merges.",
    limits: { max_findings: 500 },
  },
  "public-api": {
    id: "public-api",
    displayName: "Public API guard",
    description: "Prioritizes public exports, contract changes, and downstream consumer evidence.",
    enabledRules: ["impact", "contract", "test_integrity"],
    rules: [{ ruleId: "impact.unverified", blocking: true, requiredEvidence: ["location", "consumer-graph"], unknownHandling: "fail" }, { ruleId: "contract.*", blocking: true, requiredEvidence: ["before", "after"], unknownHandling: "fail" }],
    unknownHandling: "fail",
    rationale: "Public surfaces need explicit consumer and compatibility evidence before a blocking decision.",
    limits: {},
  },
  "security-sensitive": {
    id: "security-sensitive",
    displayName: "Security-sensitive change",
    description: "Raises findings in authentication, authorization, token, permission, and security paths.",
    enabledRules: ALL,
    rules: [{ ruleId: "*", blocking: true, requiredEvidence: ["location", "evidence"], unknownHandling: "fail" }],
    unknownHandling: "fail",
    rationale: "The pack is intended for repositories that explicitly choose stronger review for sensitive paths.",
    limits: {},
  },
  "database-change": {
    id: "database-change",
    displayName: "Database change",
    description: "Requires review evidence for migrations, schema files, and data-access changes.",
    enabledRules: ["impact", "contract", "test_integrity", "fixture"],
    rules: [{ ruleId: "*", blocking: true, requiredEvidence: ["location", "evidence"], unknownHandling: "fail" }],
    unknownHandling: "fail",
    rationale: "Database changes need focused migration, rollback, and integration evidence.",
    limits: {},
  },
  "agent-authored-change": {
    id: "agent-authored-change",
    displayName: "Agent-authored change",
    description: "Keeps evidence advisory but requires an explicit receipt or human review note when available.",
    enabledRules: ALL,
    rules: [{ ruleId: "*", blocking: false, requiredEvidence: ["location", "evidence"], unknownHandling: "advisory" }],
    unknownHandling: "advisory",
    rationale: "An agent receipt is context, never proof; the normal deterministic evidence rules remain authoritative.",
    limits: {},
  },
  monorepo: {
    id: "monorepo",
    displayName: "Monorepo impact",
    description: "Prioritizes cross-package consumers and package-boundary evidence.",
    enabledRules: ["impact", "contract", "test_integrity"],
    rules: [{ ruleId: "impact.unverified", blocking: true, requiredEvidence: ["location", "consumer-graph"], unknownHandling: "fail" }],
    unknownHandling: "fail",
    rationale: "Cross-package changes require explicit downstream evidence and should fall back to a broader suite when unresolved.",
    limits: {},
  },
};

export function listPolicyPacks(): PolicyPack[] {
  return Object.values(PACKS).map((pack) => structuredClone(pack));
}

export function getPolicyPack(id = "default"): PolicyPack {
  const pack = PACKS[id];
  if (!pack) throw new Error(`Unknown policy pack: ${id}. Available packs: ${Object.keys(PACKS).join(", ")}`);
  return structuredClone(pack);
}

function matches(ruleId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return ruleId.startsWith(pattern.slice(0, -1));
  return ruleId === pattern;
}

function pathExcluded(finding: Finding, exclusions: string[] | undefined): boolean {
  if (!finding.file || !exclusions?.length) return false;
  const file = finding.file;
  return exclusions.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(file));
}

function ruleFamily(finding: Finding): string {
  return finding.category === "system" || finding.category === "baseline" ? "system" : finding.category;
}

export function applyPolicy(findings: Finding[], pack: PolicyPack, context: { unknowns: string[]; sensitivePath?: boolean } = { unknowns: [] }): { findings: Finding[]; rationale: string; unknownHandling: "advisory" | "fail" } {
  return {
    findings: findings.map((finding) => {
      if (ruleFamily(finding) !== "system" && !pack.enabledRules.includes(ruleFamily(finding))) return { ...finding, severity: "info", blocking: false, resolution: "not_applicable", classification: "policy-disabled" };
      const rule = pack.rules.find((candidate) => matches(finding.ruleId, candidate.ruleId) && !pathExcluded(finding, candidate.pathExclusions));
      const sensitive = context.sensitivePath && /auth|permission|token|security|credential/i.test(finding.file ?? "");
      if (!rule && !sensitive) return finding;
      return { ...finding, severity: rule?.severity ?? (sensitive && finding.severity === "warning" ? "high" : finding.severity), blocking: rule?.blocking || sensitive || finding.blocking };
    }),
    rationale: pack.rationale,
    unknownHandling: context.unknowns.length && pack.unknownHandling === "fail" ? "fail" : pack.unknownHandling,
  };
}

export function explainPolicyPack(id = "default"): string {
  return JSON.stringify(getPolicyPack(id), null, 2);
}
