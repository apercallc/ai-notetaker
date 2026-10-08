import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { captureWarning } from "./observability";
import { ValidationError } from "./meetings";
import { DeploymentConfigError, getAppUrl } from "./deploymentConfig";
import { PLAN_MEETING_LIMITS, planLabel } from "./plans";

const PAYMENT_GRACE_MS = 3 * 24 * 60 * 60 * 1_000;

export class BillingError extends ValidationError {}

/**
 * Raised when checkout is requested for a workspace that already has a live
 * Stripe subscription. Callers send the owner to the billing portal instead
 * of creating a second, double-billed subscription.
 */
export class BillingPortalRequiredError extends BillingError {
  readonly portalRequired = true;
}

/** A fresh checkout claim exists; carries the Stripe session to supersede. */
class CheckoutInProgressError extends BillingError {
  constructor(message: string, readonly sessionId: string | null) {
    super(message);
  }
}

/** Stripe subscription statuses that still represent a subscription the customer can manage. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);
/** Statuses after which a workspace may start a fresh subscription. */
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired", "inactive"]);
const KNOWN_SUBSCRIPTION_STATUSES = new Set([...LIVE_SUBSCRIPTION_STATUSES, ...TERMINAL_SUBSCRIPTION_STATUSES, "incomplete"]);

export function hasLiveSubscription(subscription: { plan: string; status: string; stripeSubscriptionId: string | null } | null | undefined): boolean {
  return Boolean(subscription?.stripeSubscriptionId) && subscription?.plan !== "hosted_trial" && LIVE_SUBSCRIPTION_STATUSES.has(subscription?.status ?? "");
}

function stripeUrl(path: string): string {
  return `https://api.stripe.com/v1/${path}`;
}

