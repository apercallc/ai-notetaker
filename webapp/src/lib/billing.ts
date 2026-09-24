import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { ValidationError } from "./meetings";

const PAYMENT_GRACE_MS = 3 * 24 * 60 * 60 * 1_000;

export class BillingError extends ValidationError {}

function stripeUrl(path: string): string {
  return `https://api.stripe.com/v1/${path}`;
}

function stripeHeaders(): HeadersInit {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError("Stripe billing is not configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
}

function priceFor(priceId: string): string {
  const allowed = [process.env.STRIPE_PRICE_HOSTED_PRO, process.env.STRIPE_PRICE_HOSTED_TEAM].filter((value): value is string => Boolean(value));
  if (!allowed.includes(priceId)) throw new BillingError("unknown hosted plan");
  return priceId;
}

function validateBillingRedirect(value: string): string {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new BillingError("billing redirect URL is invalid");
  }
  const isLocalHttp = redirect.protocol === "http:" && (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]");
  if (redirect.protocol !== "https:" && !isLocalHttp) throw new BillingError("billing redirect URL must use HTTPS");
  const configuredAppUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configuredAppUrl) {
    let appOrigin: URL;
    try {
      appOrigin = new URL(configuredAppUrl);
    } catch {
      throw new BillingError("APP_URL is invalid");
    }
    if (redirect.origin !== appOrigin.origin) throw new BillingError("billing redirect URL must use the configured APP_URL origin");
  }
  return redirect.toString();
}

async function stripePost(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(stripeUrl(path), { method: "POST", headers: stripeHeaders(), body: form });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new BillingError(typeof body.error === "object" && body.error && "message" in body.error ? String(body.error.message) : "Stripe request failed");
  return body;
}

export async function createCheckoutSession(workspaceId: string, email: string, priceId: string, successUrl: string, cancelUrl: string) {
  const price = priceFor(priceId);
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: validateBillingRedirect(successUrl),
    cancel_url: validateBillingRedirect(cancelUrl),
    "metadata[workspaceId]": workspaceId,
    "subscription_data[metadata][workspaceId]": workspaceId,
  });
  if (subscription?.stripeCustomerId) form.set("customer", subscription.stripeCustomerId);
  else form.set("customer_email", email);
  const body = await stripePost("checkout/sessions", form);
  if (typeof body.url !== "string") throw new BillingError("Stripe returned no checkout URL");
  return body.url;
}

export async function createPortalSession(workspaceId: string, returnUrl: string) {
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  if (!subscription?.stripeCustomerId) throw new BillingError("No Stripe customer exists for this workspace");
  const body = await stripePost("billing_portal/sessions", new URLSearchParams({ customer: subscription.stripeCustomerId, return_url: validateBillingRedirect(returnUrl) }));
  if (typeof body.url !== "string") throw new BillingError("Stripe returned no portal URL");
  return body.url;
}

