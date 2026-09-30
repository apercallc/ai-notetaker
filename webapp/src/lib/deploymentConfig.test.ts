import { describe, expect, it } from "vitest";
import {
  DeploymentConfigError,
  assertManagedStartupConfig,
  getAppUrl,
  getWorkerBaseUrl,
  isLegacyIngestAvailable,
  isSignupAllowed,
  managedConfigurationStatus,
  workerJobRunUrl,
} from "./deploymentConfig";

const completeManagedEnv = {
  MANAGED_HOSTING: "true",
  APP_URL: "https://notes.example.com",
  R2_ACCOUNT_ID: "account-id",
  R2_BUCKET: "private-meetings",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_SECRET_ACCESS_KEY: "r2-secret-key",
  MANAGED_WORKER_TOKEN: "worker-token",
  MANAGED_TRANSCRIPTION_PROVIDER: "deepgram",
  MANAGED_SUMMARY_PROVIDER: "anthropic",
  MANAGED_DEEPGRAM_API_KEY: "deepgram-key",
  MANAGED_ANTHROPIC_API_KEY: "anthropic-key",
  STRIPE_SECRET_KEY: "stripe-secret",
  STRIPE_WEBHOOK_SECRET: "stripe-webhook",
  STRIPE_PRICE_HOSTED_PRO: "price-pro",
  STRIPE_PRICE_HOSTED_TEAM: "price-team",
};

describe("managed deployment configuration", () => {
  it("keeps self-hosted local BYOK ready without hosted secrets", () => {
    expect(managedConfigurationStatus({ MANAGED_HOSTING: "false" })).toEqual({
      enabled: false,
      ready: true,
      objectStorage: "filesystem",
      missing: [],
    });
  });

  it("reports managed mode incomplete without exposing secret values", () => {
    const status = managedConfigurationStatus({ MANAGED_HOSTING: "true", APP_URL: "https://notes.example.com" });
    expect(status.enabled).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("MANAGED_WORKER_TOKEN");
    expect(status.missing).toContain("STRIPE_SECRET_KEY");
    expect(status.missing).not.toContain("notes.example.com");
  });

  it("accepts a complete HTTPS managed deployment and reports R2 storage", () => {
    expect(managedConfigurationStatus(completeManagedEnv)).toEqual({
      enabled: true,
      ready: true,
      objectStorage: "r2",
      missing: [],
    });
  });

  it("allows localhost HTTP for disposable local managed stacks", () => {
    expect(managedConfigurationStatus({ ...completeManagedEnv, APP_URL: "http://localhost:3000" }).ready).toBe(true);
    expect(managedConfigurationStatus({ ...completeManagedEnv, APP_URL: "http://public.example.com" }).missing).toContain("APP_URL");
  });
});

