import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyStripeEvent,
  BillingPortalRequiredError,
  clearPriceCache,
  createCheckoutSession,
  createPortalSession,
  formatStripePrice,
  getPlanCatalog,
  verifyStripeSignature,
} from "./billing";
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

describe("Stripe webhook event sequencing", () => {
  it("never lets invoice.paid or checkout.session.completed overwrite subscription state", async () => {
    const workspaceId = randomUUID();
    const originalProPrice = process.env.STRIPE_PRICE_HOSTED_PRO;
    process.env.STRIPE_PRICE_HOSTED_PRO = "price_pro_sequence";
    const eventIds = [
      `evt-seq-sub-${workspaceId}`,
      `evt-seq-failed-${workspaceId}`,
      `evt-seq-paid-${workspaceId}`,
      `evt-seq-checkout-${workspaceId}`,
    ];
    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Event sequencing workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_trial", status: "trialing" } });

      await applyStripeEvent({
        id: eventIds[0],
        type: "customer.subscription.created",
        created: 100,
        data: { object: { id: "sub_seq", customer: "cus_seq", status: "active", metadata: { workspaceId }, items: { data: [{ price: { id: "price_pro_sequence" } }] } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ plan: "hosted_pro", status: "active" });

      await applyStripeEvent({
        id: eventIds[1],
        type: "invoice.payment_failed",
        created: 200,
        data: { object: { customer: "cus_seq", subscription: "sub_seq" } },
      });
      const pastDue = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
      expect(pastDue).toMatchObject({ plan: "hosted_pro", status: "past_due" });
      expect(pastDue?.graceEndsAt).not.toBeNull();

      // A later successful invoice must not flip the subscription back to active.
      await applyStripeEvent({
        id: eventIds[2],
        type: "invoice.paid",
        created: 300,
        data: { object: { customer: "cus_seq", subscription: "sub_seq" } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({ plan: "hosted_pro", status: "past_due", graceEndsAt: pastDue?.graceEndsAt ?? null });

      // A replayed checkout completion must only link identifiers.
      await applyStripeEvent({
        id: eventIds[3],
        type: "checkout.session.completed",
        created: 400,
        data: { object: { mode: "subscription", customer: "cus_seq", subscription: "sub_seq", metadata: { workspaceId } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        plan: "hosted_pro",
        status: "past_due",
        stripeCustomerId: "cus_seq",
        stripeSubscriptionId: "sub_seq",
      });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
      if (originalProPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_PRO;
      else process.env.STRIPE_PRICE_HOSTED_PRO = originalProPrice;
    }
  });

  it("uses checkout completion only to link identifiers for a trialing workspace", async () => {
    const workspaceId = randomUUID();
    const eventId = `evt-checkout-link-${workspaceId}`;
    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Checkout link workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_trial", status: "trialing" } });

      await applyStripeEvent({
        id: eventId,
        type: "checkout.session.completed",
        data: { object: { mode: "subscription", customer: "cus_link", subscription: "sub_link", metadata: { workspaceId } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        plan: "hosted_trial",
        status: "trialing",
        stripeCustomerId: "cus_link",
      });
      // The subscription only becomes live once Stripe reports it, not at checkout.
      await expect(getEntitlements(workspaceId)).resolves.toMatchObject({ plan: "hosted_trial", isTrial: true });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: eventId } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
  });

  it("keeps an incomplete subscription on the trial plan until Stripe reports it live", async () => {
    const workspaceId = randomUUID();
    const eventId = `evt-incomplete-${workspaceId}`;
    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Incomplete checkout workspace" } });
      await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_trial", status: "trialing" } });
      await applyStripeEvent({
        id: eventId,
        type: "customer.subscription.created",
        created: 100,
        data: { object: { id: "sub_incomplete", customer: "cus_incomplete", status: "incomplete", metadata: { workspaceId } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId } })).resolves.toMatchObject({
        plan: "hosted_trial",
        status: "trialing",
        stripeCustomerId: "cus_incomplete",
      });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: eventId } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
  });

  it("never moves billing across tenants", async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const originalProPrice = process.env.STRIPE_PRICE_HOSTED_PRO;
    process.env.STRIPE_PRICE_HOSTED_PRO = "price_pro_xtenant";
    const eventIds = [
      `evt-xtant-conflict-${workspaceA}`,
      `evt-xtant-steal-${workspaceA}`,
      `evt-xtant-substeal-${workspaceA}`,
    ];
    try {
      await prisma.workspace.createMany({
        data: [
          { id: workspaceA, name: "Tenant A" },
          { id: workspaceB, name: "Tenant B" },
        ],
      });
      await prisma.workspaceSubscription.create({
        data: { workspaceId: workspaceA, stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a", plan: "hosted_pro", status: "active" },
      });

      // Metadata names B, but the customer is bound to A: the event is ignored.
      await applyStripeEvent({
        id: eventIds[0],
        type: "customer.subscription.updated",
        created: 500,
        data: { object: { id: "sub_a", customer: "cus_a", status: "active", metadata: { workspaceId: workspaceB }, items: { data: [{ price: { id: "price_pro_xtenant" } }] } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceA } })).resolves.toMatchObject({
        plan: "hosted_pro",
        status: "active",
        lastBillingEventCreatedAt: null,
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceB } })).resolves.toBeNull();

      // A different subscription id, but A's customer: still bound to A, and the
      // metadata names B, so the event is ignored — B cannot hijack the customer.
      await applyStripeEvent({
        id: eventIds[1],
        type: "customer.subscription.created",
        created: 501,
        data: { object: { id: "sub_hijack", customer: "cus_a", status: "active", metadata: { workspaceId: workspaceB }, items: { data: [{ price: { id: "price_pro_xtenant" } }] } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceB } })).resolves.toBeNull();
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceA } })).resolves.toMatchObject({
        plan: "hosted_pro",
        stripeSubscriptionId: "sub_a",
      });

      // B holds a live subscription; an event with no customer that carries B's
      // subscription id but names A in metadata must not touch A.
      await prisma.workspaceSubscription.create({
        data: { workspaceId: workspaceB, stripeSubscriptionId: "sub_b", plan: "hosted_pro", status: "active" },
      });
      await applyStripeEvent({
        id: eventIds[2],
        type: "customer.subscription.updated",
        created: 502,
        data: { object: { id: "sub_b", status: "canceled", metadata: { workspaceId: workspaceA } } },
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceA } })).resolves.toMatchObject({
        plan: "hosted_pro",
        status: "active",
        stripeSubscriptionId: "sub_a",
      });
      await expect(prisma.workspaceSubscription.findUnique({ where: { workspaceId: workspaceB } })).resolves.toMatchObject({
        plan: "hosted_pro",
        status: "active",
        stripeSubscriptionId: "sub_b",
      });
    } finally {
      await prisma.billingEvent.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
      if (originalProPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_PRO;
      else process.env.STRIPE_PRICE_HOSTED_PRO = originalProPrice;
    }
  });
});

