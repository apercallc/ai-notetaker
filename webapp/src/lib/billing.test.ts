import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyStripeEvent, createCheckoutSession, createPortalSession, verifyStripeSignature } from "./billing";
import { prisma } from "./db";
import { getEntitlements } from "./usageLedger";

const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalAppUrl = process.env.APP_URL;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

describe("Stripe checkout redirect safety", () => {
  it("allows only the configured app origin", async () => {
    const originalKey = process.env.STRIPE_SECRET_KEY;
    const originalPrice = process.env.STRIPE_PRICE_HOSTED_PRO;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: "https://notes.example.com/checkout" }), { status: 200 }));
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_HOSTED_PRO = "price_pro_redirect";
    process.env.APP_URL = "https://notes.example.com";
    try {
      await expect(createCheckoutSession("workspace", "owner@example.com", "price_pro_redirect", "https://notes.example.com/billing?checkout=success", "https://notes.example.com/billing?checkout=cancelled")).resolves.toBe("https://notes.example.com/checkout");
      const checkoutRequest = fetchSpy.mock.calls[0]?.[1];
      expect(checkoutRequest?.body).toBeInstanceOf(URLSearchParams);
      const checkoutForm = checkoutRequest?.body as URLSearchParams;
      expect(checkoutForm.get("metadata[workspaceId]")).toBe("workspace");
      expect(checkoutForm.get("subscription_data[metadata][workspaceId]")).toBe("workspace");
      await expect(createCheckoutSession("workspace", "owner@example.com", "price_pro_redirect", "https://evil.example/return", "https://notes.example.com/billing")).rejects.toThrow("configured APP_URL origin");
    } finally {
      fetchSpy.mockRestore();
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
      if (originalPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_PRO;
      else process.env.STRIPE_PRICE_HOSTED_PRO = originalPrice;
    }
  });
});

describe("Stripe portal redirect safety", () => {
  it("allows only the configured app origin", async () => {
    const workspaceId = randomUUID();
    const originalKey = process.env.STRIPE_SECRET_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: "https://billing.stripe.com/session" }), { status: 200 }));
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.APP_URL = "https://notes.example.com";
    await prisma.workspace.create({ data: { id: workspaceId, name: "Portal redirect workspace" } });
    await prisma.workspaceSubscription.create({ data: { workspaceId, stripeCustomerId: "cus_portal_redirect" } });
    try {
      await expect(createPortalSession(workspaceId, "https://notes.example.com/billing")).resolves.toBe("https://billing.stripe.com/session");
      await expect(createPortalSession(workspaceId, "https://evil.example/return")).rejects.toThrow("configured APP_URL origin");
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } });
      fetchSpy.mockRestore();
      if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalKey;
    }
  });
});

describe("Stripe webhook signatures", () => {
  it("accepts a fresh HMAC signature", () => {
    const payload = JSON.stringify({ id: "evt_test", type: "customer.subscription.updated" });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const digest = createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${timestamp},v1=${digest}`)).toBe(true);
  });

  it("rejects stale, malformed, and tampered signatures", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const payload = "{}";
    const stale = Math.floor(Date.now() / 1000) - 301;
    expect(verifyStripeSignature(payload, `t=${stale},v1=00`)).toBe(false);
    const malformedTimestamp = "not-a-time";
    const forgedMalformed = createHmac("sha256", "whsec_test").update(`${malformedTimestamp}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${malformedTimestamp},v1=${forgedMalformed}`)).toBe(false);
    expect(verifyStripeSignature(payload, `t=${Math.floor(Date.now() / 1000)},v1=00`)).toBe(false);
  });
});

describe("Stripe webhook state", () => {
  it("applies subscription state once and handles cancellation by customer", async () => {
    const workspaceId = randomUUID();
    const originalTeamPrice = process.env.STRIPE_PRICE_HOSTED_TEAM;
    process.env.STRIPE_PRICE_HOSTED_TEAM = "price_team_test";
    await prisma.workspace.create({ data: { id: workspaceId, name: "Billing test workspace" } });
    const activeEventId = `evt-active-${workspaceId}`;
    const canceledEventId = `evt-canceled-${workspaceId}`;
    try {
      const activeEvent = {
        id: activeEventId,
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_test",
            customer: "cus_test",
            status: "active",
            metadata: { workspaceId },
            items: { data: [{ price: { id: "price_team_test" } }] },
          },
        },
      };
      await applyStripeEvent(activeEvent);
      await applyStripeEvent(activeEvent);

      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test",
        plan: "hosted_team",
        status: "active",
      });
      expect(await prisma.billingEvent.count({ where: { id: activeEventId } })).toBe(1);

      await applyStripeEvent({
        id: canceledEventId,
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_test", customer: "cus_test", status: "canceled" } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        plan: "local",
        status: "canceled",
      });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: { in: [activeEventId, canceledEventId] } } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
      if (originalTeamPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_TEAM;
      else process.env.STRIPE_PRICE_HOSTED_TEAM = originalTeamPrice;
    }
  });

  it("ignores an out-of-order older event and preserves the paid plan on payment failure", async () => {
    const workspaceId = randomUUID();
    const originalTeamPrice = process.env.STRIPE_PRICE_HOSTED_TEAM;
    process.env.STRIPE_PRICE_HOSTED_TEAM = "price_team_ordering_test";
    await prisma.workspace.create({ data: { id: workspaceId, name: "Billing ordering workspace" } });
    const eventIds = [`evt-new-${workspaceId}`, `evt-old-${workspaceId}`, `evt-payment-failed-${workspaceId}`];
    try {
      await applyStripeEvent({
        id: eventIds[0],
        type: "customer.subscription.updated",
        created: 200,
        data: { object: { id: "sub_ordering", customer: "cus_ordering", status: "active", current_period_end: Math.floor((Date.now() + 24 * 60 * 60 * 1_000) / 1_000), metadata: { workspaceId }, items: { data: [{ price: { id: "price_team_ordering_test" } }] } } },
      });
      await applyStripeEvent({
        id: eventIds[1],
        type: "customer.subscription.deleted",
        created: 100,
        data: { object: { id: "sub_ordering", customer: "cus_ordering", status: "canceled" } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ plan: "hosted_team", status: "active", lastBillingEventCreatedAt: 200 });

      await applyStripeEvent({
        id: eventIds[2],
        type: "invoice.payment_failed",
        created: 300,
        data: { object: { customer: "cus_ordering", subscription: "sub_ordering" } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ plan: "hosted_team", status: "past_due", lastBillingEventCreatedAt: 300 });
      await expect(getEntitlements(workspaceId)).resolves.toMatchObject({ plan: "hosted_team", inPaymentGrace: true, canProcess: true });
      await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { graceEndsAt: new Date(Date.now() - 1_000) } });
      await expect(getEntitlements(workspaceId)).resolves.toMatchObject({ inPaymentGrace: false, canProcess: false });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
      if (originalTeamPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_TEAM;
      else process.env.STRIPE_PRICE_HOSTED_TEAM = originalTeamPrice;
    }
  });
});
