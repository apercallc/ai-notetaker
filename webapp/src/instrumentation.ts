import { assertManagedStartupConfig } from "./lib/deploymentConfig";

// Runs once when the server process boots (not during `next build`). A managed
// deployment without a valid APP_URL would otherwise send Stripe customers to
// the wrong origin, so it refuses to start instead.
export function register(): void {
  assertManagedStartupConfig();
}

// @sentry/nextjs load hook: imports instrumentation-server.ts (Sentry.init for
// the Node.js server runtime) when the file exists. See
// node_modules/next/dist/docs for the instrumentation contract.
