import { describe, expect, it } from "vitest";
import { managedConfigurationStatus } from "./deploymentConfig";

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
    expect(managedConfigurationStatus({ ...completeManagedEnv, APP_URL: "http://localhost:3000" }).ready).toBe(true);
    expect(managedConfigurationStatus({ ...completeManagedEnv, APP_URL: "http://public.example.com" }).missing).toContain("APP_URL");
  });
});
