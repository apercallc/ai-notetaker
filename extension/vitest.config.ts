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
