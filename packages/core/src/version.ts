export const TOOL_VERSION = "0.1.0";
/** The only displayed product identity. `pr-proof` remains a CLI compatibility alias. */
export const TOOL_NAME = "tinkerbot";
export const FEATURE_CAPABILITIES = [
  "test-integrity",
  "base-head-non-vacuity",
  "lcov-istanbul-coverage",
  "coverage-py-go-coverprofile-llvm-cov",
  "targeted-stryker-adapter",
  "multi-language-static-graph",
  "terminal-json-markdown-sarif",
  "github-check-run",
  "github-sticky-comment",
  "baselines-and-waivers",
  "policy-packs",
  "ci-artifact-normalization",
  "test-change-provenance",
  "impact-aware-test-selection",
  "local-verification-history",
  "api-contract-guard",
  "fixture-snapshot-integrity",
  "deterministic-assurance-bundles",
  "verification-receipts-and-replay",
  "bounded-verification-graph",
  "behavioral-verification-coverage",
  "change-contracts-and-finding-lifecycle",
  "change-sets-release-safety-and-outcomes",
] as const;
