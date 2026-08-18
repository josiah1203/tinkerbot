import { applyPolicy, getPolicyPack, listPolicyPacks } from "../packages/policy/src";
import type { Finding } from "../packages/core/src";

const sample: Finding = {
  id: "policy:test",
  ruleId: "impact.unverified",
  category: "impact",
  severity: "high",
  file: "src/api.ts",
  line: 1,
  message: "Impact is unresolved",
  explanation: "The relationship is uncertain.",
  evidence: { detail: "dynamic import" },
  suggestedAction: "Run the full suite.",
  confidence: "low",
  blocking: false,
};

test("policy packs are explicit, composable, and preserve advisory defaults", () => {
  expect(listPolicyPacks().map((pack) => pack.id)).toEqual(["default", "strict", "public-api", "security-sensitive", "database-change", "agent-authored-change", "monorepo"]);
  expect(applyPolicy([sample], getPolicyPack("default"), { unknowns: [] }).findings[0]?.blocking).toBe(false);
  expect(applyPolicy([sample], getPolicyPack("strict"), { unknowns: [] }).findings[0]?.blocking).toBe(true);
  const fixture = { ...sample, category: "fixture" as const, ruleId: "fixture.snapshot-churn" };
  const publicApiResult = applyPolicy([fixture], getPolicyPack("public-api"), { unknowns: [] }).findings[0];
  expect(publicApiResult?.resolution).toBe("not_applicable");
  expect(publicApiResult?.severity).toBe("info");
});
