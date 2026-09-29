import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/apiErrors";
import { applyStripeEvent, verifyStripeSignature } from "@/lib/billing";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { captureServerError } from "@/lib/observability";

const MAX_STRIPE_WEBHOOK_BYTES = 1_048_576;
type BoundedPayload = { ok: true; payload: string } | { ok: false; status: 400 | 413; error: string };

async function readBoundedPayload(request: Request): Promise<BoundedPayload> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_STRIPE_WEBHOOK_BYTES) {
    return { ok: false, status: 413, error: "webhook payload too large" };
  }
  if (!request.body) return { ok: true, payload: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STRIPE_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "webhook payload too large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, payload: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400, error: "invalid payload encoding" };
  }
}

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (!managedHostingEnabled()) return NextResponse.json({ error: "managed hosting is disabled", requestId }, { status: 404, headers: { "x-request-id": requestId } });
  const body = await readBoundedPayload(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error, requestId }, { status: body.status, headers: { "x-request-id": requestId } });
  }
  const payload = body.payload;
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
