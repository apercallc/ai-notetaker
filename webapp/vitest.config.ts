import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    // These are real integration tests sharing one live Postgres instance
    // (see webapp/README.md) — running test files in parallel would let one
    // file's cleanup (`beforeEach` deleting all rows) race a different
    // file's in-flight assertions against the same tables.
    fileParallelism: false,
    env: {
      // The suites exercise the hosted-processing code paths; a dedicated test covers the switch being off.
      HOSTED_AI_ENABLED: "true",
      MANAGED_DAILY_SPEND_MICROS: "1000000000000",
      MANAGED_WORKSPACE_DAILY_SPEND_MICROS: "1000000000000",
      MANAGED_TRIAL_DAILY_SPEND_MICROS: "1000000000000",
      MANAGED_TRIAL_DAILY_GRANTS: "10000",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/lib/db.ts"],
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
