"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { createCheckoutSession, createPortalSession } from "@/lib/billing";
import { managedHostingEnabled } from "@/lib/managedAuth";

function appUrl(): string {
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function startCheckout(formData: FormData): Promise<void> {
  if (!managedHostingEnabled()) redirect("/billing?error=managed-disabled");
  const session = await requireSession();
  if (session.role !== "owner") redirect("/billing?error=owner-only");
  const plan = String(formData.get("plan") ?? "");
  const priceId = plan === "hosted_pro" ? process.env.STRIPE_PRICE_HOSTED_PRO : plan === "hosted_team" ? process.env.STRIPE_PRICE_HOSTED_TEAM : undefined;
  if (!priceId) redirect("/billing?error=billing-not-configured");
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
  if (!user) redirect("/login");
  const url = await createCheckoutSession(session.workspaceId, user.email, priceId, `${appUrl()}/billing?checkout=success`, `${appUrl()}/billing?checkout=cancelled`);
  redirect(url);
}

export async function openBillingPortal(): Promise<void> {
  if (!managedHostingEnabled()) redirect("/billing?error=managed-disabled");
  const session = await requireSession();
  if (session.role !== "owner") redirect("/billing?error=owner-only");
  const url = await createPortalSession(session.workspaceId, `${appUrl()}/billing`);
  redirect(url);
}
