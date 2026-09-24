/**
 * Non-secret deployment diagnostics. The health endpoint can expose the
 * readiness boolean without returning values or names of configured secrets.
 * Keep local/self-hosted mode independent from managed provider and billing
 * configuration: local BYOK is intentionally a complete product path.
 */
export interface ManagedConfigurationStatus {
  enabled: boolean;
  ready: boolean;
  objectStorage: "s3" | "filesystem";
  missing: string[];
}

type DeploymentEnv = Record<string, string | undefined>;

function hasValue(env: DeploymentEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function validAppUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || localHttp;
  } catch {
    return false;
  }
}

export function managedConfigurationStatus(env: DeploymentEnv = process.env): ManagedConfigurationStatus {
  const enabled = env.MANAGED_HOSTING === "true";
  if (!enabled) {
    return { enabled: false, ready: true, objectStorage: hasValue(env, "S3_BUCKET") ? "s3" : "filesystem", missing: [] };
  }

  const missing = [
    "MANAGED_WORKER_TOKEN",
    "MANAGED_DEEPGRAM_API_KEY",
    "MANAGED_ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_HOSTED_PRO",
    "STRIPE_PRICE_HOSTED_TEAM",
  ].filter((name) => !hasValue(env, name));
  if (!validAppUrl(env.APP_URL ?? env.NEXT_PUBLIC_APP_URL)) missing.push("APP_URL");

  return {
    enabled: true,
    ready: missing.length === 0,
    objectStorage: hasValue(env, "S3_BUCKET") ? "s3" : "filesystem",
    missing,
  };
}
