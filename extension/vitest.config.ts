import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/types.ts",
        "src/lib/backgroundController.ts",
        // OAuth token handling plus every calendar network call — exactly the
        // kind of code the floor exists for, and it was the one tested lib/
        // module the threshold did not actually apply to.
        "src/lib/calendar.ts",
        "src/lib/costEstimate.ts",
        "src/lib/html.ts",
        "src/lib/install.ts",
        "src/lib/nativeMessaging.ts",
        "src/lib/providerTest.ts",
        "src/lib/storage.ts",
        "src/lib/testProviderKey.ts",
        "src/lib/webappSync.ts",
      ],
      exclude: ["src/background.ts", "src/lib/internalMessages.ts"],
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
