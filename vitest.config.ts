import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts"],
      exclude: ["packages/**/*.test.ts", "packages/tui/**"],
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 95,
        functions: 95,
        lines: 95,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
