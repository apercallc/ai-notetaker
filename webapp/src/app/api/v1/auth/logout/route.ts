import { NextResponse } from "next/server";
import { apiErrorResponse, requestIdFrom } from "@/lib/apiErrors";
import { revokeApiTokenBySecret } from "@/lib/apiTokens";

/**
 * Ends a desktop/extension sign-in on the server. The client calls this when the user signs
 * out, so a copied token stops working immediately instead of at its natural expiry.
 * Always answers 204 for a well-formed request: it must not reveal whether a token existed.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const authorization = request.headers.get("authorization") ?? "";
  const secret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!secret) return NextResponse.json({ error: "managed session required", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  try {
    await revokeApiTokenBySecret(secret);
    return new NextResponse(null, { status: 204, headers: { "x-request-id": requestId } });
  } catch (error) {
    return apiErrorResponse(error, { requestId });
  }
}