describe("checkout gating", () => {
  it("refuses a second checkout while a subscription is live and points the owner at the portal", async () => {
    const workspaceId = randomUUID();
    const originals = {
      key: process.env.STRIPE_SECRET_KEY,
      appUrl: process.env.APP_URL,
      proPrice: process.env.STRIPE_PRICE_HOSTED_PRO,
    };
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.APP_URL = "https://notes.example.com";
    process.env.STRIPE_PRICE_HOSTED_PRO = "price_gate_pro";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: "https://notes.example.com/checkout" }), { status: 200 }));
    try {
      await prisma.workspace.create({ data: { id: workspaceId, name: "Checkout gate workspace" } });
      await prisma.workspaceSubscription.create({
        data: { workspaceId, stripeCustomerId: "cus_gate", stripeSubscriptionId: "sub_gate", plan: "hosted_pro", status: "active" },
      });

      await expect(
        createCheckoutSession(workspaceId, "owner@example.com", "price_gate_pro", "https://notes.example.com/billing?checkout=success", "https://notes.example.com/billing?checkout=cancelled"),
      ).rejects.toThrowError(BillingPortalRequiredError);
      expect(fetchSpy).not.toHaveBeenCalled();

      // past_due is still a subscription the customer can manage in the portal
      await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "past_due" } });
      await expect(
        createCheckoutSession(workspaceId, "owner@example.com", "price_gate_pro", "https://notes.example.com/billing?checkout=success", "https://notes.example.com/billing?checkout=cancelled"),
      ).rejects.toThrowError(BillingPortalRequiredError);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Once the subscription is terminal, a fresh checkout is allowed again.
      await prisma.workspaceSubscription.update({ where: { workspaceId }, data: { status: "canceled", plan: "local" } });
      await expect(
        createCheckoutSession(workspaceId, "owner@example.com", "price_gate_pro", "https://notes.example.com/billing?checkout=success", "https://notes.example.com/billing?checkout=cancelled"),
      ).resolves.toBe("https://notes.example.com/checkout");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.workspace.delete({ where: { id: workspaceId } });
      fetchSpy.mockRestore();
      if (originals.key === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originals.key;
      if (originals.appUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originals.appUrl;
      if (originals.proPrice === undefined) delete process.env.STRIPE_PRICE_HOSTED_PRO;
      else process.env.STRIPE_PRICE_HOSTED_PRO = originals.proPrice;
    }
  });
});

describe("plan catalog", () => {
  it("formats Stripe prices including zero-decimal currencies", () => {
    expect(formatStripePrice(1950, "usd", "month")).toBe("$19.50 / month");
    expect(formatStripePrice(1900, "jpy", "month")).toBe("¥1,900 / month");
    expect(formatStripePrice(500, "eur", null)).toBe("€5");
  });

  it("resolves plan names, limits and prices, caching Stripe lookups and falling back to configured labels", async () => {
    clearPriceCache();
    const originals = {
      key: process.env.STRIPE_SECRET_KEY,
      proPrice: process.env.STRIPE_PRICE_HOSTED_PRO,
      teamPrice: process.env.STRIPE_PRICE_HOSTED_TEAM,
      proLabel: process.env.HOSTED_PRO_PRICE_LABEL,
      teamLabel: process.env.HOSTED_TEAM_PRICE_LABEL,
    };
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_PRICE_HOSTED_PRO = "price_catalog_pro";
    process.env.STRIPE_PRICE_HOSTED_TEAM = "price_catalog_team";
    process.env.HOSTED_TEAM_PRICE_LABEL = "$49 / month";
    delete process.env.HOSTED_PRO_PRICE_LABEL;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("prices/price_catalog_pro")) {
        return new Response(JSON.stringify({ unit_amount: 1950, currency: "usd", recurring: { interval: "month" } }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    });
    try {
      const catalog = await getPlanCatalog();
      expect(catalog).toEqual([
        { id: "hosted_pro", name: "Hosted Pro", priceId: "price_catalog_pro", meetingLimit: 1_000, priceLabel: "$19.50 / month" },
        { id: "hosted_team", name: "Hosted Team", priceId: "price_catalog_team", meetingLimit: 10_000, priceLabel: "$49 / month" },
      ]);

      // The next render is served from the price cache: only the Pro lookup ever hit Stripe.
      await getPlanCatalog();
      const stripeCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("price_catalog_pro"));
      expect(stripeCalls).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      clearPriceCache();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value as string;
      }
    }
  });
});