describe("managed URL configuration", () => {
  it("accepts existing private S3 staging without requiring R2", () => {
    const status = managedConfigurationStatus({
      MANAGED_HOSTING: "true",
      APP_URL: "https://notes.example.com",
      S3_BUCKET: "private-temporary-audio",
      S3_ACCESS_KEY_ID: "s3-access-key",
      S3_SECRET_ACCESS_KEY: "s3-secret-key",
      MANAGED_WORKER_TOKEN: "worker-token",
      MANAGED_GROQ_API_KEY: "groq-key",
      MANAGED_OPENAI_API_KEY: "openai-key",
      STRIPE_SECRET_KEY: "stripe-secret",
      STRIPE_WEBHOOK_SECRET: "stripe-webhook",
      STRIPE_PRICE_HOSTED_PRO: "price-pro",
      STRIPE_PRICE_HOSTED_TEAM: "price-team",
    });
    expect(status).toEqual({ enabled: true, ready: true, objectStorage: "s3", missing: [] });
  });

  it("selects provider credentials from the managed configuration", () => {
    const status = managedConfigurationStatus({
      ...completeManagedEnv,
      MANAGED_TRANSCRIPTION_PROVIDER: "groq",
      MANAGED_SUMMARY_PROVIDER: "openai",
      MANAGED_GROQ_API_KEY: "groq-key",
      MANAGED_OPENAI_API_KEY: "openai-key",
    });
    expect(status.ready).toBe(true);
    expect(status.missing).not.toContain("MANAGED_DEEPGRAM_API_KEY");
    expect(status.missing).not.toContain("MANAGED_ANTHROPIC_API_KEY");
  });

  it("keeps managed readiness closed for unsupported provider names", () => {
    const status = managedConfigurationStatus({
      ...completeManagedEnv,
      MANAGED_TRANSCRIPTION_PROVIDER: "unknown",
      MANAGED_SUMMARY_PROVIDER: "unknown",
    });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("MANAGED_TRANSCRIPTION_PROVIDER (groq or deepgram)");
    expect(status.missing).toContain("MANAGED_SUMMARY_PROVIDER (openai or anthropic)");
  });

  it("requires a private shared bucket for temporary managed audio staging", () => {
    const status = managedConfigurationStatus({ ...completeManagedEnv, R2_BUCKET: "", S3_BUCKET: "" });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("S3_BUCKET or R2_BUCKET");
  });

  it("fails fast when managed mode has no valid APP_URL", () => {
    const managed = { MANAGED_HOSTING: "true", APP_URL: "https://notes.example.com" };
    expect(getAppUrl(managed)).toBe("https://notes.example.com");
    expect(() => getAppUrl({ MANAGED_HOSTING: "true" })).toThrow(DeploymentConfigError);
    expect(() => getAppUrl({ MANAGED_HOSTING: "true", APP_URL: "http://public.example.com" })).toThrow(DeploymentConfigError);
    expect(() => assertManagedStartupConfig({ MANAGED_HOSTING: "true" })).toThrow(DeploymentConfigError);
    expect(() => assertManagedStartupConfig({ MANAGED_HOSTING: "true", APP_URL: "https://notes.example.com" })).not.toThrow();
    expect(() => assertManagedStartupConfig({ MANAGED_HOSTING: "false" })).not.toThrow();
    // Self-hosted never needs it and keeps a localhost default for UI links.
    expect(getAppUrl({ MANAGED_HOSTING: "false" })).toBe("http://localhost:3000");
    expect(getAppUrl({ MANAGED_HOSTING: "false", NEXT_PUBLIC_APP_URL: "https://self.example.org/path" })).toBe("https://self.example.org");
  });

  it("builds worker dispatch URLs from configuration only", () => {
    expect(getWorkerBaseUrl({ WORKER_URL: "https://worker.example.com/prefix" })).toBe("https://worker.example.com");
    expect(getWorkerBaseUrl({ APP_URL: "https://notes.example.com" })).toBe("https://notes.example.com");
    expect(() => getWorkerBaseUrl({ WORKER_URL: "not-a-url" })).toThrow(DeploymentConfigError);
    expect(workerJobRunUrl("job/123", { APP_URL: "https://notes.example.com" }).toString()).toBe("https://notes.example.com/api/v1/jobs/job%2F123/run");
    expect(workerJobRunUrl("abc", { WORKER_URL: "https://worker.example.com" }).toString()).toBe("https://worker.example.com/api/v1/jobs/abc/run");
  });

  it("allows signup only when the deployment is self-hosted or fully ready", () => {
    expect(isSignupAllowed({ MANAGED_HOSTING: "false" })).toBe(true);
    expect(isSignupAllowed({ MANAGED_HOSTING: "true", APP_URL: "https://notes.example.com" })).toBe(false);
    expect(isSignupAllowed(completeManagedEnv)).toBe(true);
  });

  it("keeps the legacy AUTH_TOKEN ingest API off in managed mode unless explicitly enabled", () => {
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "false" })).toBe(true);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true" })).toBe(false);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true", LEGACY_INGEST_ENABLED: "true" })).toBe(true);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true", LEGACY_INGEST_ENABLED: "false" })).toBe(false);
  });
});
