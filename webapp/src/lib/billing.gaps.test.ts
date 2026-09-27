import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import {
  applyStripeEvent,
  BillingError,
  BillingPortalRequiredError,
  clearPriceCache,
  createCheckoutSession,
  createPortalSession,
  formatStripePrice,
  getPlanCatalog,
  hasLiveSubscription,
  verifyStripeSignature,
} from "./billing";

const envNames = ["APP_URL", "NEXT_PUBLIC_APP_URL", "MANAGED_HOSTING", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_HOSTED_PRO", "STRIPE_PRICE_HOSTED_TEAM", "HOSTED_PRO_PRICE_LABEL", "HOSTED_TEAM_PRICE_LABEL"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as Record<(typeof envNames)[number], string | undefined>;

beforeEach(() => {
  process.env.APP_URL = "https://billing.example.test";
  process.env.STRIPE_SECRET_KEY = "sk_test_gaps";
  process.env.STRIPE_PRICE_HOSTED_PRO = "price_pro_gaps";
  process.env.STRIPE_PRICE_HOSTED_TEAM = "price_team_gaps";
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.MANAGED_HOSTING;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.HOSTED_PRO_PRICE_LABEL;
  delete process.env.HOSTED_TEAM_PRICE_LABEL;
  clearPriceCache();
});

afterEach(() => {
  clearPriceCache();
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("billing guard helpers", () => {
  it("distinguishes live and terminal subscriptions and formats Stripe currencies", () => {
    expect(hasLiveSubscription(null)).toBe(false);
    expect(hasLiveSubscription({ plan: "hosted_trial", status: "active", stripeSubscriptionId: "sub" })).toBe(false);
    for (const status of ["active", "trialing", "past_due", "unpaid", "paused"]) {
      expect(hasLiveSubscription({ plan: "hosted_pro", status, stripeSubscriptionId: "sub" })).toBe(true);
    }
    expect(hasLiveSubscription({ plan: "hosted_pro", status: "canceled", stripeSubscriptionId: "sub" })).toBe(false);
    expect(hasLiveSubscription({ plan: "hosted_pro", status: "active", stripeSubscriptionId: null })).toBe(false);
    expect(formatStripePrice(2_500, "usd", "month")).toBe("$25 / month");
    expect(formatStripePrice(500, "jpy", null)).toBe("¥500");
    expect(formatStripePrice(500, "not-a-currency", "month")).toBe("5 NOT-A-CURRENCY / month");
    expect(verifyStripeSignature("{}", null)).toBe(false);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_gaps";
    expect(verifyStripeSignature("{}", "t=1")).toBe(false);
  });

  it("rejects invalid redirects and unavailable managed APP_URL before claiming checkout", async () => {
    const workspaceId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, name: "Billing redirect validation" } });
    try {
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "unknown-price", "https://billing.example.test/billing", "https://billing.example.test/billing"))
        .rejects.toThrow("unknown hosted plan");
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "not-a-url", "https://billing.example.test/billing"))
        .rejects.toThrow("billing redirect URL is invalid");
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "http://evil.example/billing", "https://billing.example.test/billing"))
        .rejects.toThrow("billing redirect URL must use HTTPS");
      process.env.APP_URL = "not a valid URL";
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/billing", "https://billing.example.test/billing"))
        .rejects.toThrow("APP_URL is invalid");
      process.env.MANAGED_HOSTING = "true";
      delete process.env.APP_URL;
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/billing", "https://billing.example.test/billing"))
        .rejects.toThrow("Billing is unavailable: APP_URL is not configured on this server");
      expect(await prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).toBeNull();
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
  });
});

