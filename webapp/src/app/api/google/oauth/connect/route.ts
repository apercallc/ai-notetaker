import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/sessions";
import { createOAuthState, GoogleIntegrationError, sealOAuthState } from "@/lib/googleIntegration";

const OAUTH_STATE_COOKIE = "google_oauth_state";

export async function GET(request: Request) {
  const store = await cookies();
  const session = await getSessionContext(store.get("session")?.value);
  if (!session) return NextResponse.redirect(new URL("/login?next=/account", request.url));
  if (session.user.mustChangePassword) return NextResponse.redirect(new URL("/account?required=1", request.url));
  try {
    const { state, authorizationUrl } = createOAuthState(session.user.id);
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OAUTH_STATE_COOKIE, sealOAuthState(state), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google/oauth",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    const message = error instanceof GoogleIntegrationError ? error.publicMessage : "Google integration is unavailable. Try again later.";
    return NextResponse.redirect(new URL(`/account?googleError=${encodeURIComponent(message)}`, request.url));
  }
}
