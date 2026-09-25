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
  MANAGED_WORKER_TOKEN: "worker-token",
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

  it("accepts a complete HTTPS managed deployment and reports the storage mode", () => {
    expect(managedConfigurationStatus({ ...completeManagedEnv, S3_BUCKET: "private-meetings" })).toEqual({
      enabled: true,
      ready: true,
      objectStorage: "s3",
      missing: [],
    });
  });

  it("allows localhost HTTP for disposable local managed stacks", () => {
    expect(managedConfigurationStatus({ ...completeManagedEnv, S3_BUCKET: "private-meetings", APP_URL: "http://localhost:3000" }).ready).toBe(true);
    expect(managedConfigurationStatus({ ...completeManagedEnv, APP_URL: "http://public.example.com" }).missing).toContain("APP_URL");
  });
});

describe("managed URL configuration", () => {
  it("requires S3 storage before a managed deployment is ready", () => {
    const status = managedConfigurationStatus({ ...completeManagedEnv });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("S3_BUCKET");
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
    expect(isSignupAllowed({ ...completeManagedEnv, S3_BUCKET: "private-meetings" })).toBe(true);
  });

  it("keeps the legacy AUTH_TOKEN ingest API off in managed mode unless explicitly enabled", () => {
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "false" })).toBe(true);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true" })).toBe(false);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true", LEGACY_INGEST_ENABLED: "true" })).toBe(true);
    expect(isLegacyIngestAvailable({ MANAGED_HOSTING: "true", LEGACY_INGEST_ENABLED: "false" })).toBe(false);
  });
});
