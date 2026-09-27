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
    // Uploaded audio must survive a redeploy and be readable by the separate
    // worker service, so managed mode cannot fall back to a local directory.
    "S3_BUCKET",
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

export class DeploymentConfigError extends Error {}

function originOf(value: string | undefined): string | null {
  if (!validAppUrl(value)) return null;
  return new URL(value as string).origin;
}

/**
 * The canonical public origin of this deployment. Managed mode fails fast
 * when APP_URL is missing or invalid instead of guessing from a request Host
 * header or silently redirecting billing flows to localhost. Self-hosted mode
 * never needs it, so it keeps a localhost fallback for the few UI links that
 * read it.
 */
export function getAppUrl(env: DeploymentEnv = process.env): string {
  const origin = originOf(env.APP_URL ?? env.NEXT_PUBLIC_APP_URL);
  if (origin) return origin;
  if (env.MANAGED_HOSTING === "true") {
    throw new DeploymentConfigError("APP_URL must be set to this deployment's public https origin in managed mode");
  }
  return "http://localhost:3000";
}

/**
 * Base URL used when the web process hands a job to the worker route. It is
 * always configuration (WORKER_URL, else APP_URL), never request.url or the
 * Host header, which a caller can influence.
 */
export function getWorkerBaseUrl(env: DeploymentEnv = process.env): string {
  const worker = env.WORKER_URL?.trim();
  if (worker) {
    try {
      const url = new URL(worker);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // fall through to the explicit error below
    }
    throw new DeploymentConfigError("WORKER_URL must be an http(s) URL");
  }
  return getAppUrl(env);
}

/**
 * Whether new hosted accounts may be created. Managed signup is closed until
 * every provider, billing and storage dependency is configured, so a new user
 * never lands in a workspace that cannot process or pay. Self-hosted signup
 * is governed by the bootstrap flow and is not gated here.
 */
export function isSignupAllowed(env: DeploymentEnv = process.env): boolean {
  const status = managedConfigurationStatus(env);
  return !status.enabled || status.ready;
}

/** Called once from instrumentation.ts so a misconfigured managed deploy fails at boot. */
export function assertManagedStartupConfig(env: DeploymentEnv = process.env): void {
  if (env.MANAGED_HOSTING !== "true") return;
  getAppUrl(env);
}

/** URL the web process calls to hand a job to the worker route. Built from configuration only. */
export function workerJobRunUrl(jobId: string, env: DeploymentEnv = process.env): URL {
  return new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}/run`, getWorkerBaseUrl(env));
}

/**
 * The AUTH_TOKEN-protected /api/meetings ingestion API is the self-hosted
 * helper contract. On a managed multi-tenant deployment it has no tenant
 * identity (everything lands in the default workspace), so it is off unless an
 * operator explicitly opts in with LEGACY_INGEST_ENABLED=true.
 */
export function isLegacyIngestAvailable(env: DeploymentEnv = process.env): boolean {
  return env.MANAGED_HOSTING !== "true" || env.LEGACY_INGEST_ENABLED === "true";
}
