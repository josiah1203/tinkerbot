import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/control-plane-worker/src/**/*.ts", "action/**/*.ts"],
    exclude: ["packages/**/*.test.ts", "action/index.ts", "packages/cli/src/tui/index.ts", "packages/cli/src/tui/types.ts", "packages/tui/**"],
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 94,
        functions: 94,
        lines: 94,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