export function verifyStripeSignature(payload: string, signature: string | null): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const values = Object.fromEntries(signature.split(",").map((part) => part.split("=", 2) as [string, string]));
  const timestamp = values.t;
  const provided = values.v1;
  const timestampSeconds = Number(timestamp);
  if (!timestamp || !provided || !Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const actualBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function applyStripeEvent(event: unknown): Promise<void> {
  if (typeof event !== "object" || event === null) throw new BillingError("invalid Stripe event");
  const value = event as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof value.id !== "string" || typeof value.type !== "string") throw new BillingError("invalid Stripe event envelope");
  const eventId = value.id;
  const eventType = value.type;
  const eventCreatedAt = typeof value.created === "number" && Number.isSafeInteger(value.created) && value.created >= 0 ? value.created : undefined;
  await prisma.$transaction(async (tx) => {
    try {
      await tx.billingEvent.create({ data: { id: eventId, type: eventType, eventCreatedAt } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return;
      throw error;
    }
    const object = value.data?.object ?? {};
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const workspaceId = typeof metadata?.workspaceId === "string" ? metadata.workspaceId : undefined;
    const customerId = typeof object.customer === "string" ? object.customer : undefined;
    const subscriptionId = typeof object.id === "string" && eventType.includes("subscription") ? object.id : typeof object.subscription === "string" ? object.subscription : undefined;
    if (!workspaceId && !customerId) return;
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId && customerId) {
      const subscription = await tx.workspaceSubscription.findFirst({ where: { stripeCustomerId: customerId }, select: { workspaceId: true } });
      resolvedWorkspaceId = subscription?.workspaceId;
    }
    if (!resolvedWorkspaceId) return;
    const current = await tx.workspaceSubscription.findUnique({ where: { workspaceId: resolvedWorkspaceId } });
    if (
      eventCreatedAt !== undefined &&
      current?.lastBillingEventCreatedAt !== null &&
      current?.lastBillingEventCreatedAt !== undefined &&
      eventCreatedAt < current.lastBillingEventCreatedAt
    ) {
      return;
    }
    const status = typeof object.status === "string"
      ? object.status
      : eventType === "invoice.payment_failed"
        ? "past_due"
        : eventType === "invoice.paid"
          ? "active"
          : eventType.endsWith("deleted")
            ? "canceled"
            : current?.status ?? "inactive";
    const currentPeriodStartSeconds = typeof object.current_period_start === "number" && Number.isSafeInteger(object.current_period_start) ? object.current_period_start : undefined;
    const currentPeriodEndSeconds = typeof object.current_period_end === "number" && Number.isSafeInteger(object.current_period_end) ? object.current_period_end : undefined;
    const currentPeriodStart = currentPeriodStartSeconds === undefined ? undefined : new Date(currentPeriodStartSeconds * 1_000);
    const currentPeriodEnd = currentPeriodEndSeconds === undefined ? undefined : new Date(currentPeriodEndSeconds * 1_000);
    const graceBase = currentPeriodEnd ?? current?.currentPeriodEnd ?? null;
    const graceEndsAt = status === "past_due" && graceBase ? new Date(graceBase.getTime() + PAYMENT_GRACE_MS) : status === "active" || status === "trialing" ? null : undefined;
    const items = object.items as { data?: unknown[] } | undefined;
    const firstItem = Array.isArray(items?.data) && typeof items.data[0] === "object" && items.data[0] !== null ? items.data[0] as { price?: { id?: unknown } } : undefined;
    const priceId = typeof firstItem?.price?.id === "string" ? firstItem.price.id : undefined;
    const plan = status === "canceled" || status === "inactive" || status === "unpaid"
      ? "local"
      : priceId && priceId === process.env.STRIPE_PRICE_HOSTED_TEAM
        ? "hosted_team"
        : priceId && priceId === process.env.STRIPE_PRICE_HOSTED_PRO
          ? "hosted_pro"
          : current?.plan ?? "local";
    await tx.workspaceSubscription.upsert({
      where: { workspaceId: resolvedWorkspaceId },
      create: {
        workspaceId: resolvedWorkspaceId,
        stripeCustomerId: customerId ?? null,
        stripeSubscriptionId: subscriptionId ?? null,
        plan,
        status,
        ...(currentPeriodStart ? { currentPeriodStart } : {}),
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
        ...(graceEndsAt !== undefined ? { graceEndsAt } : {}),
        ...(eventCreatedAt !== undefined ? { lastBillingEventCreatedAt: eventCreatedAt } : {}),
      },
      update: {
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
        plan,
        status,
        ...(currentPeriodStart ? { currentPeriodStart } : {}),
        ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
        ...(graceEndsAt !== undefined ? { graceEndsAt } : {}),
        ...(eventCreatedAt !== undefined ? { lastBillingEventCreatedAt: eventCreatedAt } : {}),
      },
    });
  });
}
