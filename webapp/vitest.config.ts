import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These are real integration tests sharing one live Postgres instance
    // (see webapp/README.md) — running test files in parallel would let one
    // file's cleanup (`beforeEach` deleting all rows) race a different
    // file's in-flight assertions against the same tables.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
