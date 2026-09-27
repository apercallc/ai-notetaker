import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { getEntitlements } from "@/lib/usageLedger";
import { getPlanCatalog, hasLiveSubscription } from "@/lib/billing";
import { planLabel, statusLabel } from "@/lib/plans";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { openBillingPortal, startCheckout } from "./actions";
import { BillingActionForm } from "./BillingActionForm";
import { CheckoutRefresh } from "./CheckoutRefresh";

// Plan, usage and subscription status change with Stripe webhooks; never cache this page.
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  "billing-not-configured": "Hosted billing is not configured on this server yet.",
  "managed-disabled": "Hosted AI billing is disabled on this self-hosted instance.",
  "owner-only": "Only the workspace owner can manage billing.",
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ error?: string; checkout?: string }> }) {
  const session = await requireSession();
  const managedHosting = managedHostingEnabled();
  const params = await searchParams;
  if (!managedHosting) {
    return (
      <div className="container">
        <Link href="/meetings" className="back-link">← Meetings</Link>
        <div className="page-header"><h1>Hosted AI</h1></div>
        <p className="muted-copy">Hosted AI billing is available only on the project-operated managed service. This self-hosted instance remains free local BYOK history storage.</p>
      </div>
    );
  }
  const [entitlements, subscription, catalog] = await Promise.all([
    getEntitlements(session.workspaceId),
    prisma.workspaceSubscription.findUnique({ where: { workspaceId: session.workspaceId } }),
    getPlanCatalog(),
  ]);
  const isOwner = session.role === "owner";
  const hasStripeCustomer = Boolean(subscription?.stripeCustomerId);
  const live = hasLiveSubscription(subscription);
  const awaitingActivation = params.checkout === "success" && !live;
  const usedPercent = entitlements.limit > 0 ? Math.min(100, Math.round((entitlements.used / entitlements.limit) * 100)) : 0;
  const resetDate = formatDate(entitlements.period.end);
  const graceDate = formatDate(entitlements.graceEndsAt);

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">← Meetings</Link>
      <div className="page-header">
        <h1>Hosted AI</h1>
      </div>
      <p className="muted-copy">Use the free local mode with your own provider keys, or let the hosted service process meetings for you.</p>

      {params.error && ERROR_MESSAGES[params.error] && <p className="error-text" role="alert">{ERROR_MESSAGES[params.error]}</p>}
      {params.checkout === "success" && (
        <p className={live ? "success-text" : "muted-copy"} role="status">
          {live ? `Your ${planLabel(entitlements.plan)} plan is active.` : "Payment received. Activating your plan — this usually takes a few seconds."}
        </p>
      )}
      {params.checkout === "cancelled" && <p className="muted-copy" role="status">Checkout was cancelled; your current plan is unchanged.</p>}
      <CheckoutRefresh waiting={awaitingActivation} />

      <section className="billing-status" aria-labelledby="current-plan">
        <h2 id="current-plan">Current plan</h2>
        <p>
          <strong>{planLabel(entitlements.plan)}</strong>
          {entitlements.plan !== "local" && <> · {statusLabel(entitlements.status)}</>}
        </p>

        {entitlements.limit > 0 ? (
          <div>
            <p>
              {entitlements.used.toLocaleString("en-US")} of {entitlements.limit.toLocaleString("en-US")} meetings used
              {entitlements.isTrial ? " in your free trial" : resetDate ? ` · resets ${resetDate}` : " this month"}
            </p>
            <div
              role="progressbar"
              aria-label="Meetings used"
              aria-valuemin={0}
              aria-valuemax={entitlements.limit}
              aria-valuenow={Math.min(entitlements.used, entitlements.limit)}
              style={{ height: 8, borderRadius: 4, background: "var(--color-border)", overflow: "hidden", maxWidth: 420 }}
            >
              <div style={{ width: `${usedPercent}%`, height: "100%", background: entitlements.warning === "none" ? "var(--color-accent)" : "var(--color-danger)" }} />
            </div>
          </div>
        ) : (
          <p className="muted-copy">Meetings are processed with your own provider keys. Choose a hosted plan below to have the service transcribe and summarize for you.</p>
        )}

        {entitlements.warning === "exhausted" && (
          <p className="error-text" role="alert">
            {entitlements.isTrial ? "You have used all of your free trial meetings." : "You have used every meeting in this billing period."}{" "}
            {isOwner ? "Choose a plan below to keep processing meetings." : "Ask the workspace owner to upgrade the plan."}
          </p>
        )}
        {entitlements.warning === "low" && (
          <p className="muted-copy" role="status">
            Only {entitlements.remaining} {entitlements.remaining === 1 ? "meeting" : "meetings"} left{entitlements.isTrial ? " in your free trial" : " this period"}.
            {isOwner ? " Upgrade to avoid interruptions." : ""}
          </p>
        )}
        {entitlements.inPaymentGrace && (
          <p className="error-text" role="alert">
            Your last payment failed. Processing continues until {graceDate ?? "the grace period ends"}; update your payment method to keep your plan.
          </p>
        )}
        {(entitlements.status === "past_due" && !entitlements.inPaymentGrace) || entitlements.status === "unpaid" ? (
          <p className="error-text" role="alert">Processing is paused because payment could not be collected. Update your payment method to resume.</p>
        ) : null}
        {entitlements.status === "canceled" && <p className="muted-copy">Your subscription has ended.</p>}

        <p className="muted-copy">Hosted processing keeps provider credentials on the service and never puts them in the extension.</p>
        {isOwner && hasStripeCustomer && <BillingActionForm action={openBillingPortal} label="Manage billing" secondary />}
      </section>

      {isOwner ? (
        <div className="billing-plans">
          {catalog.map((offer) => {
            const isCurrent = entitlements.plan === offer.id && live;
            return (
              <section className="billing-card" key={offer.id} aria-current={isCurrent ? "true" : undefined}>
                <h2>{offer.name}{isCurrent && <> <small className="muted-copy">(current plan)</small></>}</h2>
                <p><strong>{offer.priceLabel ?? "Price shown at checkout"}</strong></p>
                <p>{offer.id === "hosted_pro" ? "For individual users who want hosted transcription and summaries." : "For shared workspaces with higher volume and team history."}</p>
                <ul>
                  <li>Up to {offer.meetingLimit.toLocaleString("en-US")} meetings per month</li>
                  <li>{offer.id === "hosted_pro" ? "Encrypted upload and durable job retries" : "Workspace members and shared history"}</li>
                  <li>{offer.id === "hosted_pro" ? "Searchable workspace history" : "Stripe-managed invoices and cancellation"}</li>
                </ul>
                {isCurrent ? (
                  <button type="button" disabled>Current plan</button>
                ) : live ? (
                  <BillingActionForm action={openBillingPortal} label={`Switch to ${offer.name}`} pendingLabel="Opening billing portal…" />
                ) : offer.priceId ? (
                  <BillingActionForm action={startCheckout} label={`Choose ${offer.id === "hosted_pro" ? "Pro" : "Team"}`} fields={{ plan: offer.id }} />
                ) : (
                  <button type="button" disabled>Not available yet</button>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="muted-copy">Only the workspace owner can change the plan.</p>
      )}
    </div>
  );
}
