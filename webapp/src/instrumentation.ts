import { assertManagedStartupConfig } from "./lib/deploymentConfig";

// Runs once when the server process boots (not during `next build`). A managed
// deployment without a valid APP_URL would otherwise send Stripe customers to
// the wrong origin, so it refuses to start instead.
export function register(): void {
  assertManagedStartupConfig();
}
