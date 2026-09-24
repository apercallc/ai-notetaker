import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { getEntitlements } from "@/lib/usageLedger";
import { openBillingPortal, startCheckout } from "./actions";
import { managedHostingEnabled } from "@/lib/managedAuth";

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
  const [entitlements, subscription] = await Promise.all([
    getEntitlements(session.workspaceId),
    prisma.workspaceSubscription.findUnique({ where: { workspaceId: session.workspaceId } }),
  ]);
  const hasStripeCustomer = Boolean(subscription?.stripeCustomerId);

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">← Meetings</Link>
      <div className="page-header">
        <h1>Hosted AI</h1>
      </div>
      <p className="muted-copy">Use the free local mode with your own provider keys, or let the hosted service process meetings for you.</p>

      {params.error === "billing-not-configured" && <p className="error-text" role="alert">Hosted billing is not configured on this server yet.</p>}
      {params.error === "managed-disabled" && <p className="error-text" role="alert">Hosted AI billing is disabled on this self-hosted instance.</p>}
      {params.error === "owner-only" && <p className="error-text" role="alert">Only the workspace owner can manage billing.</p>}
      {params.checkout === "success" && <p className="success-text" role="status">Checkout started. Your hosted access will activate after Stripe confirms payment.</p>}
      {params.checkout === "cancelled" && <p className="muted-copy" role="status">Checkout was cancelled; your current plan is unchanged.</p>}

      <section className="billing-status" aria-labelledby="current-plan">
        <h2 id="current-plan">Current plan</h2>
        <p><strong>{entitlements.plan}</strong> · {entitlements.used} meetings used this month{entitlements.limit > 0 ? ` of ${entitlements.limit}` : ""}</p>
        <p className="muted-copy">Hosted processing keeps provider credentials on the service and never puts them in the extension.</p>
        {session.role === "owner" && hasStripeCustomer && (
          <form action={openBillingPortal}><button type="submit" className="secondary-button">Manage billing</button></form>
        )}
      </section>

      {session.role === "owner" && (
        <div className="billing-plans">
          <section className="billing-card">
            <h2>Hosted Pro</h2>
            <p>For individual users who want hosted transcription and summaries.</p>
            <ul><li>Up to 1,000 meetings per month</li><li>Encrypted upload and durable job retries</li><li>Searchable workspace history</li></ul>
            <form action={startCheckout}><input type="hidden" name="plan" value="hosted_pro" /><button type="submit">Choose Pro</button></form>
          </section>
          <section className="billing-card">
            <h2>Hosted Team</h2>
            <p>For shared workspaces with higher volume and team history.</p>
            <ul><li>Up to 10,000 meetings per month</li><li>Workspace members and shared history</li><li>Stripe-managed invoices and cancellation</li></ul>
            <form action={startCheckout}><input type="hidden" name="plan" value="hosted_team" /><button type="submit">Choose Team</button></form>
          </section>
        </div>
      )}
    </div>
  );
}
