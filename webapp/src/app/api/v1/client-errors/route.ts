import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { getManagedSession, managedUnauthorized } from "@/lib/managedAuth";
import { readManagedJson } from "@/lib/managedJobs";
import { recordClientError, clientErrorLimiter } from "@/lib/clientErrors";

/**
 * Hosted-mode extension error reporting. The Chrome extension is the surface
 * users live in, and its service worker cannot run Sentry — so it posts a
 * strictly bounded error record here, authenticated with the same managed
 * session every other /api/v1 route requires. Local BYOK mode never calls
 * this endpoint (the extension only reports while a Hosted AI session is
 * active), preserving the documented no-telemetry boundary for local use.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const session = await getManagedSession(request);
  if (!session) return managedUnauthorized(requestId);
  const limited = clientErrorLimiter.hit(session.userId);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "too many error reports", requestId },
      { status: 429, headers: { "x-request-id": requestId, "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }
  try {
    const body = await readManagedJson(request);
    if (typeof body !== "object" || body === null) return apiErrorResponse(new Error("invalid body"), { requestId, fallbackMessage: "invalid report" });
    const result = recordClientError(session, body as Record<string, unknown>);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, requestId }, { status: 400, headers: { "x-request-id": requestId } });
    }
    return NextResponse.json({ received: true }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId, fallbackMessage: "invalid report" });
  }
}
