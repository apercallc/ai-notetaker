import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null as null | { userId: string; email: string; workspaceId: string; role: "owner" | "member" },
  checkout: vi.fn(),
  portal: vi.fn(),
}));

vi.mock("@/lib/managedAuth", () => ({
  getManagedSession: async () => mocks.session,
  managedUnauthorized: (requestId: string) => Response.json({ error: "managed session required", requestId }, { status: 401, headers: { "x-request-id": requestId } }),
}));
vi.mock("@/lib/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing")>();
  return { ...actual, createCheckoutSession: mocks.checkout, createPortalSession: mocks.portal };
});

import { POST as checkoutPost } from "./checkout/route";
import { POST as portalPost } from "./portal/route";

const owner = { userId: "owner-1", email: "owner@example.com", workspaceId: "workspace-1", role: "owner" as const };
const priorAppUrl = process.env.APP_URL;
const priorPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const priorManagedHosting = process.env.MANAGED_HOSTING;

beforeEach(() => {
  mocks.session = owner;
  mocks.checkout.mockReset();
  mocks.portal.mockReset();
  mocks.checkout.mockResolvedValue("https://checkout.stripe.com/session");
  mocks.portal.mockResolvedValue("https://billing.stripe.com/session");
  process.env.APP_URL = "https://app.example.test";
  process.env.MANAGED_HOSTING = "true";
});

afterAll(() => {
  for (const [name, value] of [["APP_URL", priorAppUrl], ["NEXT_PUBLIC_APP_URL", priorPublicAppUrl], ["MANAGED_HOSTING", priorManagedHosting]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("managed billing routes", () => {
  it("requires an authenticated owner before opening checkout or portal", async () => {
    mocks.session = null;
    const checkout = await checkoutPost(new Request("https://app.example.test/api/v1/billing/checkout", {
      method: "POST", headers: { "x-request-id": "billing-test" }, body: "{}",
    }));
    const portal = await portalPost(new Request("https://app.example.test/api/v1/billing/portal", { method: "POST" }));
    expect(checkout.status).toBe(401);
    expect(checkout.headers.get("x-request-id")).toBe("billing-test");
    expect(portal.status).toBe(401);

    mocks.session = { ...owner, role: "member" };
    expect((await portalPost(new Request("https://app.example.test/api/v1/billing/portal", { method: "POST" }))).status).toBe(401);
  });

  it("validates secure checkout redirects, creates checkout, and directs existing subscriptions to portal", async () => {
    const invalid = await checkoutPost(new Request("https://app.example.test/api/v1/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_pro", successUrl: "http://evil.test/success", cancelUrl: "https://app.example.test/cancel" }),
    }));
    expect(invalid.status).toBe(400);
    expect(mocks.checkout).not.toHaveBeenCalled();

    const response = await checkoutPost(new Request("https://app.example.test/api/v1/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": "checkout-ok" },
      body: JSON.stringify({ priceId: "price_pro", successUrl: "https://app.example.test/success", cancelUrl: "https://app.example.test/cancel" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("checkout-ok");
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/session" });
    expect(mocks.checkout).toHaveBeenCalledWith(owner.workspaceId, owner.email, "price_pro", "https://app.example.test/success", "https://app.example.test/cancel");

    const { BillingPortalRequiredError } = await import("@/lib/billing");
    mocks.checkout.mockRejectedValueOnce(new BillingPortalRequiredError("Manage the existing subscription in the portal"));
    const conflict = await checkoutPost(new Request("https://app.example.test/api/v1/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_pro", successUrl: "https://app.example.test/success", cancelUrl: "https://app.example.test/cancel" }),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ portalRequired: true });
  });

  it("uses the configured return URL for portal and returns safe configuration errors", async () => {
    const request = new Request("https://app.example.test/api/v1/billing/portal", { method: "POST", headers: { origin: "https://attacker.example" } });
    const response = await portalPost(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://billing.stripe.com/session" });
    expect(mocks.portal).toHaveBeenCalledWith(owner.workspaceId, "https://app.example.test/billing");

    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const unavailable = await portalPost(request);
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({ error: "Billing is unavailable: APP_URL is not configured on this server" });
  });
});