describe("checkout and portal failure recovery", () => {
  async function withWorkspace(name: string, run: (workspaceId: string) => Promise<void>) {
    const workspaceId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, name } });
    try { await run(workspaceId); } finally { await prisma.workspace.delete({ where: { id: workspaceId } }); }
  }

  it("releases checkout claims after Stripe failures, malformed payloads, and missing checkout URLs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await withWorkspace("Checkout error response", async (workspaceId) => {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "card configuration rejected" } }), { status: 400 }));
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .rejects.toThrow("card configuration rejected");
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ status: "inactive" });
    });
    await withWorkspace("Checkout malformed response", async (workspaceId) => {
      fetch.mockResolvedValueOnce(new Response("not-json", { status: 500 }));
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .rejects.toThrow("Stripe request failed");
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ status: "inactive" });
    });
    await withWorkspace("Checkout missing URL", async (workspaceId) => {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "cs_123" }), { status: 200 }));
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .rejects.toThrow("Stripe returned no checkout URL");
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ status: "inactive" });
    });
    await withWorkspace("Checkout missing secret", async (workspaceId) => {
      delete process.env.STRIPE_SECRET_KEY;
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .rejects.toThrow("Stripe billing is not configured");
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ status: "inactive" });
    });
    fetch.mockRestore();
  });

  it("requires a customer for the portal and validates its response URL", async () => {
    await withWorkspace("Portal without customer", async (workspaceId) => {
      await expect(createPortalSession(workspaceId, "https://billing.example.test/return")).rejects.toThrow("No Stripe customer exists");
    });
    await withWorkspace("Portal missing URL", async (workspaceId) => {
      await prisma.workspaceSubscription.create({ data: { workspaceId, stripeCustomerId: "cus_portal_gaps" } });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ id: "bps_1" }), { status: 200 }));
      await expect(createPortalSession(workspaceId, "https://billing.example.test/return")).rejects.toThrow("Stripe returned no portal URL");
      vi.restoreAllMocks();
    });
  });

  it("reclaims expired checkout mutexes and directs an already-subscribed workspace to the portal", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: "https://checkout.stripe.test/new" }), { status: 200 }));
    await withWorkspace("Stale checkout mutex", async (workspaceId) => {
      await prisma.workspaceSubscription.create({ data: { workspaceId, status: "checkout_pending", updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000) } });
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .resolves.toBe("https://checkout.stripe.test/new");
    });
    await withWorkspace("Live subscription checkout", async (workspaceId) => {
      await prisma.workspaceSubscription.create({ data: { workspaceId, status: "active", plan: "hosted_pro", stripeSubscriptionId: "sub_live_gaps", stripeCustomerId: "cus_live_gaps" } });
      await expect(createCheckoutSession(workspaceId, "owner@example.com", "price_pro_gaps", "https://billing.example.test/ok", "https://billing.example.test/cancel"))
        .rejects.toBeInstanceOf(BillingPortalRequiredError);
    });
    fetch.mockRestore();
  });
});

describe("Stripe price catalog", () => {
  it("uses configured labels, looks up Stripe prices, caches outages, and tolerates absent products", async () => {
    process.env.HOSTED_PRO_PRICE_LABEL = "  $19 / month  ";
    delete process.env.STRIPE_SECRET_KEY;
    const fallback = await getPlanCatalog();
    expect(fallback).toMatchObject([
      { id: "hosted_pro", priceId: "price_pro_gaps", priceLabel: "$19 / month" },
      { id: "hosted_team", priceId: "price_team_gaps", priceLabel: null },
    ]);

    clearPriceCache();
    process.env.STRIPE_SECRET_KEY = "sk_catalog";
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ unit_amount: 2_500, currency: "usd", recurring: { interval: "month" } }), { status: 200 }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ unit_amount: "bad", currency: "usd" }), { status: 200 }));
    const catalog = await getPlanCatalog();
    expect(catalog[0]?.priceLabel).toBe("$25 / month");
    expect(catalog[1]?.priceLabel).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    await getPlanCatalog();
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockRestore();

    clearPriceCache();
    const failingFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Stripe offline"));
    expect((await getPlanCatalog())[0]?.priceLabel).toBe("$19 / month");
    await getPlanCatalog();
    expect(failingFetch).toHaveBeenCalledTimes(2);
    failingFetch.mockRestore();

    delete process.env.STRIPE_PRICE_HOSTED_TEAM;
    delete process.env.STRIPE_SECRET_KEY;
    clearPriceCache();
    expect(await getPlanCatalog()).toHaveLength(2);
    expect((await getPlanCatalog())[1]).toMatchObject({ priceId: null, priceLabel: null });
  });
});

describe("Stripe webhook input validation", () => {
  it("rejects malformed events before recording them", async () => {
    await expect(applyStripeEvent(null)).rejects.toBeInstanceOf(BillingError);
    await expect(applyStripeEvent({ type: "invoice.paid" })).rejects.toThrow("invalid Stripe event envelope");
    await expect(applyStripeEvent({ id: 4, type: "invoice.paid" })).rejects.toThrow("invalid Stripe event envelope");
  });
});
