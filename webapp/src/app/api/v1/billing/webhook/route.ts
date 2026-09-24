import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { applyStripeEvent, verifyStripeSignature } from "@/lib/billing";
import { managedHostingEnabled } from "@/lib/managedAuth";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  const payload = await request.text();
  if (!verifyStripeSignature(payload, request.headers.get("stripe-signature"))) {
    return NextResponse.json({ error: "invalid signature", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  try {
    await applyStripeEvent(JSON.parse(payload));
    return NextResponse.json({ received: true }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    console.error("Stripe webhook processing failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "webhook processing failed", requestId }, { status: 500, headers: { "x-request-id": requestId } });
  }
}
