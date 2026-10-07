import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { getEntitlements } from "@/lib/usageLedger";
import { getChatEntitlement } from "@/lib/chatQuota";
import { getPlanCatalog, hasLiveSubscription } from "@/lib/billing";
import { planLabel, statusLabel } from "@/lib/plans";
import { hostedAiEnabled } from "@/lib/deploymentConfig";
import { accessFromSubscription } from "@/lib/workspaceAccess";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { openBillingPortal, startCheckout } from "./actions";
import { BillingActionForm } from "./BillingActionForm";
import { CheckoutRefresh } from "./CheckoutRefresh";

// Plan, usage and subscription status change with Stripe webhooks; never cache this page.
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  "billing-not-configured": "Billing is not configured on this server yet.",
  "managed-disabled": "Billing is not available on this deployment.",
  "owner-only": "Only the workspace owner can manage billing.",
};

function formatHours(seconds: number): string {
  const hours = seconds / 3_600;
  return hours >= 10 ? Math.round(hours).toString() : (Math.round(hours * 10) / 10).toString();
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ error?: string; checkout?: string }> }) {
  const session = await requireSession();
  const managedHosting = managedHostingEnabled();
  const hostedAi = hostedAiEnabled();
  const params = await searchParams;
  if (!managedHosting) {
    return (
      <div className="container">
        <Link href="/meetings" className="back-link">← Meetings</Link>
        <div className="page-header"><h1>Plan</h1></div>
        <p className="muted-copy">Billing is available only on the project-operated service.</p>
      </div>
    );
  }
  const [entitlements, chat, subscription, catalog] = await Promise.all([
    getEntitlements(session.workspaceId),
    getChatEntitlement(session.workspaceId),
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
  const cancelsDate = live ? formatDate(subscription?.cancelsAt?.toISOString()) : null;
  const access = accessFromSubscription(subscription);

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">← Meetings</Link>
      <div className="page-header">
        <h1>Plan</h1>
      </div>
      <p className="muted-copy">Recording and notes on your device are always free, with your own provider keys. A subscription adds cloud sync and team sync.</p>

      {params.error && ERROR_MESSAGES[params.error] && <p className="error-text" role="alert">{ERROR_MESSAGES[params.error]}</p>}
      {params.checkout === "success" && (
        <p className={live ? "success-text" : "muted-copy"} role="status">
          {entitlements.canSync ? `Your ${planLabel(entitlements.plan)} plan is active. Your desktop app syncs within a minute.` : live ? `Your ${planLabel(entitlements.plan)} subscription needs attention below before sync can run.` : "Payment received. Activating your plan — this usually takes a few seconds."}
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
        {cancelsDate && (
          <p className="muted-copy" role="status">
            Your subscription is cancelled and ends on {cancelsDate}. You keep full access until then.
            {isOwner ? " Use Manage billing to resume it." : ""}
          </p>
        )}

        <p className="muted-copy">
          {entitlements.canSync
            ? "Cloud sync is on for this workspace."
            : isOwner
              ? "Cloud sync is off. Your notes stay on your device. Choose a plan below to sync them."
              : "Cloud sync is off. Your notes stay on your device. Ask a workspace owner to choose a plan."}
        </p>

        {hostedAi && (
          <>
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
              <div style={{ width: `${usedPercent}%`, height: "100%", background: entitlements.meetingWarning === "none" ? "var(--color-accent)" : "var(--color-danger)" }} />
            </div>
          </div>
        ) : (
          <p className="muted-copy">Meetings are processed on your device with your own provider keys.</p>
        )}

        {entitlements.limit > 0 && (
          <p className="muted-copy">
            {formatHours(entitlements.audio.usedSeconds)} of {formatHours(entitlements.audio.limitSeconds)} meeting hours used
            {entitlements.isTrial ? " in your free trial" : ""}
          </p>
        )}

        {chat.limit > 0 && (
          <p className="muted-copy">{chat.used} of {chat.limit} Ask-your-notes questions used</p>
        )}

        {entitlements.warning === "exhausted" && (
          <p className="error-text" role="alert">
            {entitlements.audio.warning === "exhausted"
              ? entitlements.isTrial ? "You have used all of your free trial meeting hours." : "You have used all meeting hours in this billing period."
              : entitlements.isTrial ? "You have used all of your free trial meetings." : "You have used every meeting in this billing period."}{" "}
            {isOwner ? "Choose a plan below to keep processing meetings." : "Ask the workspace owner to upgrade the plan."}
          </p>
        )}
        {entitlements.warning === "low" && (
          <p className="muted-copy" role="status">
            {entitlements.audio.warning === "low"
              ? `Only ${formatHours(entitlements.audio.remainingSeconds)} meeting hours left`
              : `Only ${entitlements.remaining} ${entitlements.remaining === 1 ? "meeting" : "meetings"} left`}{entitlements.isTrial ? " in your free trial" : " this period"}.
            {isOwner ? " Upgrade to avoid interruptions." : ""}
          </p>
        )}
          </>
        )}
        {entitlements.inPaymentGrace && (
          <p className="error-text" role="alert">
            Your last payment failed. Sync continues until {graceDate ?? "the grace period ends"}; update your payment method to keep your plan.
          </p>
        )}
        {(entitlements.status === "past_due" && !entitlements.inPaymentGrace) || entitlements.status === "unpaid" ? (
          <p className="error-text" role="alert">Sync is paused because payment could not be collected. Update your payment method to resume.</p>
        ) : null}
        {cancelsDate && (
          <p className="muted-copy">
            Until then everything works as usual. After that your notes stay in your account, read-only, and you can export them
            {isOwner ? <> any time from <Link href="/account">Account</Link></> : " any time"}. Notes on your computer are never affected.
          </p>
        )}
        {access.lapsed && (
          <div className="callout" role="status">
            <p><strong>Your notes are safe.</strong> Your plan has ended, so this library is read-only.</p>
            <ul>
              <li>You can still read, search, export and delete your notes, and download them to the desktop app.</li>
              <li>Notes made on your computer stay on your computer and upload when a plan is active again.</li>
              <li>Editing, sharing, integrations, inviting people and uploading new notes need a plan.</li>
              <li>We do not delete notes because a plan ended.</li>
            </ul>
            {isOwner && <p><Link className="button button-secondary button-small" href="/account/export">Export all notes</Link></p>}
          </div>
        )}
        {entitlements.status === "canceled" && <p className="muted-copy">Your subscription has ended.</p>}
        {(entitlements.status === "paused" || entitlements.status === "incomplete") && (
          <p className="error-text" role="alert">
            {entitlements.status === "paused" ? "Your subscription is paused, so cloud sync is off." : "Your payment is not complete, so cloud sync is not on yet."}{isOwner ? " Use Manage billing to resolve it." : " Ask a workspace owner to resolve it."}
          </p>
        )}

        <p className="muted-copy">Your provider keys never leave your device.</p>
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
                <p>{offer.id === "hosted_pro" ? "Cloud sync of your notes across your devices." : "Cloud sync for a shared team workspace."}</p>
                <ul>
                  <li>{offer.id === "hosted_pro" ? "Sync finished notes to every device you sign in on" : "Everything in Pro, for every member of the workspace"}</li>
                  <li>{offer.id === "hosted_pro" ? "Searchable library of your notes on the web" : "Invite teammates to one shared library"}</li>
                  <li>{offer.id === "hosted_pro" ? "Your own provider keys, always" : "Activity log and retention controls for owners"}</li>
                  <li>Stripe-managed invoices and cancellation</li>
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