function stripeHeaders(): HeadersInit {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError("Stripe billing is not configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
}

function priceFor(priceId: string): string {
  const allowed = [
    process.env.STRIPE_PRICE_HOSTED_PRO,
    process.env.STRIPE_PRICE_HOSTED_TEAM,
    process.env.STRIPE_PRICE_HOSTED_PRO_YEARLY,
    process.env.STRIPE_PRICE_HOSTED_TEAM_YEARLY,
  ].filter((value): value is string => Boolean(value));
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
  let configuredAppUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.MANAGED_HOSTING === "true") {
    try {
      configuredAppUrl = getAppUrl();
    } catch (error) {
      if (error instanceof DeploymentConfigError) throw new BillingError("Billing is unavailable: APP_URL is not configured on this server");
      throw error;
    }
  }
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

async function stripePost(path: string, form: URLSearchParams, idempotencyKey?: string): Promise<Record<string, unknown>> {
  // With an Idempotency-Key, an ambiguous failure (timeout, network error, 5xx)
  // is retried once with the same key: if Stripe did create the session, the
  // retry returns it instead of leaving an orphan session that could still be paid.
  const attempts = idempotencyKey ? 2 : 1;
  for (let attempt = 1; ; attempt += 1) {
    const headers = { ...(stripeHeaders() as Record<string, string>), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) };
    // A hung Stripe call would hold the checkout claim (an hour-long mutex) and the user's request.
    const response = await fetch(stripeUrl(path), { method: "POST", headers, body: form, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!response || response.status >= 500) {
      if (attempt < attempts) continue;
      throw new BillingError(response ? "Billing is temporarily unavailable. Try again in a moment." : "Stripe did not respond. Try again in a moment.");
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // Stripe's own text for a misconfiguration ("No such price") is not for end users.
      if (response.status === 401 || response.status === 403) throw new BillingError("Billing is temporarily unavailable. Try again in a moment.");
      throw new BillingError(typeof body.error === "object" && body.error && "message" in body.error ? String(body.error.message) : "Stripe request failed");
    }
    return body;
  }
}

export async function createCheckoutSession(workspaceId: string, email: string, priceId: string, successUrl: string, cancelUrl: string) {
  const price = priceFor(priceId);
  // Validate the redirect targets before claiming anything: a rejected
  // request must not leave a checkout claim behind (it would block
  // the user's next, valid attempt for an hour) nor consume the mutex.
  const success = validateBillingRedirect(successUrl);
  const cancel = validateBillingRedirect(cancelUrl);
  // Claim a checkout slot before talking to Stripe. The read-then-create
  // pattern let two concurrent owner requests both pass hasLiveSubscription
  // and create two live subscriptions (double billing, Stripe support needed
  // to untangle). The claim timestamp acts as a mutex: a fresh claim
  // blocks a second session, a stale one (abandoned checkout over an hour
  // ago) is reclaimable, and any live status still routes to the portal.
  try {
    await claimCheckoutSlot(workspaceId);
  } catch (error) {
    if (!(error instanceof CheckoutInProgressError)) throw error;
    // The owner abandoned (or wants to redo) an earlier checkout. Expire that
    // session so it can never be paid, release the claim, and start fresh
    // instead of locking them out for an hour.
    if (!(await supersedeOpenCheckout(workspaceId, error.sessionId))) throw error;
    await claimCheckoutSlot(workspaceId);
  }
  try {
    const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: success,
      cancel_url: cancel,
      allow_promotion_codes: "true",
      "metadata[workspaceId]": workspaceId,
      "subscription_data[metadata][workspaceId]": workspaceId,
    });
    if (subscription?.stripeCustomerId) form.set("customer", subscription.stripeCustomerId);
    else form.set("customer_email", email);
    // The claim timestamp scopes the key to this attempt; a superseded or
    // released claim gets a fresh timestamp and therefore a fresh key.
    const claimedAt = subscription?.checkoutClaimedAt?.getTime() ?? Date.now();
    const body = await stripePost("checkout/sessions", form, `checkout:${workspaceId}:${claimedAt}`);
    if (typeof body.url !== "string") throw new BillingError("Stripe returned no checkout URL");
    if (typeof body.id === "string") {
      await prisma.workspaceSubscription.updateMany({ where: { workspaceId }, data: { checkoutSessionId: body.id } });
    }
    return body.url;
  } catch (error) {
    // Never leave the mutex claimed when no checkout session exists.
    await prisma.workspaceSubscription
      .updateMany({ where: { workspaceId }, data: { checkoutClaimedAt: null, checkoutSessionId: null } })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Expires the workspace's pending Checkout Session (if it is still open) and
 * releases the claim. Returns false when the session cannot be confirmed
 * closed, leaving the claim in place so double billing stays impossible.
 */
async function supersedeOpenCheckout(workspaceId: string, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const path = `checkout/sessions/${encodeURIComponent(sessionId)}`;
  const current = await fetch(stripeUrl(path), { headers: stripeHeaders(), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!current?.ok) return false;
  const session = (await current.json().catch(() => ({}))) as { status?: string };
  if (session.status === "open") {
    const expired = await fetch(stripeUrl(`${path}/expire`), { method: "POST", headers: stripeHeaders(), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!expired?.ok) return false;
  } else if (session.status === "complete") {
    // Paid: the webhook will attach the subscription; do not start another.
    return false;
  }
  await prisma.workspaceSubscription.updateMany({ where: { workspaceId }, data: { checkoutClaimedAt: null, checkoutSessionId: null } });
  return true;
}

/** How long an uncompleted checkout session blocks a new one for the workspace. */
const CHECKOUT_PENDING_MS = 60 * 60 * 1_000;

/**
 * The claim is a timestamp beside the subscription, not a status. Overwriting
 * `status` (the old `checkout_pending`) erased a trial's remaining meetings
 * and made a canceled workspace look "replaced" when its new subscription
 * arrived, so a paying customer never got access back.
 */
async function claimCheckoutSlot(workspaceId: string): Promise<void> {
  const existing = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  if (hasLiveSubscription(existing)) {
    throw new BillingPortalRequiredError("This workspace already has a subscription. Use Manage billing to change or cancel your plan.");
  }
  if (!existing) {
    try {
      await prisma.workspaceSubscription.create({ data: { workspaceId, checkoutClaimedAt: new Date() } });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      // Another request created the row first; fall through and let the
      // conditional claim below decide.
    }
  }
  const claimed = await prisma.workspaceSubscription.updateMany({
    where: {
      workspaceId,
      // The trial row is `trialing` with no Stripe subscription; only a real,
      // live subscription blocks checkout.
      OR: [{ stripeSubscriptionId: null }, { plan: "hosted_trial" }, { status: { notIn: [...LIVE_SUBSCRIPTION_STATUSES] } }],
      // A claim from a checkout the user abandoned long ago is stale.
      AND: [{ OR: [{ checkoutClaimedAt: null }, { checkoutClaimedAt: { lt: new Date(Date.now() - CHECKOUT_PENDING_MS) } }] }],
    },
    data: { checkoutClaimedAt: new Date() },
  });
  if (claimed.count === 1) return;
  const blocked = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  if (hasLiveSubscription(blocked)) {
    throw new BillingPortalRequiredError("This workspace already has a subscription. Use Manage billing to change or cancel your plan.");
  }
  throw new CheckoutInProgressError(
    "A checkout session was just started for this workspace. Complete it or try again in a few minutes.",
    blocked?.checkoutSessionId ?? null,
  );
}

/**
 * Cancels a workspace's live Stripe subscription immediately. Used before the
 * workspace is deleted so the customer is never billed for data that no longer
 * exists. A subscription Stripe already reports gone counts as cancelled.
 * Throws BillingError on any other failure so the caller can abort.
 */
export async function cancelWorkspaceSubscription(workspaceId: string): Promise<void> {
  const subscription = await prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
  // A Checkout the owner has open right now could still complete after the
  // workspace is gone, creating a subscription nothing can ever cancel.
  if (subscription?.checkoutClaimedAt && subscription.checkoutClaimedAt.getTime() > Date.now() - CHECKOUT_PENDING_MS) {
    throw new BillingError("A checkout is in progress for this workspace. Finish or abandon it, wait an hour, then delete the workspace.");
  }
  if (!subscription?.stripeSubscriptionId) return;
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) return;
  const response = await fetch(stripeUrl(`subscriptions/${encodeURIComponent(subscription.stripeSubscriptionId)}`), {
    method: "DELETE",
    headers: stripeHeaders(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) throw new BillingError("Stripe could not be reached to cancel the subscription");
  if (response.ok || response.status === 404) return;
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  // Already cancelled on Stripe's side is the outcome we want.
  if (body.error?.code === "resource_missing") return;
  throw new BillingError(body.error?.message ? `Stripe: ${body.error.message}` : "Stripe could not cancel the subscription");
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
  // Stripe sends one v1 signature per active webhook secret while a secret is
  // being rolled, so accept a match against any of them.
  const parts = signature.split(",").map((part) => part.split("=", 2) as [string, string | undefined]);
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const candidates = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value as string);
  const timestampSeconds = Number(timestamp);
  if (!timestamp || candidates.length === 0 || !Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
  const expectedBuffer = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return candidates.some((candidate) => {
    const actualBuffer = Buffer.from(candidate, "hex");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
}

// ---------------------------------------------------------------------------
// Plan catalog: prices shown on the billing page.
// ---------------------------------------------------------------------------

export type PurchasablePlan = "hosted_pro" | "hosted_team";

export type BillingInterval = "month" | "year";

/** Stripe price id for a plan and billing interval; yearly prices are optional. */
export function priceIdFor(plan: PurchasablePlan, interval: BillingInterval = "month"): string | undefined {
  if (plan === "hosted_pro") return (interval === "year" ? process.env.STRIPE_PRICE_HOSTED_PRO_YEARLY : process.env.STRIPE_PRICE_HOSTED_PRO) || undefined;
  return (interval === "year" ? process.env.STRIPE_PRICE_HOSTED_TEAM_YEARLY : process.env.STRIPE_PRICE_HOSTED_TEAM) || undefined;
}

export interface PlanOffer {
  id: PurchasablePlan;
  name: string;
  priceId: string | null;
  meetingLimit: number;
  /** Formatted price such as "$19.00 / month", or null when it cannot be resolved. */
  priceLabel: string | null;
  /** Annual billing, present only when a yearly Stripe price is configured. */
  yearly: { priceId: string; priceLabel: string | null; monthsFree: number | null } | null;
}

const PRICE_CACHE_TTL_MS = 10 * 60 * 1_000;
const priceCache = new Map<string, { expires: number; label: string | null }>();

const ZERO_DECIMAL_CURRENCIES = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function formatStripePrice(unitAmount: number, currency: string, interval: string | null): string {
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
  const amount = zeroDecimal ? unitAmount : unitAmount / 100;
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: zeroDecimal || Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch {
    formatted = `${amount} ${currency.toUpperCase()}`;
  }
  return interval ? `${formatted} / ${interval}` : formatted;
}

async function lookupPriceLabel(priceId: string, configuredLabel: string | undefined): Promise<string | null> {
  const cached = priceCache.get(priceId);
  if (cached && cached.expires > Date.now()) return cached.label;
  let label: string | null = configuredLabel?.trim() || null;
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    try {
      const response = await fetch(stripeUrl(`prices/${encodeURIComponent(priceId)}`), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = (await response.json()) as { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown } | null };
        if (typeof body.unit_amount === "number" && typeof body.currency === "string") {
          label = formatStripePrice(body.unit_amount, body.currency, typeof body.recurring?.interval === "string" ? body.recurring.interval : null);
        }
      }
    } catch {
      // A slow or failing Stripe lookup must not break the billing page; fall back to the configured label.
    }
  }
  // Cache failures briefly so a Stripe outage does not add a 5s stall to every page load.
  priceCache.set(priceId, { expires: Date.now() + (label ? PRICE_CACHE_TTL_MS : 30_000), label });
  return label;
}

export function clearPriceCache(): void {
  priceCache.clear();
}

/** Whole months saved by paying yearly, derived from the two formatted labels ("$12 / month", "$120 / year"). */
export function monthsFree(monthly: string | null, yearly: string | null): number | null {
  const amount = (label: string | null) => {
    const match = label?.replace(/,/gu, "").match(/\d+(?:\.\d+)?/u);
    return match ? Number(match[0]) : null;
  };
  const m = amount(monthly);
  const y = amount(yearly);
  if (!m || !y || m <= 0) return null;
  const free = Math.floor(12 - y / m + 1e-9);
  return free >= 1 ? free : null;
}

/** Purchasable plans with their prices. Prices come from Stripe, with HOSTED_*_PRICE_LABEL as a fallback. */
export async function getPlanCatalog(): Promise<PlanOffer[]> {
  const entries: { id: PurchasablePlan; label: string | undefined; yearlyLabel: string | undefined }[] = [
    { id: "hosted_pro", label: process.env.HOSTED_PRO_PRICE_LABEL, yearlyLabel: process.env.HOSTED_PRO_YEARLY_PRICE_LABEL },
    { id: "hosted_team", label: process.env.HOSTED_TEAM_PRICE_LABEL, yearlyLabel: process.env.HOSTED_TEAM_YEARLY_PRICE_LABEL },
  ];
  return Promise.all(entries.map(async ({ id, label, yearlyLabel }) => {
    const priceId = priceIdFor(id);
    const yearlyId = priceIdFor(id, "year");
    const priceLabel = priceId ? await lookupPriceLabel(priceId, label) : null;
    const yearlyPriceLabel = yearlyId ? await lookupPriceLabel(yearlyId, yearlyLabel) : null;
    return {
      id,
      name: planLabel(id),
      priceId: priceId ?? null,
      meetingLimit: PLAN_MEETING_LIMITS[id],
      priceLabel,
      yearly: yearlyId ? { priceId: yearlyId, priceLabel: yearlyPriceLabel, monthsFree: monthsFree(priceLabel, yearlyPriceLabel) } : null,
    };
  }));
}

// ---------------------------------------------------------------------------
// Webhook event application.
//
// Subscription status and plan are derived ONLY from customer.subscription.*
// events, which carry the authoritative Stripe subscription object. Other
// events never write status/plan:
//   - invoice.payment_failed  -> past_due (a payment problem, grace starts)
//   - checkout.session.completed -> links customer/subscription ids only
//   - invoice.paid and everything else -> recorded, otherwise ignored
// Stripe follows a successful payment with customer.subscription.updated, so
// activation is never inferred from an invoice or checkout event.
// ---------------------------------------------------------------------------

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asSeconds(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1_000) : undefined;
}

function invoiceSubscriptionId(object: Record<string, unknown>): string | undefined {
  const direct = asString(object.subscription);
  if (direct) return direct;
  // Newer Stripe API versions nest the subscription under parent.subscription_details.
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return asString(parent?.subscription_details?.subscription);
}

function priceIdOf(object: Record<string, unknown>): string | undefined {
  const items = object.items as { data?: unknown[] } | undefined;
  const first = Array.isArray(items?.data) && typeof items.data[0] === "object" && items.data[0] !== null ? items.data[0] as { price?: { id?: unknown } } : undefined;
  return asString(first?.price?.id);
}

function periodOf(object: Record<string, unknown>): { start?: Date; end?: Date } {
  const items = object.items as { data?: unknown[] } | undefined;
  const first = Array.isArray(items?.data) && typeof items.data[0] === "object" && items.data[0] !== null ? items.data[0] as Record<string, unknown> : undefined;
  // Newer API versions moved the period from the subscription onto its items.
  return {
    start: asSeconds(object.current_period_start) ?? asSeconds(first?.current_period_start),
    end: asSeconds(object.current_period_end) ?? asSeconds(first?.current_period_end),
  };
}

/**
 * When Stripe will end the subscription. Newer API versions report a pending
 * cancellation as `cancel_at` (with `cancel_at_period_end` left false); older
 * ones set `cancel_at_period_end` and expect the period end.
 */
function cancelsAtOf(object: Record<string, unknown>, periodEnd: Date | undefined): Date | null {
  const cancelAt = asSeconds(object.cancel_at);
  if (cancelAt) return cancelAt;
  return object.cancel_at_period_end === true && periodEnd ? periodEnd : null;
}

function planForPrice(priceId: string | undefined): "hosted_pro" | "hosted_team" | undefined {
  if (!priceId) return undefined;
  if (priceId === process.env.STRIPE_PRICE_HOSTED_TEAM || priceId === process.env.STRIPE_PRICE_HOSTED_TEAM_YEARLY) return "hosted_team";
  if (priceId === process.env.STRIPE_PRICE_HOSTED_PRO || priceId === process.env.STRIPE_PRICE_HOSTED_PRO_YEARLY) return "hosted_pro";
  return undefined;
}

export async function applyStripeEvent(event: unknown): Promise<void> {
  if (typeof event !== "object" || event === null) throw new BillingError("invalid Stripe event");
  const value = event as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof value.id !== "string" || typeof value.type !== "string") throw new BillingError("invalid Stripe event envelope");
  const eventId = value.id;
  const eventType = value.type;
  const eventCreatedAt = typeof value.created === "number" && Number.isSafeInteger(value.created) && value.created >= 0 ? value.created : undefined;
  const isSubscriptionEvent = SUBSCRIPTION_EVENTS.has(eventType);
  const isPaymentFailure = eventType === "invoice.payment_failed";
  const isCheckoutCompletion = eventType === "checkout.session.completed";

  await prisma.$transaction(async (tx) => {
    try {
      await tx.billingEvent.create({ data: { id: eventId, type: eventType, eventCreatedAt } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return;
      throw error;
    }
    if (eventType === "checkout.session.expired") {
      // The customer abandoned checkout. Release the claim now instead of making them wait out the hour.
      const expiredSessionId = asString(value.data?.object?.id);
      if (expiredSessionId) {
        await tx.workspaceSubscription.updateMany({ where: { checkoutSessionId: expiredSessionId }, data: { checkoutClaimedAt: null, checkoutSessionId: null } });
      }
      return;
    }
    if (!isSubscriptionEvent && !isPaymentFailure && !isCheckoutCompletion) return;

    const object = value.data?.object ?? {};
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const metadataWorkspaceId = asString(metadata?.workspaceId);
    const customerId = asString(object.customer);
    const subscriptionId = isSubscriptionEvent ? asString(object.id) : isCheckoutCompletion ? asString(object.subscription) : invoiceSubscriptionId(object);
    if (isCheckoutCompletion && object.mode !== "subscription") return;

    // Tenant resolution. The Stripe customer -> workspace binding is the most
    // stable identity, so it wins over event metadata; an event whose
    // metadata names a different workspace than the bound customer is ignored
    // rather than allowed to move billing across tenants.
    const byCustomer = customerId ? await tx.workspaceSubscription.findFirst({ where: { stripeCustomerId: customerId }, select: { workspaceId: true } }) : null;
    const bySubscription = !byCustomer && subscriptionId ? await tx.workspaceSubscription.findFirst({ where: { stripeSubscriptionId: subscriptionId }, select: { workspaceId: true } }) : null;
    const bound = byCustomer?.workspaceId ?? bySubscription?.workspaceId;
    if (bound && metadataWorkspaceId && bound !== metadataWorkspaceId) {
      console.error("stripe event ignored: workspace metadata conflicts with bound customer", { eventId, eventType });
      return;
    }
    const workspaceId = bound ?? metadataWorkspaceId;
    if (!workspaceId) return;
    if (!(await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }))) return;

    const current = await tx.workspaceSubscription.findUnique({ where: { workspaceId } });

    // A customer or subscription id already owned by another workspace can
    // never be attached here (unique columns); ignore instead of 500-looping.
    if (customerId && !bound) {
      if (await tx.workspaceSubscription.findFirst({ where: { stripeCustomerId: customerId, NOT: { workspaceId } }, select: { id: true } })) return;
    }
    if (subscriptionId && current?.stripeSubscriptionId !== subscriptionId) {
      if (await tx.workspaceSubscription.findFirst({ where: { stripeSubscriptionId: subscriptionId, NOT: { workspaceId } }, select: { id: true } })) return;
    }

    if (isCheckoutCompletion) {
      // Link identifiers so later invoice/subscription events can be routed to
      // this workspace. Status and plan are deliberately not touched.
      await tx.workspaceSubscription.upsert({
        where: { workspaceId },
        create: { workspaceId, stripeCustomerId: customerId ?? null, stripeSubscriptionId: null },
        update: { ...(customerId ? { stripeCustomerId: customerId } : {}) },
      });
      return;
    }

    const stale = eventCreatedAt !== undefined && current?.lastBillingEventCreatedAt != null && eventCreatedAt < current.lastBillingEventCreatedAt;
    if (stale) return;

    if (isPaymentFailure) {
      // Only an existing, live Stripe subscription can go past_due. A failed
      // first invoice (incomplete subscription) or an invoice for a canceled
      // subscription must not resurrect or degrade anything.
      if (!current || !current.stripeSubscriptionId || !["active", "trialing", "past_due"].includes(current.status)) return;
      if (subscriptionId && subscriptionId !== current.stripeSubscriptionId) return;
      await tx.workspaceSubscription.update({
        where: { workspaceId },
        data: {
          status: "past_due",
          // Grace starts at the first failure and is not extended by Stripe's retries.
          graceEndsAt: current.status === "past_due" && current.graceEndsAt ? current.graceEndsAt : new Date(Date.now() + PAYMENT_GRACE_MS),
          ...(eventCreatedAt !== undefined ? { lastBillingEventCreatedAt: eventCreatedAt } : {}),
        },
      });
      return;
    }

    // customer.subscription.*
    if (current?.stripeSubscriptionId && subscriptionId && current.stripeSubscriptionId !== subscriptionId && !TERMINAL_SUBSCRIPTION_STATUSES.has(current.status)) {
      // A late event for an older, replaced subscription must not overwrite the current one.
      return;
    }
    const reportedStatus = eventType === "customer.subscription.deleted" ? "canceled" : asString(object.status);
    if (!reportedStatus || !KNOWN_SUBSCRIPTION_STATUSES.has(reportedStatus)) return;
    if (reportedStatus === "incomplete") {
      // Checkout is still awaiting payment. Keep whatever the workspace has
      // (usually the free trial) until Stripe reports the subscription live.
      await tx.workspaceSubscription.upsert({
        where: { workspaceId },
        create: { workspaceId, stripeCustomerId: customerId ?? null },
        update: { ...(customerId ? { stripeCustomerId: customerId } : {}) },
      });
      return;
    }

    const live = LIVE_SUBSCRIPTION_STATUSES.has(reportedStatus);
    let plan = "local";
    if (live) {
      const priceId = priceIdOf(object);
      const mapped = planForPrice(priceId);
      if (mapped) plan = mapped;
      else if ((current?.plan === "hosted_pro" || current?.plan === "hosted_team") && current.stripeSubscriptionId === subscriptionId) plan = current.plan;
      else {
        // An unmapped price is an operator configuration gap, not a transient
        // failure: retrying the same event can never succeed. Throwing here
        // rolled back the BillingEvent dedupe row, so Stripe retried (and
        // re-failed) forever, disabling the webhook endpoint by timeout and
        // freezing plan changes for EVERY tenant. Record the event, leave
        // billing state untouched, and surface it in the logs instead.
        console.error("stripe subscription event ignored: subscription price is not configured as a hosted plan", {
          eventId,
          eventType,
          workspaceId,
          priceId: priceId ?? "(none)",
        });
        // A customer has paid but no plan was activated: make sure an operator is told, not just the log.
        captureWarning("paid subscription ignored: price is not a configured plan", { eventId, eventType, workspaceId, priceId: priceId ?? "(none)" });
        return;
      }
    }
    // Stripe timestamps have one-second resolution, so a late "updated" can carry the same second as the
    // "deleted" that actually came after it. An event that does not strictly postdate a cancellation must not
    // bring the same subscription back to life.
    if (
      live &&
      eventCreatedAt !== undefined &&
      current?.lastBillingEventCreatedAt != null &&
      eventCreatedAt === current.lastBillingEventCreatedAt &&
      TERMINAL_SUBSCRIPTION_STATUSES.has(current.status) &&
      subscriptionId !== undefined &&
      subscriptionId === current.stripeSubscriptionId
    ) {
      return;
    }
    const { start, end } = periodOf(object);
    const graceEndsAt = reportedStatus === "past_due"
      ? (current?.status === "past_due" && current.graceEndsAt ? current.graceEndsAt : new Date(Date.now() + PAYMENT_GRACE_MS))
      : null;
    const data = {
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      plan,
      status: reportedStatus,
      ...(start ? { currentPeriodStart: start } : {}),
      ...(end ? { currentPeriodEnd: end } : {}),
      graceEndsAt,
      cancelsAt: live ? cancelsAtOf(object, end) : null,
      checkoutClaimedAt: null,
      checkoutSessionId: null,
      ...(eventCreatedAt !== undefined ? { lastBillingEventCreatedAt: eventCreatedAt } : {}),
    };
    await tx.workspaceSubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
  });
}
