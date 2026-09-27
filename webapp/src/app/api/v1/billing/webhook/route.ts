import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { applyStripeEvent, verifyStripeSignature } from "@/lib/billing";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { captureServerError } from "@/lib/observability";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  const payload = await request.text();
  if (!verifyStripeSignature(payload, request.headers.get("stripe-signature"))) {
    return NextResponse.json({ error: "invalid signature", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  try {
    await applyStripeEvent(JSON.parse(payload));
    // Plan/usage changed: make the billing page show it on the next request.
    try {
      revalidatePath("/billing");
    } catch {
      // Not running inside a Next.js request context (e.g. unit tests); the page is dynamic anyway.
    }
    return NextResponse.json({ received: true }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    console.error("Stripe webhook processing failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Billing is a critical path: a failed webhook means a paying customer's
    // state did not change. Capture with the Stripe event id when present.
    captureServerError(error, { requestId, path: "stripe-webhook" });
    return NextResponse.json({ error: "webhook processing failed", requestId }, { status: 500, headers: { "x-request-id": requestId } });
  }
}
