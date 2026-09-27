"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { BillingError, BillingPortalRequiredError, createCheckoutSession, createPortalSession } from "@/lib/billing";
import { DeploymentConfigError, getAppUrl } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";

/** Returned to the form (via useActionState) instead of throwing, so failures render as a readable message. */
export interface BillingActionState {
  error?: string;
}

const GENERIC_FAILURE = "Something went wrong talking to the billing provider. Please try again in a moment.";

function failure(error: unknown): BillingActionState {
  if (error instanceof BillingError) return { error: error.message };
  if (error instanceof DeploymentConfigError) return { error: "Billing is unavailable: this server is missing its public URL configuration." };
  console.error("billing action failed", { error: error instanceof Error ? error.message : String(error) });
  return { error: GENERIC_FAILURE };
}

async function portalUrlFor(workspaceId: string): Promise<string> {
  return createPortalSession(workspaceId, `${getAppUrl()}/billing`);
}

export async function startCheckout(_previous: BillingActionState, formData: FormData): Promise<BillingActionState> {
  if (!managedHostingEnabled()) return { error: "Hosted AI billing is disabled on this self-hosted instance." };
  const session = await requireSession();
  if (session.role !== "owner") return { error: "Only the workspace owner can manage billing." };
  const plan = String(formData.get("plan") ?? "");
  const priceId = plan === "hosted_pro" ? process.env.STRIPE_PRICE_HOSTED_PRO : plan === "hosted_team" ? process.env.STRIPE_PRICE_HOSTED_TEAM : undefined;
  if (!priceId) return { error: "Hosted billing is not configured on this server yet." };
  let destination: string;
  try {
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    if (!user) return { error: "Your session is no longer valid. Please sign in again." };
    const appUrl = getAppUrl();
    try {
      destination = await createCheckoutSession(session.workspaceId, user.email, priceId, `${appUrl}/billing?checkout=success`, `${appUrl}/billing?checkout=cancelled`);
    } catch (error) {
      if (!(error instanceof BillingPortalRequiredError)) throw error;
      // A live subscription exists: change plans there, never start a second checkout.
      destination = await portalUrlFor(session.workspaceId);
    }
  } catch (error) {
    return failure(error);
  }
  redirect(destination);
}

export async function openBillingPortal(_previous: BillingActionState, _formData?: FormData): Promise<BillingActionState> {
  if (!managedHostingEnabled()) return { error: "Hosted AI billing is disabled on this self-hosted instance." };
  const session = await requireSession();
  if (session.role !== "owner") return { error: "Only the workspace owner can manage billing." };
  let destination: string;
  try {
    destination = await portalUrlFor(session.workspaceId);
  } catch (error) {
    return failure(error);
  }
  redirect(destination);
}
