import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 80,
        lines: 75
      }
    },
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
});
